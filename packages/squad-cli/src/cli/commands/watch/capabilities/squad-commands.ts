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

import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { WatchCapability, WatchContext, PreflightResult, CapabilityResult } from '../types.js';
import { createVerboseLogger } from '../verbose.js';
import {
  type AdoContext,
  type SquadCommand,
  type PullRequestThread,
  type PrDetails,
  type PolicyEvaluation,
  type PrThreadSummary,
  getRepoId,
  listPrThreads,
  findSquadCommands,
  markCommandInProgress,
  markCommandCompleted,
  markCommandFailed,
  postCheckpoint,
  replyToThread,
  isKnownCommand,
  getPrDetails,
  createInlineThread,
  getPrPolicyEvaluations,
  getPrThreadsSummary,
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
  const pr = cmd.prDetails;
  const lines: string[] = [
    `You are reviewing PR #${cmd.prId} in the ${cmd.repoName} repository.`,
    `Requested by: ${cmd.author}`,
  ];

  if (pr) {
    const srcBranch = pr.sourceRefName.replace('refs/heads/', '');
    const tgtBranch = pr.targetRefName.replace('refs/heads/', '');
    lines.push(
      '',
      '## PR Details',
      `- **Title:** ${pr.title}`,
      `- **Author:** ${pr.createdBy}`,
      `- **Source branch:** ${srcBranch}`,
      `- **Target branch:** ${tgtBranch}`,
      pr.description ? `- **Description:** ${pr.description.slice(0, 500)}` : '',
      '',
      'TASK: Perform a thorough code review of this PR.',
      '',
      'Steps:',
      `1. Fetch the PR branch and get the diff:`,
      `   git fetch origin ${pr.sourceRefName}:refs/remotes/origin/${srcBranch} 2>/dev/null || true`,
      `   git fetch origin ${pr.targetRefName}:refs/remotes/origin/${tgtBranch} 2>/dev/null || true`,
      `   git --no-pager diff origin/${tgtBranch}...origin/${srcBranch}`,
      `   IMPORTANT: Always diff origin/${tgtBranch}...origin/${srcBranch} — never use HEAD or local branches.`,
      '2. Review the changes critically',
      '3. Focus on: bugs, security issues, performance, thread safety (for Go), error handling',
      '4. For each issue found, note the exact file path (relative to repo root) and line number in the NEW (source) side of the diff',
      '5. Be critical but fair — ignore style nits, focus on real problems',
    );
  } else {
    lines.push(
      '',
      'TASK: Perform a thorough code review of this PR.',
      '',
      'Steps:',
      `1. Run: az repos pr show --id ${cmd.prId} --org https://dev.azure.com/${cmd.adoContext.org} --project ${cmd.adoContext.project} --output json`,
      '   Parse the sourceRefName and targetRefName from the output.',
      '   Then diff those branches: git --no-pager diff origin/{targetBranch}...origin/{sourceBranch}',
      '   IMPORTANT: Never use HEAD or local branches — always diff the PR source against target.',
      '2. Review the changes critically',
      '3. Focus on: bugs, security issues, performance, thread safety (for Go), error handling',
      '4. For each issue found, note the exact file path (relative to repo root) and line number in the NEW (source) side of the diff',
      '5. Be critical but fair — ignore style nits, focus on real problems',
    );
  }

  lines.push(
    '',
    '## OUTPUT FORMAT',
    '',
    'You MUST output TWO sections:',
    '',
    '### Section 1: Inline Findings (structured JSON)',
    'Emit a JSON array of findings between these exact markers.',
    'Each finding will be posted as an inline comment on the specific file/line in the PR.',
    'Line numbers MUST refer to line numbers in the SOURCE (new) side of the diff.',
    'The "file" field must be the path relative to the repo root (e.g., "src/main.go", not "/src/main.go").',
    '',
    '<!-- REVIEW_FINDINGS_START -->',
    '[',
    '  {',
    '    "file": "path/to/file.go",',
    '    "line": 42,',
    '    "endLine": 45,',
    '    "severity": "warning",',
    '    "title": "Potential nil pointer dereference",',
    '    "comment": "The `err` variable is not checked before accessing `result.Value`. If `DoSomething()` returns an error, this will panic.\\n\\nSuggested fix:\\n```go\\nif err != nil {\\n    return err\\n}\\n```"',
    '  }',
    ']',
    '<!-- REVIEW_FINDINGS_END -->',
    '',
    'Severity levels: "critical" (bugs, security), "warning" (likely problems), "suggestion" (improvements), "nitpick" (minor style — use sparingly)',
    'If no issues found, output an empty array: `[]`',
    '',
    '### Section 2: Summary',
    'After the findings block, write a brief overall assessment as plain text.',
    'Include: a one-line TL;DR, overall recommendation (approve/request changes), and any repo-wide observations.',
    cmd.commandArgs ? `\nAdditional instructions: ${cmd.commandArgs}` : '',
  );

  return lines.join('\n');
}

/**
 * Build the agent prompt for a /squad babysit command.
 */
function buildBabysitPrompt(cmd: SquadCommand): string {
  const pr = cmd.prDetails;
  const lines: string[] = [
    `You are babysitting PR #${cmd.prId} in the ${cmd.repoName} repository until it is merge-ready.`,
    `Requested by: ${cmd.author}`,
  ];

  if (pr) {
    const srcBranch = pr.sourceRefName.replace('refs/heads/', '');
    const tgtBranch = pr.targetRefName.replace('refs/heads/', '');
    lines.push(
      '',
      '## PR Details',
      `- **Title:** ${pr.title}`,
      `- **Author:** ${pr.createdBy}`,
      `- **Source branch:** ${srcBranch}`,
      `- **Target branch:** ${tgtBranch}`,
      `- **Status:** ${pr.status}`,
    );
  }

  // Inject pre-fetched policy evaluations
  const policyEvals = (cmd as SquadCommand & { _policyEvals?: PolicyEvaluation[] | null })._policyEvals;
  if (policyEvals && policyEvals.length > 0) {
    lines.push('', '## Policy Evaluations (pre-fetched)');
    for (const pe of policyEvals) {
      const blocking = pe.isBlocking ? '🔒 blocking' : '📋 optional';
      const expired = pe.context === 'expired' ? ' ⏰ EXPIRED' : '';
      const buildLink = pe.buildUrl ? ` — [build](${pe.buildUrl})` : '';
      lines.push(`- **${pe.displayName}** — ${pe.status} (${blocking})${expired}${buildLink}`);
    }
  } else if (policyEvals === null) {
    lines.push('', '⚠️ Could not fetch policy evaluations. Use git-based checks as fallback.');
  } else {
    lines.push('', '✅ No policy evaluations found for this PR.');
  }

  // Inject pre-fetched thread summary
  const threadSummary = (cmd as SquadCommand & { _threadSummary?: PrThreadSummary | null })._threadSummary;
  if (threadSummary) {
    lines.push(
      '',
      '## Comment Threads (pre-fetched)',
      `- Total: ${threadSummary.totalThreads} (${threadSummary.activeThreads} active, ${threadSummary.resolvedThreads} resolved)`,
    );
    const activeThreads = threadSummary.threads.filter((t) => t.status === 'active' || t.status === 'pending');
    if (activeThreads.length > 0) {
      lines.push('', '### Active/Pending Threads:');
      for (const t of activeThreads) {
        const preview = t.firstComment.replace(/\n/g, ' ').slice(0, 120);
        lines.push(`- Thread #${t.id} (${t.status}) by ${t.author}: ${preview}...`);
      }
    }
  } else if (threadSummary === null) {
    lines.push('', '⚠️ Could not fetch thread summary.');
  }

  lines.push(
    '',
    'TASK: Perform one babysit cycle on this PR. This is NOT continuous monitoring — just one pass.',
    '',
    'IMPORTANT: The `az repos pr` CLI is NOT available in your environment. All ADO data has been pre-fetched above.',
    'Use git commands for branch/diff analysis. Use the pre-fetched policy and thread data for ADO state.',
    '',
    'Steps:',
    '1. Analyze the pre-fetched policy evaluations above — identify blocking/failing/expired policies',
    '2. Check if the branch needs rebasing: git fetch origin && git --no-pager log --oneline origin/{target}..origin/{source} | wc -l',
    '3. Review the pre-fetched comment thread summary — identify unresolved blocking threads',
    '4. Summarize current blocking status: what remains before merge-ready',
    '5. Provide actionable next steps for the PR author',
    '',
    'OUTPUT: Write a status report in markdown format.',
    'Include: ## Policy Status, ## Branch Status, ## Open Comments, ## Blocking Items, ## Next Steps',
    cmd.commandArgs ? `\nAdditional instructions: ${cmd.commandArgs}` : '',
  );

  return lines.join('\n');
}

/**
 * Build the agent prompt for a /squad bump command.
 */
function buildBumpPrompt(cmd: SquadCommand): string {
  const pr = cmd.prDetails;
  const lines: string[] = [
    `You are bumping PR #${cmd.prId} in the ${cmd.repoName} repository to unblock merge.`,
    `Requested by: ${cmd.author}`,
  ];

  if (pr) {
    const srcBranch = pr.sourceRefName.replace('refs/heads/', '');
    const tgtBranch = pr.targetRefName.replace('refs/heads/', '');
    lines.push(
      '',
      '## PR Details',
      `- **Title:** ${pr.title}`,
      `- **Source branch:** ${srcBranch}`,
      `- **Target branch:** ${tgtBranch}`,
      `- **Status:** ${pr.status}`,
    );
  }

  // Inject pre-fetched policy evaluations
  const policyEvals = (cmd as SquadCommand & { _policyEvals?: PolicyEvaluation[] | null })._policyEvals;
  if (policyEvals && policyEvals.length > 0) {
    lines.push('', '## Policy Evaluations (pre-fetched)');
    for (const pe of policyEvals) {
      const blocking = pe.isBlocking ? '🔒 blocking' : '📋 optional';
      const expired = pe.context === 'expired' ? ' ⏰ EXPIRED' : '';
      const buildLink = pe.buildUrl ? ` — [build](${pe.buildUrl})` : '';
      lines.push(`- **${pe.displayName}** — ${pe.status} (${blocking})${expired}${buildLink}`);
    }
  }

  lines.push(
    '',
    'TASK: Perform a one-shot bump — diagnose and resolve blockers.',
    '',
    'IMPORTANT: The `az repos pr` CLI is NOT available in your environment. All ADO data has been pre-fetched above.',
    'Use git commands for branch/diff analysis. Use the pre-fetched policy data for ADO state.',
    '',
    'Steps:',
    '1. Analyze the pre-fetched policy evaluations — identify failed/expired/broken gates',
    '2. Check for merge conflicts: git fetch origin && git merge-base --is-ancestor origin/{target} origin/{source}',
    '3. If the branch is behind, check rebase status',
    '4. Report what was found and what still blocks',
    '',
    'OUTPUT: Brief status report of blockers and recommended next steps.',
    cmd.commandArgs ? `\nAdditional instructions: ${cmd.commandArgs}` : '',
  );

  return lines.join('\n');
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

  // Step 3: Enrich with PR details (branch refs, title, description)
  if (!cmd.prDetails) {
    try {
      const details = getPrDetails(cmd.adoContext, cmd.prId);
      if (details) cmd.prDetails = details;
    } catch (e) {
      console.log(`  ⚠️ Could not enrich PR details: ${(e as Error).message}`);
    }
  }

  // Step 3b: For babysit/bump commands, pre-fetch policy evaluations and thread summary
  // since the agent sandbox blocks `az repos pr` CLI commands.
  if (cmd.commandName === 'babysit' || cmd.commandName === 'bump') {
    try {
      (cmd as SquadCommand & { _policyEvals?: PolicyEvaluation[] | null })._policyEvals =
        getPrPolicyEvaluations(cmd.adoContext, cmd.prId);
    } catch (e) {
      console.log(`  ⚠️ Could not pre-fetch policy evaluations: ${(e as Error).message}`);
    }
    try {
      (cmd as SquadCommand & { _threadSummary?: PrThreadSummary | null })._threadSummary =
        getPrThreadsSummary(cmd.adoContext, cmd.prId);
    } catch (e) {
      console.log(`  ⚠️ Could not pre-fetch thread summary: ${(e as Error).message}`);
    }
  }

  // Step 4: Build and dispatch agent — inject skills and use downstream repo cwd
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
    const remoteUrl = execFileSync(
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
  } catch (e) {
    console.log(`  \x1b[2m[resolveAdoContext] Failed for ${repoPath}: ${(e as Error).message}\x1b[0m`);
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
    } catch (e) {
      // Log but skip PRs where thread listing fails (permissions, etc.)
      console.log(`  ${'\x1b[2m'}[${repoName}] PR #${prId} thread scan error: ${(e as Error).message?.slice(0, 100)}${'\x1b[0m'}`);
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
        // For review commands: parse structured findings and post inline comments
        if (cmd.commandName === 'review' && result.output) {
          const findings = parseReviewFindings(result.output);
          if (findings.length > 0) {
            let posted = 0;
            for (const finding of findings) {
              try {
                const emoji = SEVERITY_EMOJI[finding.severity] ?? '💡';
                const header = finding.title ? `**${emoji} ${finding.title}**\n\n` : `${emoji} `;
                const body = `${header}${finding.comment}`;
                createInlineThread(
                  cmd.adoContext, cmd.prId, body,
                  finding.file, finding.line, finding.endLine, 'active',
                );
                posted++;
              } catch (e) {
                console.log(`  ⚠️ Could not post inline comment on ${finding.file}:${finding.line}: ${(e as Error).message?.slice(0, 80)}`);
              }
            }
            console.log(`  📝 Posted ${posted}/${findings.length} inline review comments`);
          }
          // Post summary (with findings JSON stripped) as thread reply
          const cleanOutput = stripFindingsBlock(result.output);
          const summary = cleanOutput ? extractSummary(cleanOutput) : '';
          const findingsNote = findings.length > 0
            ? `\n\n_📝 ${findings.length} inline comment(s) posted on specific lines._`
            : '';
          const resultMessage = summary
            ? `✅ **Squad completed:** \`/squad ${cmd.commandName}\`\n\n${truncateForComment(summary)}${findingsNote}`
            : `✅ **Squad completed:** \`/squad ${cmd.commandName}\`\n\n_Completed successfully._${findingsNote}`;

          try {
            replyToThread(cmd.adoContext, cmd.prId, cmd.threadId, resultMessage);
          } catch {
            console.log(`  ⚠️ Could not post result to PR thread`);
          }
        } else {
          // Non-review commands: post summary as before
          const summary = result.output ? extractSummary(result.output) : '';
          const resultMessage = summary
            ? `✅ **Squad completed:** \`/squad ${cmd.commandName}\`\n\n${truncateForComment(summary)}`
            : `✅ **Squad completed:** \`/squad ${cmd.commandName}\`\n\n_Completed successfully._`;

          try {
            replyToThread(cmd.adoContext, cmd.prId, cmd.threadId, resultMessage);
          } catch {
            console.log(`  ⚠️ Could not post result to PR thread`);
          }
        }

        markCommandCompleted(cmd, `Completed by squad`);
        succeeded++;
      } else {
        // Post failure to the thread — extract summary from output if available
        const failSummary = result.output ? extractSummary(result.output) : '';
        const errorMessage = `❌ **Squad failed:** \`/squad ${cmd.commandName}\`\n\n${result.error ?? 'Unknown error'}${failSummary ? '\n\n' + truncateForComment(failSummary) : ''}`;

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
/**
 * Extract the final summary from agent output, stripping verbose tool-call logs.
 *
 * Agent output typically looks like:
 *   ● command1 (shell)          ← tool-call log lines
 *   │ ...                       ← indented output
 *   └ ...
 *   ✗ command2 (shell)          ← failed tool call
 *   │ ...
 *   └ Permission denied...
 *   <blank line(s)>
 *   Review complete. TL;DR...   ← final summary (what we want)
 *
 * Strategy: walk backwards from end, collect lines until we hit a tool-call
 * log marker (●, ✗, │, └, ├) or the output is exhausted.
 */
export function extractSummary(raw: string): string {
  const lines = raw.split('\n');
  const toolCallPattern = /^[●✗✓│└├⎿]/;
  const toolHeaderPattern = /^\s*(●|✗|✓)\s+.+\(shell\)/;
  const lineCountPattern = /^└\s+\d+\s+lines?\.{3}/;

  // Walk backwards to find where the final plain-text block starts
  let summaryStart = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '') {
      // blank line — could be separator between tool output and summary
      continue;
    }
    if (toolCallPattern.test(trimmed) || toolHeaderPattern.test(trimmed) || lineCountPattern.test(trimmed)) {
      // Hit a tool-call log line — summary starts after this
      summaryStart = i + 1;
      break;
    }
    // This is a summary line — keep walking backwards
  }

  // If we walked all the way back, everything is summary (no tool markers found)
  if (summaryStart >= lines.length) summaryStart = 0;

  const summary = lines.slice(summaryStart).join('\n').trim();
  return summary || raw.trim(); // fallback to full output if extraction yields nothing
}

function truncateForComment(text: string, maxLength: number = 8000): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n\n_... (truncated — full output was ' + text.length + ' characters)_';
}

// ── Review Findings Parser ──────────────────────────────────────

export interface ReviewFinding {
  file: string;
  line: number;
  endLine?: number;
  severity: 'critical' | 'warning' | 'suggestion' | 'nitpick';
  title: string;
  comment: string;
}

/**
 * Parse structured review findings from agent output.
 *
 * The agent is prompted to emit a JSON array between markers:
 *   <!-- REVIEW_FINDINGS_START -->
 *   [ { "file": "...", "line": N, ... }, ... ]
 *   <!-- REVIEW_FINDINGS_END -->
 *
 * Returns the parsed findings array, or an empty array if not found / invalid.
 */
export function parseReviewFindings(raw: string): ReviewFinding[] {
  const startMarker = '<!-- REVIEW_FINDINGS_START -->';
  const endMarker = '<!-- REVIEW_FINDINGS_END -->';

  const startIdx = raw.indexOf(startMarker);
  const endIdx = raw.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return [];

  const jsonStr = raw.slice(startIdx + startMarker.length, endIdx).trim();
  if (!jsonStr) return [];

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (f: unknown): f is ReviewFinding =>
        typeof f === 'object' && f !== null &&
        typeof (f as Record<string, unknown>).file === 'string' &&
        typeof (f as Record<string, unknown>).line === 'number' &&
        typeof (f as Record<string, unknown>).comment === 'string',
    ).map((f: ReviewFinding) => ({
      file: f.file,
      line: f.line,
      endLine: typeof f.endLine === 'number' ? f.endLine : undefined,
      severity: (['critical', 'warning', 'suggestion', 'nitpick'] as const).includes(f.severity) ? f.severity : 'suggestion',
      title: typeof f.title === 'string' ? f.title : '',
      comment: f.comment,
    }));
  } catch {
    return [];
  }
}

/**
 * Strip the REVIEW_FINDINGS block from agent output so the summary
 * text doesn't include the raw JSON.
 */
export function stripFindingsBlock(raw: string): string {
  const startMarker = '<!-- REVIEW_FINDINGS_START -->';
  const endMarker = '<!-- REVIEW_FINDINGS_END -->';
  const startIdx = raw.indexOf(startMarker);
  const endIdx = raw.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return raw;
  return (raw.slice(0, startIdx) + raw.slice(endIdx + endMarker.length)).trim();
}

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '💡',
  nitpick: '📝',
};
