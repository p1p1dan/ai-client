/**
 * `git:branch:create` / `git:branch:checkout` must FAIL outside a repository.
 *
 * Both used to return normally when the directory was not a git repository,
 * which the renderer reads as success: the composer's branch column showed a
 * new branch or a switch that never happened. Readers may answer "nothing
 * here" for a non-repository; a mutation may not.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null, fromId: () => null, getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
}));

// GitService -> git/runtime -> terminal/PtyManager pulls the node-pty native
// module, which is built for Electron and cannot load under a plain Node test.
vi.mock('../../services/terminal/PtyManager', () => ({
  getEnhancedPath: () => process.env.PATH ?? '',
}));
vi.mock('../../services/ai', () => ({
  generateBranchName: vi.fn(),
  generateCommitMessage: vi.fn(),
  startCodeReview: vi.fn(),
  stopCodeReview: vi.fn(),
}));
vi.mock('../../services/git/GitAutoFetchService', () => ({ gitAutoFetchService: {} }));
vi.mock('../../services/remote/RemoteRepositoryBackend', () => ({ remoteRepositoryBackend: {} }));

const { registerGitHandlers } = await import('../git');

let root: string;

beforeAll(() => {
  registerGitHandlers();
  root = mkdtempSync(path.join(tmpdir(), 'git-branch-guard-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function handler(channel: string): Handler {
  const found = handlers.get(channel);
  if (!found) throw new Error(`no handler for ${channel}`);
  return found;
}

describe('branch mutations outside a git repository', () => {
  it('create-branch rejects instead of resolving as if it had worked', async () => {
    const plain = mkdtempSync(path.join(root, 'plain-'));
    await expect(handler(IPC_CHANNELS.GIT_BRANCH_CREATE)({}, plain, 'topic')).rejects.toThrow(
      /Not a git repository/
    );
  });

  it('checkout rejects instead of resolving as if it had worked', async () => {
    const plain = mkdtempSync(path.join(root, 'plain-'));
    await expect(handler(IPC_CHANNELS.GIT_BRANCH_CHECKOUT)({}, plain, 'main')).rejects.toThrow(
      /Not a git repository/
    );
  });

  it('still creates and switches branches in a real repository', async () => {
    const repo = path.join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const run = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    run('add', 'a.txt');
    run('commit', '-q', '-m', 'first');

    await handler(IPC_CHANNELS.GIT_BRANCH_CREATE)({}, repo, 'topic');
    expect(run('rev-parse', '--abbrev-ref', 'HEAD')).toBe('topic');

    await handler(IPC_CHANNELS.GIT_BRANCH_CHECKOUT)({}, repo, 'main');
    expect(run('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });
});
