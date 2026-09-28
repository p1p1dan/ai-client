import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectOrphanSessions,
  type GcFileSystem,
  type GcPersistence,
  type GcSessionHeader,
} from '../sessionGc.ts';

/**
 * dsh-rebase P1-3d — GC-02: the host's orphan collection (decision 024) over a
 * real temporary DSH_HOME and a fake `sessionPersistence`. Only the rules are
 * exercised here; the real engine is exercised by the shared-host integration
 * test.
 */

const NOW = 1_790_000_000_000;
const DAY = 24 * 60 * 60_000;
const OLD = NOW - 2 * DAY;
const SETUP = ['permission/preset', 'sandbox/mode', 'approval/policy'];
const PROJECT = '--work-repo--';

interface FakeSession {
  header: GcSessionHeader;
  events: string[];
  /** A writer elsewhere holds it: write opens refuse. */
  locked?: boolean;
  /** Created in the host, not on disk: listed without a size, no directory. */
  pending?: boolean;
  sizeBytes?: number;
  /** What a write open reads, when it differs from a read open. */
  eventsUnderLock?: string[];
}

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiclient-gc-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const sessionDir = (id: string) => join(home, 'sessions', PROJECT, id);
const stubFile = (id: string) => join(home, 'aiclient-sessions', `${id}.dsh.json`);
const grantsFile = (id: string) => join(home, 'aiclient-sessions', `${id}.dsh.grants.json`);

function writeStub(name: string, body: Record<string, unknown> | string): void {
  mkdirSync(join(home, 'aiclient-sessions'), { recursive: true });
  writeFileSync(
    join(home, 'aiclient-sessions', name),
    typeof body === 'string' ? body : JSON.stringify(body)
  );
}

function fakePersistence(sessions: FakeSession[]) {
  const opened: Array<{ id: string; access: string; closed: boolean }> = [];
  for (const session of sessions) {
    if (session.pending) continue;
    mkdirSync(sessionDir(session.header.id), { recursive: true });
    writeFileSync(join(sessionDir(session.header.id), 'session.v4.jsonl.zstd'), 'log');
    writeFileSync(join(sessionDir(session.header.id), 'session.lock'), '');
  }
  const persistence: GcPersistence = {
    list: vi.fn(async () =>
      sessions
        .filter((session) => session.pending || existsSync(sessionDir(session.header.id)))
        .map((session) => ({
          header: session.header,
          ...(session.pending ? {} : { sizeBytes: session.sizeBytes ?? 308 }),
        }))
    ),
    open: vi.fn(async (id: string, access: 'read' | 'write') => {
      const session = sessions.find((candidate) => candidate.header.id === id);
      if (!session) throw Object.assign(new Error(id), { name: 'SessionPersistenceNotFoundError' });
      if (access === 'write' && session.locked) {
        throw Object.assign(new Error(`${id} is owned`), { name: 'SessionAlreadyOwnedError' });
      }
      const record = { id, access, closed: false };
      opened.push(record);
      const events =
        access === 'write' ? (session.eventsUnderLock ?? session.events) : session.events;
      return {
        read: async (offset = 0, length = Number.MAX_SAFE_INTEGER) => ({
          events: events.slice(offset, offset + length).map((type) => ({ type })),
        }),
        close: async () => {
          record.closed = true;
        },
      };
    }),
    locate: (header: GcSessionHeader) => ({
      kind: 'jsonl',
      path: join(home, 'sessions', PROJECT, header.id, 'session.v4.jsonl.zstd'),
    }),
  };
  return { persistence, opened };
}

/** Real file system, every mutation on record in order. */
function recordingFs() {
  const ops: string[] = [];
  const fs: GcFileSystem = {
    lstat,
    readdir: (path) => readdir(path),
    readFile: (path, encoding) => readFile(path, encoding),
    stat,
    rm: async (path, options) => {
      ops.push(`rm ${path.slice(home.length)}`);
      await rm(path, options);
    },
    unlink: async (path) => {
      ops.push(`unlink ${path.slice(home.length)}`);
      await unlink(path);
    },
  };
  return { fs, ops };
}

const session = (id: string, extra: Partial<FakeSession> = {}): FakeSession => ({
  header: { id, createdAt: OLD, cwd: '/work/repo' },
  events: SETUP,
  ...extra,
});

function run(persistence: GcPersistence, claimed: string[] = [], fs?: GcFileSystem, graceMs = DAY) {
  return collectOrphanSessions({ persistence, home, now: () => NOW, fs }, { claimed, graceMs });
}

describe('sessionGc — what goes (GC-02)', () => {
  it('deletes an old, unclaimed, setup-only session: its log, then its directory with the lock, then its stub', async () => {
    const { persistence, opened } = fakePersistence([session('aiclient-empty')]);
    writeStub('aiclient-empty.dsh.json', { dshSessionId: 'aiclient-empty', cwd: '/work/repo' });
    const { fs, ops } = recordingFs();
    const result = await run(persistence, [], fs);
    expect(result).toMatchObject({
      ok: true,
      deleted: ['aiclient-empty'],
      stubsDeleted: 1,
      skipped: {},
    });
    expect(existsSync(sessionDir('aiclient-empty'))).toBe(false);
    expect(existsSync(stubFile('aiclient-empty'))).toBe(false);
    // Never a lock file on its own: the log goes first, the lock only with its directory.
    expect(ops).toEqual([
      'unlink /sessions/--work-repo--/aiclient-empty/session.v4.jsonl.zstd',
      'rm /sessions/--work-repo--/aiclient-empty',
      'unlink /aiclient-sessions/aiclient-empty.dsh.json',
    ]);
    // Read lock-free first, then deleted under the write lock, both closed.
    expect(opened.map((item) => [item.access, item.closed])).toEqual([
      ['read', true],
      ['write', true],
    ]);
    // The project directory stays: another session may be created in it right now.
    expect(existsSync(join(home, 'sessions', PROJECT))).toBe(true);
  });

  it('counts a session with no event at all as empty too', async () => {
    const { persistence } = fakePersistence([session('aiclient-bare', { events: [] })]);
    expect((await run(persistence)).deleted).toEqual(['aiclient-bare']);
  });

  it('keeps a stub that names another session, while deleting the session', async () => {
    const { persistence } = fakePersistence([session('aiclient-empty')]);
    writeStub('aiclient-empty.dsh.json', { dshSessionId: 'aiclient-other', cwd: '/work/repo' });
    // The stub's grants belong to the chat it names now, and stay with it.
    writeStub('aiclient-empty.dsh.grants.json', '{"version":2,"grants":[]}');
    const result = await run(persistence, ['aiclient-other']);
    expect(result.deleted).toEqual(['aiclient-empty']);
    expect(result.stubsDeleted).toBe(0);
    expect(existsSync(stubFile('aiclient-empty'))).toBe(true);
    expect(existsSync(grantsFile('aiclient-empty'))).toBe(true);
  });

  it("deletes a session's grants with its stub, just before it (P1-6c, decision 043)", async () => {
    const { persistence } = fakePersistence([session('aiclient-empty')]);
    writeStub('aiclient-empty.dsh.json', { dshSessionId: 'aiclient-empty', cwd: '/work/repo' });
    writeStub('aiclient-empty.dsh.grants.json', '{"version":2,"grants":[]}');
    const { fs, ops } = recordingFs();
    const result = await run(persistence, [], fs);
    expect(result).toMatchObject({ deleted: ['aiclient-empty'], stubsDeleted: 1 });
    expect(ops.slice(-2)).toEqual([
      'unlink /aiclient-sessions/aiclient-empty.dsh.grants.json',
      'unlink /aiclient-sessions/aiclient-empty.dsh.json',
    ]);
    expect(readdirSync(join(home, 'aiclient-sessions'))).toEqual([]);
  });
});

describe('sessionGc — grants whose stub is gone (P1-6c)', () => {
  function writeGrants(id: string, mtime: number): void {
    writeStub(`${id}.dsh.grants.json`, '{"version":2,"grants":[]}');
    utimesSync(grantsFile(id), new Date(mtime), new Date(mtime));
  }

  it('deletes them past the grace, claimed by nobody; keeps every other kind', async () => {
    const { persistence } = fakePersistence([session('aiclient-live', { locked: true })]);
    // A staged fork Main's startup sweep took: stub and marker gone, grants left.
    writeGrants('aiclient-swept', OLD);
    writeGrants('aiclient-fresh', NOW - 60_000);
    writeGrants('aiclient-claimed', OLD);
    // A session DSH still lists: a create that finds it reopens it with these.
    writeGrants('aiclient-live', OLD);
    // Beside a stub that stays: judged with the stub.
    writeStub('aiclient-kept.dsh.json', {
      dshSessionId: 'aiclient-kept',
      cwd: '/work/repo',
      createdAt: OLD,
    });
    writeGrants('aiclient-kept', OLD);
    writeGrants('other-client', OLD);
    const log = vi.fn();
    const result = await collectOrphanSessions(
      { persistence, home, now: () => NOW, log },
      { claimed: ['aiclient-claimed', 'aiclient-kept'], graceMs: DAY }
    );
    expect(result).toMatchObject({ deleted: [], stubsDeleted: 0 });
    expect(readdirSync(join(home, 'aiclient-sessions')).sort()).toEqual([
      'aiclient-claimed.dsh.grants.json',
      'aiclient-fresh.dsh.grants.json',
      'aiclient-kept.dsh.grants.json',
      'aiclient-kept.dsh.json',
      'aiclient-live.dsh.grants.json',
      'other-client.dsh.grants.json',
    ]);
    expect(log).toHaveBeenCalledWith(
      'gc: deleted aiclient-swept.dsh.grants.json: its stub is gone'
    );
  });
});

describe('sessionGc — what stays (GC-02)', () => {
  it('leaves everything that fails one rule, and says why', async () => {
    const sessions = [
      session('subagent-child-uuid'),
      session('aiclient-claimed'),
      session('aiclient-child', {
        header: { id: 'aiclient-child', createdAt: OLD, parentSession: 'aiclient-claimed' },
      }),
      session('aiclient-grandchild', {
        header: { id: 'aiclient-grandchild', createdAt: OLD, parentSession: 'aiclient-child' },
      }),
      session('aiclient-recent', { header: { id: 'aiclient-recent', createdAt: NOW - DAY + 1 } }),
      session('aiclient-talked', { events: [...SETUP, 'turn/start', 'user/message'] }),
      session('aiclient-titled', { events: [...SETUP, 'session/title'] }),
      session('aiclient-large', { sizeBytes: 16 * 1024 + 1 }),
      session('aiclient-pending', { pending: true }),
      session('aiclient-locked', { locked: true }),
    ];
    const { persistence, opened } = fakePersistence(sessions);
    const result = await run(persistence, ['aiclient-claimed']);
    expect(result).toMatchObject({
      ok: true,
      deleted: [],
      stubsDeleted: 0,
      skipped: {
        foreign: 1,
        claimed: 3,
        recent: 1,
        content: 3,
        unmaterialized: 1,
        locked: 1,
      },
    });
    for (const item of sessions.filter((candidate) => !candidate.pending)) {
      expect(existsSync(sessionDir(item.header.id)), item.header.id).toBe(true);
    }
    // Too large to be empty: never even read.
    expect(opened.some((item) => item.id === 'aiclient-large')).toBe(false);
    expect(opened.every((item) => item.closed)).toBe(true);
  });

  it('keeps every session a claimed stub names: its current one and its lineage (P1-4b)', async () => {
    // A chat rewound twice to its first prompt: three empty sessions, none a
    // child of another by header, only the first claimed by Main (as when Main
    // could not read the stub). The stub still names all three.
    const sessions = [
      session('aiclient-x'),
      session('aiclient-x.r2'),
      session('aiclient-x.r3'),
      session('aiclient-y'),
    ];
    writeStub('aiclient-x.dsh.json', {
      engine: 'dsh',
      version: 2,
      dshSessionId: 'aiclient-x.r3',
      cwd: '/work/repo',
      lineage: [
        { dshSessionId: 'aiclient-x', reason: 'create', at: OLD },
        { dshSessionId: 'aiclient-x.r2', reason: 'rewind', at: OLD },
        { dshSessionId: 'aiclient-x.r3', reason: 'rewind', at: OLD },
      ],
    });
    // A stub nobody claims protects nothing.
    writeStub('aiclient-y.dsh.json', {
      engine: 'dsh',
      version: 2,
      dshSessionId: 'aiclient-y',
      cwd: '/work/repo',
      lineage: [{ dshSessionId: 'aiclient-y', reason: 'create', at: OLD }],
    });
    const { persistence } = fakePersistence(sessions);
    const result = await run(persistence, ['aiclient-x']);
    expect(result).toMatchObject({ deleted: ['aiclient-y'], skipped: { claimed: 3 } });
    for (const id of ['aiclient-x', 'aiclient-x.r2', 'aiclient-x.r3']) {
      expect(existsSync(sessionDir(id)), id).toBe(true);
    }
    expect(existsSync(stubFile('aiclient-x'))).toBe(true);
  });

  it('re-reads under the lock: content that landed meanwhile keeps the session', async () => {
    const { persistence } = fakePersistence([
      session('aiclient-racing', { eventsUnderLock: [...SETUP, 'turn/start'] }),
    ]);
    const result = await run(persistence);
    expect(result.skipped).toEqual({ content: 1 });
    expect(existsSync(sessionDir('aiclient-racing'))).toBe(true);
  });

  it('never deletes a directory that holds anything else, or lies outside the session root', async () => {
    const { persistence } = fakePersistence([session('aiclient-extra'), session('aiclient-moved')]);
    writeFileSync(join(sessionDir('aiclient-extra'), 'notes.txt'), 'mine');
    const moved = join(home, 'elsewhere', 'aiclient-moved');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'session.v4.jsonl.zstd'), 'log');
    const locate = persistence.locate?.bind(persistence);
    persistence.locate = (header) =>
      header.id === 'aiclient-moved'
        ? { kind: 'jsonl', path: join(moved, 'session.v4.jsonl.zstd') }
        : (locate?.(header) as { kind: string; path: string });
    const result = await run(persistence);
    expect(result.skipped).toEqual({ unexpected: 2 });
    expect(readdirSync(sessionDir('aiclient-extra')).sort()).toEqual([
      'notes.txt',
      'session.lock',
      'session.v4.jsonl.zstd',
    ]);
    expect(existsSync(moved)).toBe(true);
  });

  it('keeps going past a session that fails, and fails as a whole when the list does', async () => {
    const { persistence } = fakePersistence([session('aiclient-a'), session('aiclient-b')]);
    const open = persistence.open;
    persistence.open = vi.fn(async (id: string, access: 'read' | 'write') => {
      if (id === 'aiclient-a') throw new Error('corrupt log');
      return open(id, access);
    });
    const log = vi.fn();
    const result = await collectOrphanSessions(
      { persistence, home, now: () => NOW, log },
      { claimed: [], graceMs: DAY }
    );
    expect(result).toMatchObject({ deleted: ['aiclient-b'], skipped: { failed: 1 } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('corrupt log'));

    persistence.list = vi.fn(async () => {
      throw new Error('root unreadable');
    });
    await expect(run(persistence)).rejects.toThrow('root unreadable');
  });
});

describe('sessionGc — orphaned stubs', () => {
  it('deletes a stub whose session is gone, claimed by nobody, past the grace', async () => {
    const { persistence } = fakePersistence([session('aiclient-live', { locked: true })]);
    writeStub('aiclient-gone.dsh.json', {
      dshSessionId: 'aiclient-gone',
      cwd: '/work/repo',
      createdAt: OLD,
    });
    writeStub('aiclient-fresh.dsh.json', {
      dshSessionId: 'aiclient-fresh',
      cwd: '/work/repo',
      createdAt: NOW - 60_000,
    });
    writeStub('aiclient-kept.dsh.json', {
      dshSessionId: 'aiclient-kept',
      cwd: '/work/repo',
      createdAt: OLD,
    });
    // Lineage: named after a session that is gone, pointing at one that lives.
    writeStub('aiclient-renamed.dsh.json', {
      dshSessionId: 'aiclient-live',
      cwd: '/work/repo',
      createdAt: OLD,
    });
    writeStub('aiclient-garbled.dsh.json', '{not json');
    writeStub('aiclient-gone.dsh.json.1234.tmp', 'partial');
    // Its log is on disk but DSH cannot list it (say, an unreadable header).
    writeStub('aiclient-hidden.dsh.json', {
      dshSessionId: 'aiclient-hidden',
      cwd: '/work/repo',
      createdAt: OLD,
    });
    mkdirSync(sessionDir('aiclient-hidden'), { recursive: true });
    const result = await run(persistence, ['aiclient-kept']);
    expect(result.stubsDeleted).toBe(1);
    expect(result.skipped).toEqual({ locked: 1, recent: 1, claimed: 1, unexpected: 2 });
    expect(readdirSync(join(home, 'aiclient-sessions')).sort()).toEqual([
      'aiclient-fresh.dsh.json',
      'aiclient-garbled.dsh.json',
      'aiclient-gone.dsh.json.1234.tmp',
      'aiclient-hidden.dsh.json',
      'aiclient-kept.dsh.json',
      'aiclient-renamed.dsh.json',
    ]);
  });

  it('deletes an orphaned stub with its grants, the grants first (P1-6c)', async () => {
    const { persistence } = fakePersistence([]);
    writeStub('aiclient-gone.dsh.json', {
      dshSessionId: 'aiclient-gone',
      cwd: '/work/repo',
      createdAt: OLD,
    });
    writeStub('aiclient-gone.dsh.grants.json', '{"version":2,"grants":[]}');
    const { fs, ops } = recordingFs();
    const result = await run(persistence, [], fs);
    expect(result.stubsDeleted).toBe(1);
    expect(ops).toEqual([
      'unlink /aiclient-sessions/aiclient-gone.dsh.grants.json',
      'unlink /aiclient-sessions/aiclient-gone.dsh.json',
    ]);
  });

  it('dates a stub without createdAt by its file time', async () => {
    const { persistence } = fakePersistence([]);
    writeStub('aiclient-undated.dsh.json', { dshSessionId: 'aiclient-undated', cwd: '/work/repo' });
    const file = stubFile('aiclient-undated');
    expect((await run(persistence, [], undefined, DAY)).skipped).toEqual({ recent: 1 });
    utimesSync(file, new Date(OLD), new Date(OLD));
    const result = await collectOrphanSessions(
      { persistence, home, now: () => Date.now() },
      { claimed: [], graceMs: DAY }
    );
    expect(result.stubsDeleted).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});
