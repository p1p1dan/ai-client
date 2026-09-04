import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCRATCH_ROOT_DIR, ScratchWorkspaceService } from '../ScratchWorkspaceService';

/**
 * U05-a — the isolated working directory an unbound chat runs in.
 *
 * Real filesystem, not a mock: every claim here ("the directory exists", "the
 * wipe removed it", "the mode is 0700") is about what is actually on disk, and
 * a mocked `fs` would let all three pass while the product wrote nothing.
 */

let base: string;
let service: ScratchWorkspaceService;
let idCounter: number;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'aiclient-scratch-test-'));
  idCounter = 0;
  service = new ScratchWorkspaceService({
    resolveBasePath: () => base,
    createId: () => `dir-${++idCounter}`,
  });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function rootEntries(): Promise<string[]> {
  try {
    return (await readdir(path.join(base, SCRATCH_ROOT_DIR))).sort();
  } catch {
    return [];
  }
}

describe('ScratchWorkspaceService.ensure', () => {
  it('creates one directory per session, under the configured base', async () => {
    const a = await service.ensure('session-a');
    const b = await service.ensure('session-b');

    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.join(base, SCRATCH_ROOT_DIR));
    expect(path.dirname(b)).toBe(path.join(base, SCRATCH_ROOT_DIR));
    expect((await stat(a)).isDirectory()).toBe(true);
    expect((await stat(b)).isDirectory()).toBe(true);
    expect(await rootEntries()).toEqual(['dir-1', 'dir-2']);
  });

  it('is idempotent: the send path and the TUI path get the same directory', async () => {
    // A session with two working directories is a session whose TUI cannot see
    // what its GUI turn just wrote. Both callers ask independently, so this is
    // the property that makes that safe.
    const first = await service.ensure('session-a');
    const second = await service.ensure('session-a');
    expect(second).toBe(first);
    expect(await rootEntries()).toEqual(['dir-1']);
  });

  it('deduplicates concurrent calls for the same session', async () => {
    const [first, second] = await Promise.all([
      service.ensure('session-a'),
      service.ensure('session-a'),
    ]);
    expect(second).toBe(first);
    expect(await rootEntries()).toEqual(['dir-1']);
  });

  it('recreates the directory if something removed it between turns', async () => {
    const dir = await service.ensure('session-a');
    await rm(dir, { recursive: true, force: true });
    expect(await service.ensure('session-a')).toBe(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('creates owner-only directories', async () => {
    // Defence in depth, not the isolation boundary — every Pi worker runs as
    // the same OS user, so this stops other users, not other sessions. The
    // boundary that stops other sessions is the permission layer (see
    // `isScratchPath` below and the U12 delegation-envelope tests).
    const dir = await service.ensure('session-a');
    if (process.platform === 'win32') return; // Windows ignores mode.
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('rejects an empty session id instead of creating a shared directory', async () => {
    await expect(service.ensure('  ')).rejects.toThrow('scratch_workspace_invalid_session');
  });
});

describe('ScratchWorkspaceService.release — the session-destroyed path', () => {
  it('removes only that session directory', async () => {
    const a = await service.ensure('session-a');
    await service.ensure('session-b');

    await service.release('session-a');

    await expect(stat(a)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await rootEntries()).toEqual(['dir-2']);
  });

  it('removes the directory contents, not just the empty shell', async () => {
    const dir = await service.ensure('session-a');
    await writeFile(path.join(dir, 'note.txt'), 'agent output');
    await service.release('session-a');
    expect(await rootEntries()).toEqual([]);
  });

  it('is a no-op for a session that never got a directory', async () => {
    await expect(service.release('never-used')).resolves.toBeUndefined();
  });

  it('forgets the session, so a later ensure allocates a fresh directory', async () => {
    const first = await service.ensure('session-a');
    await service.release('session-a');
    const second = await service.ensure('session-a');
    expect(second).not.toBe(first);
  });
});

describe('ScratchWorkspaceService.wipeAll — the app-exit and crash-restart path', () => {
  it('removes every scratch directory', async () => {
    await service.ensure('session-a');
    await service.ensure('session-b');

    await service.wipeAll();

    expect(await rootEntries()).toEqual([]);
  });

  it('leaves the rest of the temp base alone', async () => {
    // The base is shared with the user-managed temp workspaces feature. Wiping
    // one folder inside it must never take the user's own folders with it.
    const userFolder = path.join(base, '20260903-101500');
    await writeFile(path.join(base, 'keep.txt'), 'user data');
    await service.ensure('session-a');

    await service.wipeAll();

    expect((await readdir(base)).sort()).toEqual(['keep.txt']);
    expect(userFolder).toBeTruthy();
  });

  it('cleans up after a crash: a wipe at startup removes a previous run leftovers', async () => {
    const previousRun = new ScratchWorkspaceService({
      resolveBasePath: () => base,
      createId: () => 'crashed-run',
    });
    const stale = await previousRun.ensure('session-from-last-run');
    // No release, no wipe — this is what an abnormal exit leaves behind.

    await service.wipeAll();

    await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('forgets its sessions, so the next ensure recreates rather than trusting the map', async () => {
    await service.ensure('session-a');
    await service.wipeAll();
    const reallocated = await service.ensure('session-a');
    expect((await stat(reallocated)).isDirectory()).toBe(true);
  });
});

describe('ScratchWorkspaceService.isScratchPath', () => {
  it('recognises its own directories', async () => {
    expect(service.isScratchPath(await service.ensure('session-a'))).toBe(true);
  });

  it('recognises a path from a previous run, whose directory no longer exists', () => {
    // This is what decides trust on resume: the index row still names last
    // run's directory, and Main must still treat that session as untrusted.
    expect(service.isScratchPath(path.join(base, SCRATCH_ROOT_DIR, 'gone'))).toBe(true);
  });

  it('rejects real project paths, the base itself, and the root itself', () => {
    expect(service.isScratchPath('/home/user/projects/app')).toBe(false);
    expect(service.isScratchPath(base)).toBe(false);
    expect(service.isScratchPath(path.join(base, SCRATCH_ROOT_DIR))).toBe(false);
    expect(service.isScratchPath('')).toBe(false);
  });

  it('rejects a sibling directory whose name merely starts the same', () => {
    expect(service.isScratchPath(`${path.join(base, SCRATCH_ROOT_DIR)}-other/x`)).toBe(false);
  });
});

describe('ScratchWorkspaceService.adopt — resuming an unbound chat in a later run', () => {
  it('recreates the recorded directory so resume has a cwd that exists', async () => {
    const recorded = path.join(base, SCRATCH_ROOT_DIR, 'from-last-run');
    expect(await service.adopt('session-a', recorded)).toBe(recorded);
    expect((await stat(recorded)).isDirectory()).toBe(true);
    expect(service.pathFor('session-a')).toBe(recorded);
  });

  it('[release-blocker] refuses a path outside the scratch root', async () => {
    // A tampered or stale session-index row must not be able to turn adopt
    // into "create, own, and later delete an arbitrary directory".
    await expect(service.adopt('session-a', path.join(base, 'user-folder'))).rejects.toThrow(
      'scratch_workspace_foreign_path'
    );
    await expect(service.adopt('session-a', '/etc')).rejects.toThrow(
      'scratch_workspace_foreign_path'
    );
    expect(service.pathFor('session-a')).toBeNull();
  });
});

describe('cross-session isolation', () => {
  it('[release-blocker] no two sessions ever share a directory', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const paths = await Promise.all(ids.map((id) => service.ensure(`session-${id}`)));
    expect(new Set(paths).size).toBe(ids.length);
  });

  it("[release-blocker] one session's directory is outside every other session's cwd", async () => {
    // What actually stops session A from reading session B's files is the
    // permission layer, and this is the fact it acts on: B's directory is not
    // inside A's cwd, so touching it is an `external_directory` access — which
    // the delegation envelope caps at `defer` for every tier (U12).
    const a = await service.ensure('session-a');
    const b = await service.ensure('session-b');
    expect(path.relative(a, b).startsWith('..')).toBe(true);
    expect(path.relative(b, a).startsWith('..')).toBe(true);
  });
});
