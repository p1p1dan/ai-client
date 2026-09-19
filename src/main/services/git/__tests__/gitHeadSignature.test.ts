import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// GitService -> git/runtime -> terminal/PtyManager pulls the node-pty native
// module, which is built for Electron and cannot load under a plain Node test.
vi.mock('../../terminal/PtyManager', () => ({
  getEnhancedPath: () => process.env.PATH ?? '',
}));

const { GitService } = await import('../GitService');

/**
 * T100: the git panel polls this fingerprint to notice work done outside the
 * app. What it has to get right is narrow but exact — it must move for every
 * external action the panel's history and branch list depend on (commit,
 * branch create/delete, checkout, detach), and it must NOT move otherwise, or
 * the panel refetches `git log` and `git branch -a -v` every 5 seconds forever.
 *
 * Run against a real repository on purpose: the whole value of the fingerprint
 * is which git commands it reads, and a stubbed git would agree with whatever
 * commands were written, including wrong ones. `rev-parse HEAD` in particular
 * exits non-zero on a repository with no commits, which is a normal state and
 * not a failure — the unborn case below is that boundary.
 */

let root: string;

function initRepo(name: string): string {
  const repo = path.join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  run(repo, 'config', 'user.email', 'test@example.com');
  run(repo, 'config', 'user.name', 'Test');
  return repo;
}

function run(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function commit(repo: string, file: string, body: string): void {
  writeFileSync(path.join(repo, file), body);
  run(repo, 'add', file);
  run(repo, 'commit', '-q', '-m', `add ${file}`);
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiclient-git-t100-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('getHeadSignature fingerprints where the repository points', () => {
  it('reads HEAD and its ref, and repeats itself on an untouched repository', async () => {
    const repo = initRepo('stable');
    commit(repo, 'a.txt', 'a\n');
    const service = new GitService(repo);

    const signature = await service.getHeadSignature();
    expect(signature.head).toBe(run(repo, 'rev-parse', 'HEAD').trim());
    expect(signature.ref).toBe('refs/heads/main');
    expect(signature.refs).toMatch(/^[0-9a-f]{40}$/);

    // Reading twice must not look like a change; a working-tree edit is not one
    // either, since the changed-files query already polls for those.
    writeFileSync(path.join(repo, 'a.txt'), 'edited\n');
    await expect(service.getHeadSignature()).resolves.toEqual(signature);
  });

  it('moves when a commit lands outside the app', async () => {
    const repo = initRepo('external-commit');
    commit(repo, 'a.txt', 'a\n');
    const service = new GitService(repo);
    const before = await service.getHeadSignature();

    commit(repo, 'b.txt', 'b\n');
    const after = await service.getHeadSignature();

    expect(after.head).not.toBe(before.head);
    // The branch tip moved with HEAD, so the ref digest moved too.
    expect(after.refs).not.toBe(before.refs);
    expect(after.ref).toBe('refs/heads/main');
  });

  it('moves when a branch is created outside the app, even with HEAD unchanged', async () => {
    const repo = initRepo('external-branch');
    commit(repo, 'a.txt', 'a\n');
    const service = new GitService(repo);
    const before = await service.getHeadSignature();

    run(repo, 'branch', 'feature');
    const afterCreate = await service.getHeadSignature();

    expect(afterCreate.head).toBe(before.head);
    expect(afterCreate.ref).toBe(before.ref);
    expect(afterCreate.refs).not.toBe(before.refs);

    run(repo, 'branch', '-D', 'feature');
    await expect(service.getHeadSignature()).resolves.toEqual(before);
  });

  it('moves when HEAD is checked out elsewhere or detached', async () => {
    const repo = initRepo('external-checkout');
    commit(repo, 'a.txt', 'a\n');
    run(repo, 'checkout', '-q', '-b', 'feature');
    commit(repo, 'b.txt', 'b\n');
    const service = new GitService(repo);
    const onFeature = await service.getHeadSignature();

    run(repo, 'checkout', '-q', 'main');
    const onMain = await service.getHeadSignature();
    expect(onMain.ref).toBe('refs/heads/main');
    expect(onMain.head).not.toBe(onFeature.head);
    // Neither branch moved, only HEAD: the ref digest alone would miss this.
    expect(onMain.refs).toBe(onFeature.refs);

    run(repo, 'checkout', '-q', '--detach', 'feature');
    const detached = await service.getHeadSignature();
    // "HEAD" is what git prints for a detached head; it is not a ref name.
    expect(detached.ref).toBeNull();
    expect(detached.head).toBe(onFeature.head);
  });

  it('answers for an unborn HEAD instead of failing', async () => {
    const repo = initRepo('unborn');
    const service = new GitService(repo);

    await expect(service.getHeadSignature()).resolves.toEqual({
      head: null,
      ref: null,
      // sha1 of the empty `for-each-ref` listing — a real, comparable value, so
      // the first commit in a fresh repository still registers as a change.
      refs: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    });

    commit(repo, 'a.txt', 'a\n');
    const born = await service.getHeadSignature();
    expect(born.head).not.toBeNull();
    expect(born.ref).toBe('refs/heads/main');
  });
});
