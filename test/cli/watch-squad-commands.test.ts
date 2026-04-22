/**
 * Tests for /squad command parsing and state management.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findSquadCommands, type PullRequestThread, type AdoContext } from '../../packages/squad-cli/src/cli/commands/watch/capabilities/ado-pr-threads.js';

const mockAdoCtx: AdoContext = {
  org: 'msazure',
  project: 'CloudNativeCompute',
  repoName: 'aks-operator',
  repoId: 'test-repo-id-123',
};

function makeThread(id: number, rootContent: string, author: string = 'Test User'): PullRequestThread {
  return {
    id,
    status: 'active',
    publishedDate: new Date().toISOString(),
    lastUpdatedDate: new Date().toISOString(),
    comments: [{
      id: 1,
      parentCommentId: 0,
      content: rootContent,
      publishedDate: new Date().toISOString(),
      lastUpdatedDate: new Date().toISOString(),
      author: { displayName: author, uniqueName: 'testuser@microsoft.com' },
      commentType: 'text',
    }],
  };
}

describe('/squad command parsing', () => {
  it('finds a /squad review command', () => {
    const threads = [makeThread(1, '/squad review')];
    const cmds = findSquadCommands(threads, 123, 'aks-operator', mockAdoCtx);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.commandName).toBe('review');
    expect(cmds[0]!.commandArgs).toBe('');
    expect(cmds[0]!.prId).toBe(123);
    expect(cmds[0]!.threadId).toBe(1);
  });

  it('finds a /squad babysit command', () => {
    const threads = [makeThread(2, '/squad babysit until merge')];
    const cmds = findSquadCommands(threads, 456, 'aks-operator', mockAdoCtx);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.commandName).toBe('babysit');
    expect(cmds[0]!.commandArgs).toBe('until merge');
  });

  it('finds a freeform /squad command', () => {
    const threads = [makeThread(3, '/squad research if this change fixes the IcM issue')];
    const cmds = findSquadCommands(threads, 789, 'aks-operator', mockAdoCtx);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.commandName).toBe('research');
    expect(cmds[0]!.rawCommand).toBe('research if this change fixes the IcM issue');
  });

  it('skips threads without /squad prefix', () => {
    const threads = [
      makeThread(1, 'Nice PR, looks good!'),
      makeThread(2, 'LGTM'),
      makeThread(3, 'squad review please'),  // no slash
    ];
    const cmds = findSquadCommands(threads, 123, 'aks-operator', mockAdoCtx);
    expect(cmds).toHaveLength(0);
  });

  it('skips already-processed commands (✅ marker)', () => {
    const threads = [makeThread(1, '✅ /squad review\n\n_Completed at 2025-01-01_')];
    const cmds = findSquadCommands(threads, 123, 'aks-operator', mockAdoCtx);
    expect(cmds).toHaveLength(0);
  });

  it('skips in-progress commands (⏳ marker)', () => {
    const threads = [makeThread(1, '⏳ /squad review\n\n_Processing — squad acknowledged_')];
    const cmds = findSquadCommands(threads, 123, 'aks-operator', mockAdoCtx);
    expect(cmds).toHaveLength(0);
  });

  it('finds multiple commands across threads', () => {
    const threads = [
      makeThread(1, '/squad review'),
      makeThread(2, 'Regular comment'),
      makeThread(3, '/squad bump'),
      makeThread(4, '✅ /squad status\n\n_Completed_'),  // already done
    ];
    const cmds = findSquadCommands(threads, 123, 'aks-operator', mockAdoCtx);
    expect(cmds).toHaveLength(2);
    expect(cmds[0]!.commandName).toBe('review');
    expect(cmds[1]!.commandName).toBe('bump');
  });

  it('skips threads with empty comments', () => {
    const threads: PullRequestThread[] = [{
      id: 1,
      status: 'active',
      publishedDate: new Date().toISOString(),
      lastUpdatedDate: new Date().toISOString(),
      comments: [],
    }];
    const cmds = findSquadCommands(threads, 123, 'aks-operator', mockAdoCtx);
    expect(cmds).toHaveLength(0);
  });

  it('captures author from the command comment', () => {
    const threads = [makeThread(1, '/squad investigate the failing build', 'David Kydd')];
    const cmds = findSquadCommands(threads, 123, 'aks-operator', mockAdoCtx);
    expect(cmds[0]!.author).toBe('David Kydd');
  });

  it('is case-insensitive for the /squad prefix', () => {
    const threads = [makeThread(1, '/Squad Review this PR')];
    const cmds = findSquadCommands(threads, 123, 'aks-operator', mockAdoCtx);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.commandName).toBe('review');
  });

  it('handles /squad with extra whitespace', () => {
    const threads = [makeThread(1, '/squad   review   with extra spaces')];
    const cmds = findSquadCommands(threads, 123, 'aks-operator', mockAdoCtx);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.commandName).toBe('review');
    expect(cmds[0]!.commandArgs).toBe('with extra spaces');
  });
});
