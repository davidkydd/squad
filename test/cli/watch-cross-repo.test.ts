/**
 * Cross-repo watch config tests — validates the repos config parsing
 * and cross-repo adapter resolution logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStorage } = vi.hoisted(() => ({
  mockStorage: {
    existsSync: vi.fn(() => true),
    readSync: vi.fn(() => null),
    listSync: vi.fn((): string[] => []),
  },
}));

vi.mock('@bradygaster/squad-sdk', () => ({
  FSStorageProvider: vi.fn(() => mockStorage),
}));

import { loadWatchConfig } from '../../packages/squad-cli/src/cli/commands/watch/config.js';
import type { CrossRepoEntry } from '../../packages/squad-cli/src/cli/commands/watch/config.js';

describe('Cross-repo watch config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.existsSync.mockReturnValue(true);
  });

  it('parses repos array from config.json watch section', () => {
    mockStorage.readSync.mockReturnValue(JSON.stringify({
      watch: {
        interval: 5,
        repos: [
          { name: 'prometheus-extensions', path: '../prometheus-extensions' },
          { name: 'aks-vm-extension', path: '/absolute/path/aks-vm-extension' },
        ],
      },
    }));

    const config = loadWatchConfig('/fake/team-root', {});
    expect(config.repos).toBeDefined();
    expect(config.repos).toHaveLength(2);
    expect(config.repos![0]).toEqual({ name: 'prometheus-extensions', path: '../prometheus-extensions' });
    expect(config.repos![1]).toEqual({ name: 'aks-vm-extension', path: '/absolute/path/aks-vm-extension' });
  });

  it('ignores malformed repo entries', () => {
    mockStorage.readSync.mockReturnValue(JSON.stringify({
      watch: {
        repos: [
          { name: 'valid', path: '/valid/path' },
          { name: 123, path: '/bad' },         // name is not string
          { path: '/no-name' },                 // missing name
          'just-a-string',                      // not an object
        ],
      },
    }));

    const config = loadWatchConfig('/fake/team-root', {});
    expect(config.repos).toHaveLength(1);
    expect(config.repos![0]!.name).toBe('valid');
  });

  it('returns undefined repos when not configured', () => {
    mockStorage.readSync.mockReturnValue(JSON.stringify({
      watch: { interval: 5 },
    }));

    const config = loadWatchConfig('/fake/team-root', {});
    expect(config.repos).toBeUndefined();
  });

  it('CLI override repos take precedence over file config', () => {
    mockStorage.readSync.mockReturnValue(JSON.stringify({
      watch: {
        repos: [{ name: 'from-file', path: '/file' }],
      },
    }));

    const cliRepos: CrossRepoEntry[] = [{ name: 'from-cli', path: '/cli' }];
    const config = loadWatchConfig('/fake/team-root', { repos: cliRepos });
    expect(config.repos).toHaveLength(1);
    expect(config.repos![0]!.name).toBe('from-cli');
  });

  it('does not treat repos as a capability key', () => {
    mockStorage.readSync.mockReturnValue(JSON.stringify({
      watch: {
        repos: [{ name: 'test', path: '/test' }],
        board: true,
      },
    }));

    const config = loadWatchConfig('/fake/team-root', {});
    expect(config.capabilities['repos']).toBeUndefined();
    expect(config.capabilities['board']).toBe(true);
    expect(config.repos).toHaveLength(1);
  });
});
