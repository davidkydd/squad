/**
 * ADO PR Thread operations — direct REST API calls.
 *
 * The `az repos pr` CLI doesn't expose fine-grained thread/comment operations
 * (list threads, reply to a specific thread, update a comment). This module
 * wraps the Azure DevOps REST API directly via `az rest`.
 *
 * @module capabilities/ado-pr-threads
 */

import { execFileSync } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';
const EXEC_OPTS: { encoding: 'utf-8'; stdio: ['pipe', 'pipe', 'pipe'] } = {
  encoding: 'utf-8',
  stdio: ['pipe', 'pipe', 'pipe'],
};
const AZ_OPTS = { ...EXEC_OPTS, shell: IS_WINDOWS };

// ── Types ────────────────────────────────────────────────────────

export interface ThreadComment {
  id: number;
  parentCommentId: number;
  content: string;
  publishedDate: string;
  lastUpdatedDate: string;
  author: {
    displayName: string;
    uniqueName: string;
  };
  commentType: string;
}

export interface PullRequestThread {
  id: number;
  status: string;
  publishedDate: string;
  lastUpdatedDate: string;
  comments: ThreadComment[];
  properties?: Record<string, { $value: string }>;
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number; offset: number };
    rightFileEnd?: { line: number; offset: number };
  };
}

export interface SquadCommand {
  /** The raw command string after "/squad " */
  rawCommand: string;
  /** Parsed command name (e.g., "review", "babysit", "research") */
  commandName: string;
  /** Arguments/text after the command name */
  commandArgs: string;
  /** PR ID this command is on */
  prId: number;
  /** Thread ID containing the command */
  threadId: number;
  /** Comment ID containing the command */
  commentId: number;
  /** Who issued the command */
  author: string;
  /** Repo name (for display) */
  repoName: string;
  /** Full ADO context needed for API calls */
  adoContext: AdoContext;
  /** Resolved filesystem path to the downstream repo (for cwd during execution) */
  repoPath?: string;
  /** PR metadata fetched from ADO API (enriched before execution) */
  prDetails?: PrDetails;
}

export interface PrDetails {
  title: string;
  description: string;
  sourceRefName: string;  // e.g. "refs/heads/feature-branch"
  targetRefName: string;  // e.g. "refs/heads/master"
  status: string;
  createdBy: string;
  url: string;
}

export interface AdoContext {
  org: string;
  project: string;
  repoName: string;
  repoId: string;
}

// ── Token Management ─────────────────────────────────────────────

// ADO resource ID for Azure DevOps REST APIs
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

// ── REST Helpers ─────────────────────────────────────────────────
// Using `az rest --resource` delegates token acquisition to the Azure CLI,
// which handles caching, refresh, and credential selection automatically.

function adoGet<T>(url: string): T {
  const raw = execFileSync('az', ['rest', '--method', 'get', '--url', url, '--resource', ADO_RESOURCE], AZ_OPTS);
  if (raw.trimStart().startsWith('<')) {
    throw new Error('ADO returned HTML instead of JSON (auth redirect or rate limit)');
  }
  return JSON.parse(raw) as T;
}

function adoPost<T>(url: string, body: unknown): T {
  const bodyJson = JSON.stringify(body);
  const raw = execFileSync(
    'az',
    ['rest', '--method', 'post', '--url', url, '--resource', ADO_RESOURCE, '--body', bodyJson],
    AZ_OPTS,
  );
  if (raw.trimStart().startsWith('<')) {
    throw new Error('ADO returned HTML instead of JSON (auth redirect or rate limit)');
  }
  return JSON.parse(raw) as T;
}

function adoPatch<T>(url: string, body: unknown): T {
  const bodyJson = JSON.stringify(body);
  const raw = execFileSync(
    'az',
    ['rest', '--method', 'patch', '--url', url, '--resource', ADO_RESOURCE, '--body', bodyJson],
    AZ_OPTS,
  );
  if (raw.trimStart().startsWith('<')) {
    throw new Error('ADO returned HTML instead of JSON (auth redirect or rate limit)');
  }
  return JSON.parse(raw) as T;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Resolve the internal repository ID from the repo name.
 * Required for thread API calls which use the repo GUID, not name.
 */
export function getRepoId(org: string, project: string, repoName: string): string {
  const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoName}?api-version=7.1`;
  const repo = adoGet<{ id: string }>(url);
  return repo.id;
}

/**
 * List all threads on a PR, including their comments.
 */
export function listPrThreads(ctx: AdoContext, prId: number): PullRequestThread[] {
  const url = `https://dev.azure.com/${ctx.org}/${ctx.project}/_apis/git/repositories/${ctx.repoId}/pullRequests/${prId}/threads?api-version=7.1`;
  const result = adoGet<{ value: PullRequestThread[] }>(url);
  return result.value ?? [];
}

/**
 * Post a reply to an existing PR thread.
 * Returns the created comment.
 */
export function replyToThread(
  ctx: AdoContext,
  prId: number,
  threadId: number,
  content: string,
): ThreadComment {
  const url = `https://dev.azure.com/${ctx.org}/${ctx.project}/_apis/git/repositories/${ctx.repoId}/pullRequests/${prId}/threads/${threadId}/comments?api-version=7.1`;
  const body = {
    content,
    parentCommentId: 1, // reply to root comment
    commentType: 1, // text
  };
  return adoPost<ThreadComment>(url, body);
}

/**
 * Update an existing comment's content (e.g., to mark a /squad command as processed).
 */
export function updateComment(
  ctx: AdoContext,
  prId: number,
  threadId: number,
  commentId: number,
  newContent: string,
): ThreadComment {
  const url = `https://dev.azure.com/${ctx.org}/${ctx.project}/_apis/git/repositories/${ctx.repoId}/pullRequests/${prId}/threads/${threadId}/comments/${commentId}?api-version=7.1`;
  const body = { content: newContent };
  return adoPatch<ThreadComment>(url, body);
}

/**
 * Create a new top-level thread on a PR (not a reply to existing).
 * Useful for posting review results as a new thread.
 */
export function createThread(
  ctx: AdoContext,
  prId: number,
  content: string,
  status: string = 'closed',
): PullRequestThread {
  const url = `https://dev.azure.com/${ctx.org}/${ctx.project}/_apis/git/repositories/${ctx.repoId}/pullRequests/${prId}/threads?api-version=7.1`;
  const body = {
    comments: [{ content, commentType: 1, parentCommentId: 0 }],
    status: status === 'active' ? 1 : status === 'closed' ? 4 : 1,
  };
  return adoPost<PullRequestThread>(url, body);
}

/**
 * Create an inline comment thread on a specific file and line range in a PR.
 * Used to post review findings at the exact location they apply to.
 *
 * The threadContext positions the comment on the "right" (new/source) side of the diff.
 * Status 1 = active (open for discussion), 4 = closed.
 */
export function createInlineThread(
  ctx: AdoContext,
  prId: number,
  content: string,
  filePath: string,
  startLine: number,
  endLine?: number,
  status: 'active' | 'closed' = 'active',
): PullRequestThread {
  const url = `https://dev.azure.com/${ctx.org}/${ctx.project}/_apis/git/repositories/${ctx.repoId}/pullRequests/${prId}/threads?api-version=7.1`;
  const body = {
    comments: [{ content, commentType: 1, parentCommentId: 0 }],
    status: status === 'active' ? 1 : 4,
    threadContext: {
      filePath: filePath.startsWith('/') ? filePath : `/${filePath}`,
      rightFileStart: { line: startLine, offset: 1 },
      rightFileEnd: { line: endLine ?? startLine, offset: 1 },
    },
  };
  return adoPost<PullRequestThread>(url, body);
}

/**
 * Get the latest iteration ID for a PR.
 * Iterations represent push updates; the latest iteration is needed to
 * position inline comments on the current version of the diff.
 */
export function getLatestIterationId(ctx: AdoContext, prId: number): number | null {
  try {
    const url = `https://dev.azure.com/${ctx.org}/${ctx.project}/_apis/git/repositories/${ctx.repoId}/pullRequests/${prId}/iterations?api-version=7.1`;
    const result = adoGet<{ value: Array<{ id: number }> }>(url);
    const iterations = result.value ?? [];
    if (iterations.length === 0) return null;
    return iterations[iterations.length - 1]!.id;
  } catch (e) {
    console.log(`  ⚠️ Could not fetch PR iterations: ${(e as Error).message}`);
    return null;
  }
}

// ── PR Details ──────────────────────────────────────────────────

/**
 * Fetch PR metadata from ADO REST API.
 * Used to enrich SquadCommand with source/target branches, title, description
 * so agents don't need to figure out which branch to diff.
 */
export function getPrDetails(ctx: AdoContext, prId: number): PrDetails | null {
  try {
    const url = `https://dev.azure.com/${ctx.org}/${ctx.project}/_apis/git/repositories/${ctx.repoId}/pullRequests/${prId}?api-version=7.1`;
    const pr = adoGet<{
      title: string;
      description: string;
      sourceRefName: string;
      targetRefName: string;
      status: string;
      createdBy: { displayName: string };
      url: string;
    }>(url);
    return {
      title: pr.title ?? '',
      description: pr.description ?? '',
      sourceRefName: pr.sourceRefName ?? '',
      targetRefName: pr.targetRefName ?? '',
      status: pr.status ?? 'unknown',
      createdBy: pr.createdBy?.displayName ?? 'unknown',
      url: pr.url ?? '',
    };
  } catch (e) {
    console.log(`  ⚠️ Could not fetch PR #${prId} details: ${(e as Error).message}`);
    return null;
  }
}

// ── PR Policy & Thread Pre-Fetch ─────────────────────────────────
// Pre-fetch data the babysit agent needs, since the agent sandbox
// blocks `az repos pr` CLI commands. We use `az rest --resource` which works.

export interface PolicyEvaluation {
  configurationId: number;
  displayName: string;
  status: string;    // 'approved' | 'rejected' | 'running' | 'queued' | 'notApplicable' | 'broken'
  isBlocking: boolean;
  buildUrl?: string;
  context?: string;
}

export interface PrThreadSummary {
  totalThreads: number;
  activeThreads: number;
  resolvedThreads: number;
  threads: Array<{
    id: number;
    status: string;
    firstComment: string;
    author: string;
    isSystemThread: boolean;
  }>;
}

/**
 * Fetch PR policy evaluations (build gates, reviewer requirements, etc.)
 * via the ADO REST API. Returns null on failure.
 */
export function getPrPolicyEvaluations(ctx: AdoContext, prId: number): PolicyEvaluation[] | null {
  try {
    // The policy evaluation endpoint uses the project scope, not repo-scoped
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${ctx.project}/${prId}`;
    const url = `https://dev.azure.com/${ctx.org}/${ctx.project}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&api-version=7.1-preview`;
    const result = adoGet<{
      value: Array<{
        configuration: { id: number; type: { displayName: string }; isEnabled: boolean; isBlocking: boolean };
        status: string;
        context?: { buildId?: number; isExpired?: boolean };
      }>;
    }>(url);

    return (result.value ?? []).map((ev) => ({
      configurationId: ev.configuration?.id ?? 0,
      displayName: ev.configuration?.type?.displayName ?? 'Unknown',
      status: ev.status ?? 'unknown',
      isBlocking: ev.configuration?.isBlocking ?? false,
      buildUrl: ev.context?.buildId
        ? `https://dev.azure.com/${ctx.org}/${ctx.project}/_build/results?buildId=${ev.context.buildId}`
        : undefined,
      context: ev.context?.isExpired ? 'expired' : undefined,
    }));
  } catch (e) {
    console.log(`  ⚠️ Could not fetch PR policy evaluations: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Summarize PR threads: active/resolved counts and first comment of each.
 * Useful for babysit to know what comment threads need resolution.
 */
export function getPrThreadsSummary(ctx: AdoContext, prId: number): PrThreadSummary | null {
  try {
    const threads = listPrThreads(ctx, prId);
    let active = 0;
    let resolved = 0;

    const summaries = threads.map((t) => {
      const isSystem = !t.comments?.length || t.comments[0]?.commentType === 'system';
      const status = typeof t.status === 'number'
        ? ['unknown', 'active', 'fixed', 'wontFix', 'closed', 'byDesign', 'pending'][t.status] ?? 'unknown'
        : String(t.status ?? 'unknown');

      if (status === 'active' || status === 'pending') active++;
      else resolved++;

      const firstComment = t.comments?.[0]?.content?.slice(0, 200) ?? '';
      const author = t.comments?.[0]?.author?.displayName ?? 'system';

      return { id: t.id, status, firstComment, author, isSystemThread: isSystem };
    });

    return {
      totalThreads: threads.length,
      activeThreads: active,
      resolvedThreads: resolved,
      threads: summaries.filter((s) => !s.isSystemThread), // only human/bot threads
    };
  } catch (e) {
    console.log(`  ⚠️ Could not fetch PR thread summary: ${(e as Error).message}`);
    return null;
  }
}

// ── /squad Command Parsing ───────────────────────────────────────

const SQUAD_CMD_REGEX = /^\/squad\s+(.+)/i;

/** Well-known commands with specific handler logic. */
const KNOWN_COMMANDS = new Set(['review', 'babysit', 'bump', 'status']);

/**
 * Scan all threads on a PR for unprocessed /squad commands.
 *
 * A command is "unprocessed" if the root comment starts with "/squad "
 * and has NOT been edited to contain the "✅" completion marker or
 * "⏳" in-progress marker.
 */
export function findSquadCommands(
  threads: PullRequestThread[],
  prId: number,
  repoName: string,
  adoContext: AdoContext,
): SquadCommand[] {
  const commands: SquadCommand[] = [];

  for (const thread of threads) {
    if (!thread.comments || thread.comments.length === 0) continue;

    // Only look at the root comment (first comment in thread)
    const rootComment = thread.comments[0]!;
    if (!rootComment.content) continue;
    // ADO comments may be HTML-wrapped — strip tags for matching
    const content = rootComment.content.replace(/<[^>]*>/g, '').trim();

    // Skip if already processed (contains completion or in-progress marker)
    if (content.includes('✅') || content.includes('⏳')) continue;

    const match = content.match(SQUAD_CMD_REGEX);
    if (!match) continue;

    const rawCommand = match[1]!.trim();
    // Parse: first word is command name, rest is args
    const parts = rawCommand.split(/\s+/);
    const commandName = parts[0]!.toLowerCase();
    const commandArgs = parts.slice(1).join(' ');

    commands.push({
      rawCommand,
      commandName,
      commandArgs,
      prId,
      threadId: thread.id,
      commentId: rootComment.id,
      author: rootComment.author.displayName,
      repoName,
      adoContext,
    });
  }

  return commands;
}

/**
 * Mark a /squad command as in-progress by updating the original comment.
 */
export function markCommandInProgress(cmd: SquadCommand): void {
  const updatedContent = `⏳ /squad ${cmd.rawCommand}\n\n_Processing — squad acknowledged at ${new Date().toISOString()}_`;
  updateComment(cmd.adoContext, cmd.prId, cmd.threadId, cmd.commentId, updatedContent);
}

/**
 * Mark a /squad command as completed by updating the original comment.
 */
export function markCommandCompleted(cmd: SquadCommand, summary?: string): void {
  const summaryLine = summary ? `\n\n${summary}` : '';
  const updatedContent = `✅ /squad ${cmd.rawCommand}\n\n_Completed at ${new Date().toISOString()}_${summaryLine}`;
  updateComment(cmd.adoContext, cmd.prId, cmd.threadId, cmd.commentId, updatedContent);
}

/**
 * Mark a /squad command as failed.
 */
export function markCommandFailed(cmd: SquadCommand, error: string): void {
  const updatedContent = `❌ /squad ${cmd.rawCommand}\n\n_Failed at ${new Date().toISOString()}: ${error}_`;
  updateComment(cmd.adoContext, cmd.prId, cmd.threadId, cmd.commentId, updatedContent);
}

/**
 * Post a checkpoint update to the command's thread.
 */
export function postCheckpoint(cmd: SquadCommand, message: string): void {
  replyToThread(cmd.adoContext, cmd.prId, cmd.threadId, message);
}

/**
 * Determine if a command is a known built-in or freeform.
 */
export function isKnownCommand(commandName: string): boolean {
  return KNOWN_COMMANDS.has(commandName);
}
