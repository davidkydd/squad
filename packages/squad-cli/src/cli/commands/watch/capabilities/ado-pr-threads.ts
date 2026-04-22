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
}

export interface AdoContext {
  org: string;
  project: string;
  repoName: string;
  repoId: string;
}

// ── Token Management ─────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

function getToken(): string {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }
  const token = execFileSync(
    'az',
    ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--query', 'accessToken', '-o', 'tsv'],
    AZ_OPTS,
  ).trim();
  // Tokens last ~1 hour; cache for 50 minutes
  cachedToken = { value: token, expiresAt: now + 50 * 60_000 };
  return token;
}

// ── REST Helpers ─────────────────────────────────────────────────

function adoGet<T>(url: string): T {
  const token = getToken();
  const raw = execFileSync('az', ['rest', '--method', 'get', '--url', url, '--headers', `Authorization=Bearer ${token}`], AZ_OPTS);
  return JSON.parse(raw) as T;
}

function adoPost<T>(url: string, body: unknown): T {
  const token = getToken();
  const bodyJson = JSON.stringify(body);
  const raw = execFileSync(
    'az',
    ['rest', '--method', 'post', '--url', url, '--headers', `Authorization=Bearer ${token}`, 'Content-Type=application/json', '--body', bodyJson],
    AZ_OPTS,
  );
  return JSON.parse(raw) as T;
}

function adoPatch<T>(url: string, body: unknown): T {
  const token = getToken();
  const bodyJson = JSON.stringify(body);
  const raw = execFileSync(
    'az',
    ['rest', '--method', 'patch', '--url', url, '--headers', `Authorization=Bearer ${token}`, 'Content-Type=application/json', '--body', bodyJson],
    AZ_OPTS,
  );
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
    const content = rootComment.content.trim();

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
