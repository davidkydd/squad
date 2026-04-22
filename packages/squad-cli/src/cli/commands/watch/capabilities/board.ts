/**
 * Board capability — project board lifecycle + reconciliation.
 *
 * GitHub: uses `gh project` CLI for Projects v2 board management.
 * ADO: uses platform adapter tags (status:in-progress, status:done, etc.)
 *      as a lightweight board equivalent.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { WatchCapability, WatchContext, PreflightResult, CapabilityResult } from '../types.js';
import { checkPlatformCli } from './platform-preflight.js';

const execFileAsync = promisify(execFile);

/** Status tags used on ADO work items as a board-state equivalent. */
const ADO_STATUS_TAGS = ['status:todo', 'status:in-progress', 'status:done', 'status:blocked'] as const;

export class BoardCapability implements WatchCapability {
  readonly name = 'board';
  readonly description = 'Project board lifecycle (In Progress / Done / Blocked + reconciliation)';
  readonly configShape = 'object' as const;
  readonly requires = ['gh or az'];
  readonly phase = 'post-execute' as const;

  async preflight(context: WatchContext): Promise<PreflightResult> {
    if (context.adapter.type === 'azure-devops') {
      return checkPlatformCli(context);
    }
    // GitHub: need gh project subcommand
    try {
      await execFileAsync('gh', ['project', '--help']);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'gh project CLI not available or not authenticated' };
    }
  }

  async execute(context: WatchContext): Promise<CapabilityResult> {
    if (context.adapter.type === 'azure-devops') {
      return this.executeAdo(context);
    }
    return this.executeGitHub(context);
  }

  /** ADO board reconciliation via tags + work item state. */
  private async executeAdo(context: WatchContext): Promise<CapabilityResult> {
    let mismatches = 0;

    try {
      const items = await context.adapter.listWorkItems({ tags: ['squad'], limit: 300 });

      for (const item of items) {
        const hasStatusTag = item.tags.some(t => ADO_STATUS_TAGS.includes(t as typeof ADO_STATUS_TAGS[number]));
        const isClosed = ['Closed', 'Done', 'Resolved', 'Removed'].includes(item.state);
        const hasDoneTag = item.tags.includes('status:done');

        // Closed items without status:done → add it
        if (isClosed && !hasDoneTag) {
          mismatches++;
          try {
            // Remove any other status tags first
            for (const tag of ADO_STATUS_TAGS) {
              if (tag !== 'status:done' && item.tags.includes(tag)) {
                await context.adapter.removeTag(item.id, tag);
              }
            }
            await context.adapter.addTag(item.id, 'status:done');
          } catch { /* best-effort */ }
        }

        // Open items tagged as done → remove the tag
        if (!isClosed && hasDoneTag) {
          mismatches++;
          try {
            await context.adapter.removeTag(item.id, 'status:done');
          } catch { /* best-effort */ }
        }

        // Open items with no status tag → add status:todo
        if (!isClosed && !hasStatusTag) {
          try {
            await context.adapter.addTag(item.id, 'status:todo');
          } catch { /* best-effort */ }
        }
      }

      return {
        success: true,
        summary: mismatches > 0 ? `${mismatches} board mismatch(es) reconciled` : 'board in sync',
        data: { mismatches },
      };
    } catch (e) {
      return { success: false, summary: `board error: ${(e as Error).message}` };
    }
  }

  /** GitHub board reconciliation via Projects v2. */
  private async executeGitHub(context: WatchContext): Promise<CapabilityResult> {
    const projectNumber = (context.config['projectNumber'] as number) ?? 1;
    let mismatches = 0;

    try {
      const { stdout: itemsJson } = await execFileAsync('gh', [
        'project', 'item-list', String(projectNumber),
        '--owner', '@me',
        '--format', 'json',
        '--limit', '300',
      ], { maxBuffer: 10 * 1024 * 1024 });

      const items = JSON.parse(itemsJson) as {
        items?: Array<{
          id: string;
          status?: string;
          updatedAt?: string;
          content?: { number?: number; type?: string; state?: string };
        }>;
      };

      if (items.items?.length) {
        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

        for (const item of items.items) {
          if (!item.content?.number || item.content.type !== 'Issue') continue;
          const isClosed = item.content.state === 'CLOSED';
          const isDone = item.status?.toLowerCase() === 'done';

          if (isClosed && !isDone) {
            mismatches++;
          } else if (!isClosed && isDone) {
            mismatches++;
          }

          // Archive: close issues in Done for >3 days
          if (
            item.status?.toLowerCase() === 'done' &&
            item.content.state !== 'CLOSED' &&
            item.updatedAt
          ) {
            const updatedAt = new Date(item.updatedAt).getTime();
            if (Date.now() - updatedAt >= threeDaysMs) {
              try {
                await new Promise<void>((resolve, reject) => {
                  execFile(
                    'gh',
                    ['issue', 'close', String(item.content!.number!), '--comment',
                      '🤖 Ralph: Auto-closing — issue has been in Done for >3 days.'],
                    { maxBuffer: 5 * 1024 * 1024 },
                    (err) => (err ? reject(err) : resolve()),
                  );
                });
              } catch { /* best-effort */ }
            }
          }
        }
      }

      return {
        success: true,
        summary: mismatches > 0 ? `${mismatches} board mismatch(es) reconciled` : 'board in sync',
        data: { mismatches },
      };
    } catch (e) {
      return { success: false, summary: `board error: ${(e as Error).message}` };
    }
  }
}

/**
 * Move a work item to a status column.
 * GitHub: uses Projects v2 board.
 * ADO: uses status tags on work items.
 *
 * Exported so the main orchestrator can call it for execute-mode transitions.
 */
export async function updateBoardStatus(
  issueNumber: number,
  status: 'in-progress' | 'done' | 'blocked' | 'todo',
  options: { projectNumber?: number; owner?: string; adapter?: WatchContext['adapter'] },
): Promise<void> {
  // ADO path: use adapter tag management
  if (options.adapter?.type === 'azure-devops') {
    const tag = `status:${status}`;
    try {
      // Remove other status tags
      for (const t of ADO_STATUS_TAGS) {
        if (t !== tag) {
          try { await options.adapter.removeTag(issueNumber, t); } catch { /* ignore */ }
        }
      }
      await options.adapter.addTag(issueNumber, tag);
    } catch { /* best-effort */ }
    return;
  }

  // GitHub path: Projects v2
  const projectNum = options.projectNumber ?? 1;
  try {
    let repoUrl: string;
    try {
      const repoName = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
        encoding: 'utf-8', timeout: 10_000,
      }).trim();
      repoUrl = `https://github.com/${repoName}/issues/${issueNumber}`;
    } catch {
      return;
    }

    await execFileAsync('gh', [
      'project', 'item-add', String(projectNum),
      '--owner', options.owner ?? '@me',
      '--url', repoUrl,
    ], { maxBuffer: 5 * 1024 * 1024 });

    const statusMap: Record<string, string> = {
      'todo': 'Todo', 'in-progress': 'In Progress', 'done': 'Done', 'blocked': 'Blocked',
    };
    const statusValue = statusMap[status] ?? 'Todo';

    const { stdout: itemsJson } = await execFileAsync('gh', [
      'project', 'item-list', String(projectNum),
      '--owner', options.owner ?? '@me',
      '--format', 'json',
      '--limit', '300',
    ], { maxBuffer: 10 * 1024 * 1024 });

    const items = JSON.parse(itemsJson) as { items?: Array<{ id: string; content?: { number?: number } }> };
    const item = items.items?.find(i => i.content?.number === issueNumber);
    if (!item) return;

    await execFileAsync('gh', [
      'project', 'item-edit',
      '--project-id', String(projectNum),
      '--id', item.id,
      '--field-id', 'Status',
      '--single-select-option-id', statusValue,
    ], { maxBuffer: 5 * 1024 * 1024 });
  } catch { /* best-effort */ }
}
