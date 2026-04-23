/**
 * Squad Commands capability — scans PR comment threads for /squad commands.
 *
 * Integrates with the cross-repo watch loop to find actionable commands
 * on ADO pull requests. Commands like "/squad review", "/squad babysit",
 * or freeform "/squad investigate X" are detected, acknowledged, dispatched
 * to agents, and results posted back as threaded replies.
 *
 * Lifecycle:
 * 1. Scan all open PRs in cross-repos for threads containing /squad commands
 * 2. Acknowledge immediately (reply + mark in-progress)
 * 3. Dispatch to agent (via agentCmd)
 * 4. Post result as thread reply
 * 5. Mark original comment as completed
 */

import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { WatchCapability, WatchContext, PreflightResult, CapabilityResult } from '../types.js';
import { createVerboseLogger } from '../verbose.js';
import {
  type AdoContext,
  type SquadCommand,
  type PullRequestThread,
  getRepoId,
  listPrThreads,
  findSquadCommands,
  markCommandInProgress,
  markCommandCompleted,
  markCommandFailed,
  postCheckpoint,
  replyToThread,
  isKnownCommand,
} from './ado-pr-threads.js';

const IS_WINDOWS = process.platform === 'win32';

// ── Types ────────────────────────────────────────────────────────

interface ProcessedCommand {
  prId: number;
  threadId: number;
  commentId: number;
  repoName: string;
  commandName: string;
  processedAt: string;
  status: 'completed' | 'failed';
}

interface CommandState {
  processed: ProcessedCommand[];
}

// ── State Persistence ────────────────────────────────────────────

function stateFilePath(teamRoot: string): string {
  return path.join(teamRoot, '.squad', 'squad-commands-state.json');
}

export function loadState(teamRoot: string): CommandState {
  const fp = stateFilePath(teamRoot);
  if (existsSync(fp)) {
    try {
      return JSON.parse(readFileSync(fp, 'utf-8')) as CommandState;
    } catch {
      return { processed: [] };
    }
  }
  return { processed: [] };
}

function saveState(teamRoot: string, state: CommandState): void {
  const fp = stateFilePath(teamRoot);
  const dir = path.dirname(fp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Keep only last 500 entries to avoid unbounded growth
  if (state.processed.length > 500) {
    state.processed = state.processed.slice(-500);
  }
  writeFileSync(fp, JSON.stringify(state, null, 2));
}

function isAlreadyProcessed(state: CommandState, prId: number, threadId: number, commentId: number): boolean {
  return state.processed.some(
    p => p.prId === prId && p.threadId === threadId && p.commentId === commentId,
  );
}

// ── Agent Command Builder ────────────────────────────────────────

function buildAgentCommand(
  prompt: string,
  context: WatchContext,
): { cmd: string; args: string[] } {
  if (context.agentCmd) {
    const parts = context.agentCmd.trim().split(/\s+/);
    const cmd = parts[0]!;
    const args = [...parts.slice(1), '-p', prompt];
    return { cmd, args };
  }
  const args = ['-p', prompt];
  if (context.copilotFlags) {
    args.push(...context.copilotFlags.trim().split(/\s+/));
  }
  return { cmd: 'copilot', args };
}

// ── Command Handlers ─────────────────────────────────────────────

/**
 * Build the agent prompt for a /squad review command.
 */
function buildReviewPrompt(cmd: SquadCommand): string {
  return [
    `You are reviewing PR #${cmd.prId} in the ${cmd.repoName} repository.`,
    `Requested by: ${cmd.author}`,
    '',
    'TASK: Perform a thorough code review of this PR.',
    '',
    'Steps:',
    `1. Run: az repos pr show --id ${cmd.prId} --org https://dev.azure.com/${cmd.adoContext.org} --project ${cmd.adoContext.project} --output json`,
    '2. Get the diff and review the changes critically',
    '3. Focus on: bugs, security issues, performance, thread safety (for Go), error handling',
    '4. For each issue: explain the problem, show the scenario, suggest a fix with file/line references',
    '5. Be critical but fair — ignore style nits, focus on real problems',
    '',
    'OUTPUT: Write your review as a structured markdown report.',
    'Include: ## Summary, ## Critical Issues, ## Suggestions, ## Overall Assessment',
    `Print the full report to stdout so it can be posted to the PR.`,
    cmd.commandArgs ? `\nAdditional instructions: ${cmd.commandArgs}` : '',
  ].join('\n');
}

/**
 * Build the agent prompt for a /squad babysit command.
 */
function buildBabysitPrompt(cmd: SquadCommand): string {
  return [
    `You are babysitting PR #${cmd.prId} in the ${cmd.repoName} repository until it is merge-ready.`,
    `Requested by: ${cmd.author}`,
    '',
    'TASK: Perform one babysit cycle on this PR. This is NOT continuous monitoring — just one pass.',
    '',
    'Steps:',
    `1. Get PR status: az repos pr show --id ${cmd.prId} --org https://dev.azure.com/${cmd.adoContext.org} --project ${cmd.adoContext.project} --output json`,
    '2. Check all policy evaluations (build gates, reviewer requirements, comment threads)',
    '3. Identify and trigger any untriggered required builds',
    '4. Check for flaky builds (>50% failure across recent builds = repo-wide flake, skip retry)',
    '5. Re-queue any expired/broken policy evaluations',
    '6. Check for unresolved comment threads — resolve self-authored ones if safe',
    '7. Report current blocking status: what remains before merge-ready',
    '',
    'OUTPUT: Write a status report in markdown format.',
    'Include: ## Policy Status, ## Builds, ## Open Comments, ## Blocking Items, ## Next Steps',
    cmd.commandArgs ? `\nAdditional instructions: ${cmd.commandArgs}` : '',
  ].join('\n');
}

/**
 * Build the agent prompt for a /squad bump command.
 */
function buildBumpPrompt(cmd: SquadCommand): string {
  return [
    `You are bumping PR #${cmd.prId} in the ${cmd.repoName} repository to unblock merge.`,
    `Requested by: ${cmd.author}`,
    '',
    'TASK: Perform a one-shot bump — diagnose and resolve blockers.',
    '',
    'Steps:',
    `1. Get PR status: az repos pr show --id ${cmd.prId} --org https://dev.azure.com/${cmd.adoContext.org} --project ${cmd.adoContext.project} --output json`,
    '2. Diagnose failed gates (build failures, expired checks)',
    '3. Re-queue expired/broken policy evaluations',
    '4. Check for merge conflicts',
    '5. Report what was done and what still blocks',
    '',
    'OUTPUT: Brief status report of actions taken and remaining blockers.',
    cmd.commandArgs ? `\nAdditional instructions: ${cmd.commandArgs}` : '',
  ].join('\n');
}

/**
 * Build the agent prompt for a freeform /squad command.
 * These use MCP tools (Teams, EngHub, IcM, WorkIQ) for research.
 */
function buildFreeformPrompt(cmd: SquadCommand): string {
  return [
    `You are assisting with PR #${cmd.prId} in the ${cmd.repoName} repository.`,
    `Requested by: ${cmd.author}`,
    '',
    `TASK: ${cmd.rawCommand}`,
    '',
    'CONTEXT: This request came from a /squad command on an ADO pull request.',
    `The PR is in the ${cmd.repoName} repo (org: ${cmd.adoContext.org}, project: ${cmd.adoContext.project}).`,
    '',
    'You have access to MCP tools for research:',
    '- Teams: Search messages, read channels for context',
    '- EngHub: Search documentation, TSGs, knowledge articles at eng.ms',
    '- IcM: Look up incidents, get summaries, find related incidents',
    '- WorkIQ: Ask M365 Copilot questions about emails, meetings, files',
    '- ADO: Search work items, wiki, check builds and pipelines',
    '',
    'Use these tools to thoroughly research the request. Cross-reference multiple sources.',
    '',
    `Get the PR details first: az repos pr show --id ${cmd.prId} --org https://dev.azure.com/${cmd.adoContext.org} --project ${cmd.adoContext.project} --output json`,
    '',
    'OUTPUT: Write a detailed research report in markdown format.',
    'Include: ## Findings, ## Sources Consulted, ## Recommendations',
  ].join('\n');
}

/**
 * Build the agent prompt for a /squad status command.
 */
function buildStatusPrompt(cmd: SquadCommand): string {
  return [
    `Check the status of PR #${cmd.prId} in the ${cmd.repoName} repository.`,
    `Requested by: ${cmd.author}`,
    '',
    'TASK: Quick status check — report current state of the PR.',
    '',
    `1. Get PR status: az repos pr show --id ${cmd.prId} --org https://dev.azure.com/${cmd.adoContext.org} --project ${cmd.adoContext.project} --output json`,
    '2. List policy evaluations grouped by status',
    '3. List reviewers and their votes',
    '4. Check for merge conflicts',
    '5. Summarize what blocks merge',
    '',
    'OUTPUT: Brief status summary.',
  ].join('\n');
}

/**
 * Select the prompt builder for a command.
 */
function buildPromptForCommand(cmd: SquadCommand): string {
  switch (cmd.commandName) {
    case 'review': return buildReviewPrompt(cmd);
    case 'babysit': return buildBabysitPrompt(cmd);
    case 'bump': return buildBumpPrompt(cmd);
    case 'status': return buildStatusPrompt(cmd);
    default: return buildFreeformPrompt(cmd);
  }
}

// ── Skills Loader ────────────────────────────────────────────────

/**
 * Load .squad/skills/ markdown files from a directory.
 * Returns a formatted string with skill contents, or empty string if none found.
 */
function loadSkillsFromDir(dir: string, label: string): string {
  const skillsDir = path.join(dir, '.squad', 'skills');
  if (!existsSync(skillsDir)) return '';

  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const files = readdirSync(skillsDir).filter((f: string) => f.endsWith('.md'));
  if (files.length === 0) return '';

  const sections: string[] = [`\n## ${label} Skills\n`];
  for (const file of files) {
    try {
      const content = readFileSync(path.join(skillsDir, file), 'utf-8');
      sections.push(`### ${file}\n\`\`\`\n${content}\n\`\`\`\n`);
    } catch {
      // Skip unreadable files
    }
  }
  return sections.join('\n');
}

/**
 * Build a skills context block for the agent prompt.
 * Loads skills from:
 *  1. The orchestrator squad (context.teamRoot) — cross-cutting skills
 *  2. The downstream repo (cmd.repoPath) — repo-specific skills
 */
function buildSkillsContext(context: WatchContext, cmd: SquadCommand): string {
  const parts: string[] = [];

  // Orchestrator skills (o11y-squad or whichever squad is coordinating)
  const orchestratorSkills = loadSkillsFromDir(context.teamRoot, 'Orchestrator');
  if (orchestratorSkills) parts.push(orchestratorSkills);

  // Downstream repo skills (if executing in a different repo)
  if (cmd.repoPath && cmd.repoPath !== context.teamRoot) {
    const downstreamSkills = loadSkillsFromDir(cmd.repoPath, `${cmd.repoName} Repo`);
    if (downstreamSkills) parts.push(downstreamSkills);
  }

  if (parts.length === 0) return '';
  return '\n\n# Available Skills Reference\n' + parts.join('\n');
}

// ── Command Execution ────────────────────────────────────────────

/**
 * Execute a /squad command: acknowledge, dispatch agent, post result.
 */
async function executeSquadCommand(
  cmd: SquadCommand,
  context: WatchContext,
  timeoutMs: number,
): Promise<{ success: boolean; output?: string; error?: string }> {
  // Step 1: Acknowledge immediately
  const ackMessage = isKnownCommand(cmd.commandName)
    ? `🤖 **Squad acknowledges:** \`/squad ${cmd.commandName}\`\n\nStarting ${cmd.commandName} workflow for this PR. Updates will be posted here as work progresses.`
    : `🤖 **Squad acknowledges:** \`/squad ${cmd.rawCommand}\`\n\nResearching your request. Updates will be posted here as work progresses.`;

  try {
    replyToThread(cmd.adoContext, cmd.prId, cmd.threadId, ackMessage);
  } catch (e) {
    // Non-fatal: ack failed but we can still try the work
    console.log(`  ⚠️ Could not post acknowledgment: ${(e as Error).message}`);
  }

  // Step 2: Mark the original comment as in-progress
  try {
    markCommandInProgress(cmd);
  } catch {
    // Non-fatal
  }

  // Step 3: Build and dispatch agent — inject skills and use downstream repo cwd
  const basePrompt = buildPromptForCommand(cmd);
  const skillsContext = buildSkillsContext(context, cmd);
  const prompt = skillsContext ? basePrompt + skillsContext : basePrompt;
  const { cmd: agentCmd, args } = buildAgentCommand(prompt, context);

  // Use downstream repo path as cwd when available, otherwise fall back to orchestrator
  const executionCwd = cmd.repoPath ?? context.teamRoot;

  return new Promise<{ success: boolean; output?: string; error?: string }>((resolve) => {
    let stdout = '';
    let stderr = '';

    const cp: ChildProcess = execFile(
      agentCmd,
      args,
      { cwd: executionCwd, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 },
      (err) => {
        if (err) {
          const execErr = err as Error & { killed?: boolean };
          const msg = execErr.killed ? 'Timed out' : execErr.message;
          resolve({ success: false, error: msg, output: stdout || stderr });
        } else {
          resolve({ success: true, output: stdout });
        }
      },
    );

    cp.stdout?.on('data', (data: Buffer | string) => { stdout += String(data); });
    cp.stderr?.on('data', (data: Buffer | string) => { stderr += String(data); });

    if (context.pidTracker && cp.pid) {
      context.pidTracker.track(cp.pid, `squad-cmd-${cmd.commandName}-pr${cmd.prId}`);
    }
  });
}

// ── Cross-Repo Integration ───────────────────────────────────────

export interface CrossRepoSquadCommandsConfig {
  /** Repos to scan — same as the cross-repo entries */
  repos: Array<{ name: string; org: string; project: string; repoName: string }>;
}

/**
 * Resolve ADO context for a cross-repo entry by detecting org/project/repo
 * from the git remote URL.
 */
export function resolveAdoContext(repoPath: string): AdoContext | null {
  try {
    const { execFileSync: execSync } = require('node:child_process') as typeof import('node:child_process');
    const remoteUrl = execSync(
      'git', ['remote', 'get-url', 'origin'],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    // Parse ADO remote URL patterns:
    // https://msazure@dev.azure.com/msazure/CloudNativeCompute/_git/aks-operator
    // https://dev.azure.com/msazure/CloudNativeCompute/_git/aks-operator
    // git@ssh.dev.azure.com:v3/msazure/CloudNativeCompute/aks-operator
    let match = remoteUrl.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/\s]+)/);
    if (!match) {
      match = remoteUrl.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/\s]+)/);
    }
    if (!match) return null;

    const org = match[1]!;
    const project = match[2]!;
    const repoName = match[3]!.replace(/\.git$/, '');

    // Resolve repo ID (needed for thread APIs)
    const repoId = getRepoId(org, project, repoName);

    return { org, project, repoName, repoId };
  } catch {
    return null;
  }
}

// Repo ID cache to avoid repeated API calls
const repoIdCache = new Map<string, AdoContext>();

/**
 * Get or create ADO context for a repo path, with caching.
 */
export function getAdoContext(repoPath: string, repoName: string): AdoContext | null {
  const cached = repoIdCache.get(repoName);
  if (cached) return cached;

  const ctx = resolveAdoContext(repoPath);
  if (ctx) {
    repoIdCache.set(repoName, ctx);
  }
  return ctx;
}

/**
 * Scan a single cross-repo for /squad commands on all open PRs.
 * @param repoPath Resolved filesystem path to the downstream repo (for cwd during execution)
 */
export async function scanRepoForCommands(
  repoName: string,
  adoCtx: AdoContext,
  prIds: number[],
  state: CommandState,
  repoPath?: string,
): Promise<SquadCommand[]> {
  const allCommands: SquadCommand[] = [];

  for (const prId of prIds) {
    try {
      const threads = listPrThreads(adoCtx, prId);
      const commands = findSquadCommands(threads, prId, repoName, adoCtx);

      // Attach the downstream repo path so agents execute in the right cwd
      if (repoPath) {
        for (const cmd of commands) {
          cmd.repoPath = repoPath;
        }
      }

      // Filter out already-processed commands
      const newCommands = commands.filter(
        cmd => !isAlreadyProcessed(state, cmd.prId, cmd.threadId, cmd.commentId),
      );

      allCommands.push(...newCommands);
    } catch {
      // Skip PRs where thread listing fails (permissions, etc.)
    }
  }

  return allCommands;
}

// ── Capability Implementation ────────────────────────────────────

export class SquadCommandsCapability implements WatchCapability {
  readonly name = 'squad-commands';
  readonly description = 'Scan PR comments for /squad commands and dispatch agents';
  readonly configShape = 'object' as const;
  readonly requires = ['az CLI with devops extension'];
  readonly phase = 'post-execute' as const;

  async preflight(context: WatchContext): Promise<PreflightResult> {
    try {
      const { execFileSync: execSync } = await import('node:child_process');
      execSync('az', ['devops', '-h'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WINDOWS });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'az CLI with devops extension not available' };
    }
  }

  async execute(context: WatchContext): Promise<CapabilityResult> {
    // This capability is driven by the cross-repo loop in index.ts,
    // not by the standard phase execution. Return a no-op here.
    // The actual work is done via processSquadCommands() called from the watch loop.
    return { success: true, summary: 'Squad commands processed via cross-repo loop' };
  }
}

/**
 * Main entry point: process /squad commands found on cross-repo PRs.
 *
 * Called from the watch loop after cross-repo PR scanning.
 * Returns the number of commands processed.
 */
export async function processSquadCommands(
  commands: SquadCommand[],
  context: WatchContext,
  timeoutMs: number = 10 * 60 * 1000,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const state = loadState(context.teamRoot);
  let succeeded = 0;
  let failed = 0;

  for (const cmd of commands) {
    // Double-check not already processed (race condition safety)
    if (isAlreadyProcessed(state, cmd.prId, cmd.threadId, cmd.commentId)) continue;

    const timestamp = new Date().toLocaleTimeString();
    console.log(`  🤖 [${timestamp}] Processing /squad ${cmd.commandName} on PR #${cmd.prId} (${cmd.repoName})`);

    try {
      const result = await executeSquadCommand(cmd, context, timeoutMs);

      if (result.success) {
        // Post result to the thread
        const resultMessage = result.output
          ? `✅ **Squad completed:** \`/squad ${cmd.commandName}\`\n\n${truncateForComment(result.output)}`
          : `✅ **Squad completed:** \`/squad ${cmd.commandName}\`\n\n_Completed successfully._`;

        try {
          replyToThread(cmd.adoContext, cmd.prId, cmd.threadId, resultMessage);
        } catch {
          console.log(`  ⚠️ Could not post result to PR thread`);
        }

        markCommandCompleted(cmd, `Completed by squad`);
        succeeded++;
      } else {
        // Post failure to the thread
        const errorMessage = `❌ **Squad failed:** \`/squad ${cmd.commandName}\`\n\n${result.error ?? 'Unknown error'}\n\n${result.output ? truncateForComment(result.output) : ''}`;

        try {
          replyToThread(cmd.adoContext, cmd.prId, cmd.threadId, errorMessage);
        } catch {
          console.log(`  ⚠️ Could not post failure to PR thread`);
        }

        markCommandFailed(cmd, result.error ?? 'Unknown error');
        failed++;
      }
    } catch (e) {
      console.log(`  ❌ Error processing /squad ${cmd.commandName}: ${(e as Error).message}`);
      try {
        markCommandFailed(cmd, (e as Error).message);
      } catch {
        // Can't even mark as failed — skip
      }
      failed++;
    }

    // Record as processed regardless of outcome
    state.processed.push({
      prId: cmd.prId,
      threadId: cmd.threadId,
      commentId: cmd.commentId,
      repoName: cmd.repoName,
      commandName: cmd.commandName,
      processedAt: new Date().toISOString(),
      status: failed > succeeded ? 'failed' : 'completed',
    });
    saveState(context.teamRoot, state);
  }

  return { processed: commands.length, succeeded, failed };
}

/**
 * Truncate long output for PR comments (ADO has a ~150K char limit but
 * we want to keep things readable).
 */
function truncateForComment(text: string, maxLength: number = 8000): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n\n_... (truncated — full output was ' + text.length + ' characters)_';
}
