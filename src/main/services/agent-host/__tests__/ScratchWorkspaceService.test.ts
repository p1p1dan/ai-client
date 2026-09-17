import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * main-aux-01 — the guard used to compare canonicalised strings by prefix, and
 * that key never resolves `..`. Every form below therefore started the root's
 * own name, passed as "one of ours", and handed `adopt` a directory outside the
 * root to create and `release` the same directory to remove recursively.
 */
describe('[release-blocker] paths that escape the scratch root through ..', () => {
  /** The same outside directory, written three ways a stored row could hold. */
  function escapingForms(outsideName: string): string[] {
    const root = path.join(base, SCRATCH_ROOT_DIR);
    const sep = path.sep;
    return [
      `${root}${sep}..${sep}${outsideName}`,
      `${root}${sep}.${sep}..${sep}${outsideName}`,
      `${root}${sep}a${sep}..${sep}..${sep}${outsideName}`,
    ];
  }

  it('does not recognise them as scratch directories', () => {
    for (const candidate of escapingForms('user-folder')) {
      expect(service.isScratchPath(candidate)).toBe(false);
    }
  });

  it('refuses adopt without touching the filesystem, so release can never remove it', async () => {
    const outside = path.join(base, 'user-folder');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'important.txt'), 'user data');

    for (const candidate of escapingForms('user-folder')) {
      await expect(service.adopt('session-a', candidate)).rejects.toThrow(
        'scratch_workspace_foreign_path'
      );
    }

    expect(service.pathFor('session-a')).toBeNull();
    // The archive path is what would have deleted it: release only ever removes
    // a directory adopt took ownership of.
    await service.release('session-a');
    expect((await readdir(outside)).sort()).toEqual(['important.txt']);
    expect(await rootEntries()).toEqual([]);
  });

  it('refuses adopt for a directory that does not exist yet, rather than creating it', async () => {
    const [candidate] = escapingForms('never-created');

    await expect(service.adopt('session-a', candidate)).rejects.toThrow(
      'scratch_workspace_foreign_path'
    );

    await expect(stat(path.join(base, 'never-created'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/**
 * main-aux-03 — the temp base is a user setting and `rootPath()` re-reads it on
 * every call, so changing it in Settings moved the root out from under every
 * directory already allocated: the exit wipe stopped covering them and resume
 * stopped recognising them as scratch (which is the bit that starts a session
 * without project trust).
 */
describe('when the user changes the temp base path mid-run', () => {
  let movedBase: string;
  let moving: ScratchWorkspaceService;
  let currentBase: string;

  beforeEach(async () => {
    movedBase = await mkdtemp(path.join(os.tmpdir(), 'aiclient-scratch-moved-'));
    currentBase = base;
    let counter = 0;
    moving = new ScratchWorkspaceService({
      resolveBasePath: () => currentBase,
      createId: () => `dir-${++counter}`,
    });
  });

  afterEach(async () => {
    await rm(movedBase, { recursive: true, force: true });
  });

  it('still recognises a directory allocated under the previous root', async () => {
    const allocated = await moving.ensure('session-a');
    currentBase = movedBase;

    // False here is what silently upgraded the session to project trust on the
    // next resume, and what made `ensure` hand it a SECOND working directory.
    expect(moving.isScratchPath(allocated)).toBe(true);
    expect(await moving.adopt('session-b', allocated)).toBe(allocated);
  });

  it('wipes the previous root as well, so its directories do not outlive the app', async () => {
    const stale = await moving.ensure('session-a');
    currentBase = movedBase;
    const fresh = await moving.ensure('session-b');

    await moving.wipeAll();

    await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(fresh)).rejects.toMatchObject({ code: 'ENOENT' });
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

it('keeps an explicitly inherited directory until both sessions release it', async () => {
  const inherited = await service.ensure('old');
  await service.adopt('new', inherited);
  await service.release('old');
  expect((await stat(inherited)).isDirectory()).toBe(true);
  expect(service.pathFor('new')).toBe(inherited);
  await service.release('new');
  await expect(stat(inherited)).rejects.toThrow();
});

/**
 * T066 (D14) — the removal used to happen in complete silence.
 *
 * Archiving a temp chat while its turn was running deleted the directory with
 * no line anywhere, so "the cleanup ran" and "the cleanup was never reached"
 * read the same afterwards. The two outcomes are told apart here because they
 * are told apart in the log: a directory two sessions share is KEPT, and that
 * is not a failure worth a warning — it is the other half of the milestone.
 */
describe('release reports what it did (T066)', () => {
  let logged: string[];
  let reporting: ScratchWorkspaceService;

  beforeEach(() => {
    logged = [];
    reporting = new ScratchWorkspaceService({
      resolveBasePath: () => base,
      createId: () => `dir-${++idCounter}`,
      log: (...args: unknown[]) => logged.push(args.map(String).join(' ')),
    });
  });

  it('logs one line naming the session whose directory it removed', async () => {
    const target = await reporting.ensure('session-a');

    await reporting.release('session-a');

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('[scratch] Released');
    expect(logged[0]).toContain('session-a');
    expect(logged[0]).toContain(path.basename(target));
  });

  it('says so instead when another session still runs in the same directory', async () => {
    const inherited = await reporting.ensure('old');
    await reporting.adopt('new', inherited);

    await reporting.release('old');

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('another session still uses it');
    expect(logged[0]).not.toContain('Released');
  });

  it('says nothing about a session that never had a directory', async () => {
    await reporting.release('session-never-allocated');

    expect(logged).toEqual([]);
  });

  it('reports a failed removal on the warn channel, with the path redacted', async () => {
    // `rm` fails on a path the service still owns: the anomaly has to survive
    // the shipped log level, which is what separates it from the milestones.
    const homeLike = path.join(base, 'home', 'tester');
    await mkdir(homeLike, { recursive: true });
    const failing = new ScratchWorkspaceService({
      resolveBasePath: () => homeLike,
      createId: () => 'dir-x',
      log: (...args: unknown[]) => logged.push(args.map(String).join(' ')),
    });
    const target = await failing.ensure('session-a');
    // A directory whose parent is read-only cannot be unlinked; skip where the
    // test runs as root, which ignores the mode.
    await chmod(path.dirname(target), 0o500);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await failing.release('session-a');
      if (process.getuid?.() === 0) return;
      expect(warn).toHaveBeenCalledTimes(1);
      // T066 回炉: ONE argument. The redaction used to cover the first one
      // while the raw `error` rode along as a second, and electron-log writes
      // every argument it is handed — so the fs error's own copy of the path
      // (`EACCES: permission denied, rmdir '/home/<name>/…'`) went to disk
      // unredacted. Asserting the joined arguments is what catches that.
      expect(warn.mock.calls[0]).toHaveLength(1);
      const line = warn.mock.calls[0].map(String).join(' ');
      expect(line).toContain('[scratch] Failed to remove');
      expect(line).not.toContain('/home/tester');
      // The reason still reaches the log — redacting it must not silence it.
      expect(line).toMatch(/Error: \w+/);
    } finally {
      warn.mockRestore();
      await chmod(path.dirname(target), 0o700);
    }
  });
});
