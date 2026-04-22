/**
 * Shared platform-aware preflight check for watch capabilities.
 *
 * Replaces hard-coded `gh --version` checks with platform detection:
 * - GitHub repos → check `gh` CLI
 * - Azure DevOps repos → check `az` CLI
 */

import { execFile } from 'node:child_process';
import type { WatchContext, PreflightResult } from '../types.js';

/** Check that the CLI for the current platform is available. */
export function checkPlatformCli(context: WatchContext): Promise<PreflightResult> {
  const platform = context.adapter.type;

  if (platform === 'azure-devops') {
    return new Promise<PreflightResult>((resolve) => {
      execFile('az', ['devops', '-h'], (err) => {
        resolve(err
          ? { ok: false, reason: 'az CLI not found — install from https://aka.ms/install-az-cli' }
          : { ok: true });
      });
    });
  }

  // Default: GitHub
  return new Promise<PreflightResult>((resolve) => {
    execFile('gh', ['--version'], (err) => {
      resolve(err
        ? { ok: false, reason: 'gh CLI not found — install from https://cli.github.com' }
        : { ok: true });
    });
  });
}

/**
 * Resolve the default agent command based on platform.
 * GitHub: 'copilot' (GitHub Copilot CLI)
 * ADO: no default — requires --agent-cmd (e.g., 'agency copilot')
 */
export function defaultAgentCmd(context: WatchContext): string | undefined {
  if (context.agentCmd) return undefined; // user override takes precedence
  if (context.adapter.type === 'azure-devops') return undefined; // no default for ADO
  return undefined; // GitHub default is handled by buildAgentCommand fallback
}

/**
 * Determine the requires array based on platform type.
 * Used for informational display when preflight fails.
 */
export function platformRequires(context: WatchContext): string[] {
  return context.adapter.type === 'azure-devops' ? ['az'] : ['gh'];
}
