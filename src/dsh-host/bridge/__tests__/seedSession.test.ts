import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DshLogEvent } from '../../../shared/dshHistory/types.ts';
import {
  checkSeed,
  convertPiSessionBytes,
  type DshSeedEvent,
  SEED_CONVERTER_VERSION,
} from '../../../shared/legacyPiSession/convert/index.ts';
import { decodeGrants } from '../../../shared/permissions/grants.ts';
import type { DshAttachmentStore } from '../attachments.ts';
import {
  holdsExactlySeed,
  type SeedSessionDeps,
  SeedSessionError,
  type SeedSessionRequest,
  seedPiSession,
} from '../seedSession.ts';
import { grantsSidecarFor, readStub, type SessionStub, stubPathFor } from '../stub.ts';

/**
 * dsh-rebase P1-9c — `seedSession` against the committed legacy pi corpus
 * (P1-9g, synthetic) in a scratch directory, with a fake DSH that keeps logs
 * in memory the way `agents.create({seed})` + the reader do (experiment E1):
 * the seed, then `session/end-seed`. The real engine runs in
 * `tools/bridge-smoke.ts` (host J) and `tools/seed-experiments.ts`.
 */

const CORPUS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../shared/__tests__/fixtures/legacy-pi'
);
const NOW = 1_800_000_000_000;
const CWD = '/work';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const named = (name: string) => Object.assign(new Error(name), { name });

class FakeDsh {
  readonly logs = new Map<string, DshLogEvent[]>();
  readonly unreadable = new Set<string>();
  readonly created: string[] = [];
  disposed = 0;
  flushed = 0;
  failCreate?: Error;
  failFlush?: Error;
  alter?: (events: DshLogEvent[]) => DshLogEvent[];

  readonly agents: SeedSessionDeps['agents'] = {
    create: async ({ sessionId, seed }) => {
      if (this.failCreate) throw this.failCreate;
      if (this.logs.has(sessionId)) throw named('SessionAlreadyExistsError');
      const events = structuredClone(seed) as DshLogEvent[];
      events.push({ type: 'session/end-seed', seq: events.length, time: NOW + 5, data: {} });
      this.logs.set(sessionId, events);
      this.created.push(sessionId);
      return {
        agent: { session: { id: sessionId } },
        dispose: async () => {
          this.disposed += 1;
        },
      };
    },
  };

  readonly sessions: SeedSessionDeps['sessions'] = {
    flush: async () => {
      if (this.failFlush) throw this.failFlush;
      this.flushed += 1;
      return true;
    },
  };

  readonly query: SeedSessionDeps['query'] = {
    observeSession: async (sessionId) => {
      if (this.unreadable.has(sessionId)) throw named('SessionPersistenceCorruptionError');
      const events = this.logs.get(sessionId);
      if (!events) throw named('SessionPersistenceNotFoundError');
      const copy = structuredClone(events);
      return { events: this.alter ? this.alter(copy) : copy, cursor: copy.length - 1 };
    },
  };
}

function fakeStore(mode: 'admit' | 'refuse' | 'broken' = 'admit'): DshAttachmentStore {
  const refusal = () =>
    Object.assign(new Error('Image too large'), {
      code: 'IMAGE_DIMENSION_TOO_LARGE',
      attachmentError: true,
    });
  return {
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    admitPromptContent: async (parts) => {
      if (mode === 'broken') throw new Error('disk full');
      return parts.map((part) => {
        if (part.type !== 'image') return part as never;
        if (mode === 'refuse') throw refusal();
        return {
          type: 'image',
          attachment: {
            attachmentId: sha256(part.data),
            mediaType: part.mediaType,
            bytes: Buffer.from(part.data, 'base64').length,
            width: 1,
            height: 1,
            ...(part.name ? { name: part.name } : {}),
          },
        };
      });
    },
    saveFile: async () => {
      throw new Error('a migration stores no text file');
    },
    validateImage: async () => {
      throw refusal();
    },
    isAttachmentError: (error) => (error as { attachmentError?: unknown }).attachmentError === true,
  };
}

let root = '';
let home = '';
let sessions = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'p1-9c-seed-'));
  home = join(root, 'dsh-home');
  sessions = join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A corpus file in the scratch profile, read-only: any write to it would fail. */
function place(file: string, as = file): string {
  const target = join(sessions, as);
  copyFileSync(join(CORPUS, file), target);
  chmodSync(target, 0o444);
  return target;
}

/**
 * A legacy corpus file with its 1.0.x copy beside it. The copy's header
 * named the corpus machine's path; it is pointed at the scratch one, as
 * 1.0.x would have written it here.
 */
function placeWithCopy(file: string): { source: string; copy: string } {
  const source = place(file);
  const copy = `${realpathSync(source)}.native-v4.jsonl`;
  const text = readFileSync(join(CORPUS, `${file}.native-v4.jsonl`), 'utf8');
  const cut = text.indexOf('\n');
  const header = JSON.parse(text.slice(0, cut)) as { metadata: Record<string, unknown> };
  header.metadata.importedFrom = realpathSync(source);
  writeFileSync(copy, `${JSON.stringify(header)}${text.slice(cut)}`);
  chmodSync(copy, 0o444);
  return { source, copy };
}

/**
 * A small native v4 session whose active branch ends on a session grant: no
 * corpus file does (their last grant record is the empty one a mode change
 * writes), and the sidecar needs one.
 */
function placeGranted(): string {
  const T = 1_790_000_000_000;
  const rows = [
    { kind: 'header', version: 4, id: 'granted', createdAt: T, cwd: CWD },
    {
      id: 'u1',
      type: 'message',
      message: { role: 'user', content: 'read a', timestamp: T + 1 },
    },
    {
      id: 'a1',
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        api: 'anthropic-messages',
        provider: 'p',
        model: 'm',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        stopReason: 'stop',
        timestamp: T + 2,
      },
    },
    {
      id: 'g1',
      type: 'custom',
      customType: 'aiclient.permissionGrants',
      data: { version: 2, grants: [{ kind: 'path', tool: 'read', path: `${CWD}/a` }] },
    },
  ];
  let parent: string | null = null;
  const lines = rows.map((row, index) => {
    if (index === 0) return JSON.stringify(row);
    const entry = {
      kind: 'entry',
      lane: 'main',
      seq: index,
      parentId: parent,
      timestamp: T + index,
      ...row,
    };
    parent = row.id as string;
    return JSON.stringify(entry);
  });
  const target = join(sessions, 'granted.jsonl');
  writeFileSync(target, `${lines.join('\n')}\n`);
  chmodSync(target, 0o444);
  return target;
}

function deps(dsh: FakeDsh, extra: Partial<SeedSessionDeps> = {}): SeedSessionDeps {
  return {
    home,
    agents: dsh.agents,
    sessions: dsh.sessions,
    query: dsh.query,
    attachments: fakeStore(),
    selection: () => ({ provider: 'p', model: 'm' }),
    now: () => NOW,
    ...extra,
  };
}

const request = (sourceFile: string, logicalSessionId = 's1'): SeedSessionRequest => ({
  kind: 'pi-file',
  sourceFile,
  logicalSessionId,
  cwd: CWD,
});

async function failure(promise: Promise<unknown>): Promise<SeedSessionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SeedSessionError);
    return error as SeedSessionError;
  }
  throw new Error('the migration succeeded');
}

/** The file as it is now: its bytes' hash, size, mtime and mode. */
function fingerprint(file: string) {
  const stats = statSync(file);
  return {
    sha256: sha256(readFileSync(file)),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode & 0o777,
  };
}

const stubFile = () => stubPathFor(home, 'aiclient-s1');

describe('seedPiSession — the corpus, by kind', () => {
  it.each<[string, () => { source: string; copy?: string }, (log: DshLogEvent[]) => void]>([
    [
      'a native v4 session with an image',
      () => ({ source: place('v4-basic.jsonl') }),
      (log) => {
        const image = JSON.stringify(log).match(/"attachmentId":"[0-9a-f]{64}"/g);
        expect(image).toHaveLength(1);
      },
    ],
    [
      'session grants',
      () => ({ source: placeGranted() }),
      () => {
        const sidecar = JSON.parse(readFileSync(grantsSidecarFor(stubFile()), 'utf8'));
        expect(decodeGrants(sidecar)?.length).toBeGreaterThan(0);
      },
    ],
    [
      'three compactions, each in its transaction',
      () => ({ source: place('v4-compaction.jsonl') }),
      (log) => {
        expect(log.filter((event) => event.type === 'compaction/start')).toHaveLength(3);
        expect(log.filter((event) => event.type === 'compaction/end')).toHaveLength(3);
      },
    ],
    [
      'an import with display rows',
      () => ({ source: place('v4-import-claude.jsonl') }),
      (log) => {
        expect(
          log.filter((event) => (event as { ignorable?: boolean }).ignorable).map((e) => e.type)
        ).toContain('aiclient/legacy-display');
      },
    ],
    ['a file the CLI extended', () => ({ source: place('v4-cli.jsonl') }), () => undefined],
    ['a run that crashed', () => ({ source: place('v4-crash-dangling.jsonl') }), () => undefined],
    [
      'a legacy v3 file, read through its 1.0.x copy',
      () => placeWithCopy('legacy-pi-v3.jsonl'),
      () => undefined,
    ],
    [
      'a legacy v1 file with no copy',
      () => ({ source: place('legacy-pi-v1.jsonl') }),
      () => undefined,
    ],
    [
      'a PI-Desktop file with no copy',
      () => ({ source: place('legacy-desktop.jsonl') }),
      () => undefined,
    ],
  ])('migrates %s, never touching the file', async (_label, setup, extra) => {
    const { source, copy } = setup();
    const before = fingerprint(source);
    const copyBefore = copy ? fingerprint(copy) : undefined;
    const dsh = new FakeDsh();
    const result = await seedPiSession(deps(dsh), request(source));

    expect(result).toMatchObject({
      stubFile: stubFile(),
      dshSessionId: 'aiclient-s1',
      reused: false,
      source: { sha256: before.sha256, bytes: before.size, mtimeMs: before.mtimeMs },
      converted: copy ? 'native-v4-copy' : 'source',
      report: { converterVersion: SEED_CONVERTER_VERSION },
    });
    // The file, and its copy, exactly as they were: bytes, size, mtime and read-only mode.
    expect(fingerprint(source)).toEqual(before);
    if (copy) expect(fingerprint(copy)).toEqual(copyBefore);

    const stub = readStub(stubFile());
    expect(stub).toMatchObject({
      engine: 'dsh',
      version: 2,
      dshSessionId: 'aiclient-s1',
      logicalSessionId: 's1',
      cwd: CWD,
      createdAt: NOW,
      lineage: [{ dshSessionId: 'aiclient-s1', reason: 'create', at: NOW }],
      origin: {
        kind: 'pi-session',
        converterVersion: SEED_CONVERTER_VERSION,
        migratedAt: NOW,
        file: { path: source, sha256: before.sha256, bytes: before.size, mtimeMs: before.mtimeMs },
      },
    });
    if (copy) {
      expect(stub.origin).toMatchObject({
        sourceSha256: fingerprint(copy).sha256,
        importedFrom: realpathSync(source),
        importedSourceSha256: before.sha256,
      });
    } else {
      expect(stub.origin).toMatchObject({ sourceSha256: before.sha256 });
    }

    // One session, created, flushed, released; its log is the bound seed and its marker.
    expect(dsh.created).toEqual(['aiclient-s1']);
    expect([dsh.flushed, dsh.disposed]).toEqual([1, 1]);
    const log = dsh.logs.get('aiclient-s1') as DshLogEvent[];
    expect(log.at(-1)?.type).toBe('session/end-seed');
    expect(checkSeed(log.slice(0, -1) as DshSeedEvent[], { images: 'bound' })).toEqual([]);
    expect(existsSync(grantsSidecarFor(stubFile()))).toBe(result.grants > 0);
    extra(log);
  });

  it('seeds exactly what the converter makes of the bytes it read', async () => {
    const source = place('v4-internal.jsonl');
    const dsh = new FakeDsh();
    const result = await seedPiSession(deps(dsh), request(source));
    const conversion = convertPiSessionBytes(readFileSync(source), {
      sourceFile: realpathSync(source),
      cwd: CWD,
    });
    if (!conversion.ok) throw new Error('the corpus file converts');
    expect(holdsExactlySeed(dsh.logs.get('aiclient-s1') ?? [], conversion.seed)).toBe(true);
    expect(result.report).toEqual(conversion.report);
    expect(result.legacyPermissions).toEqual(conversion.legacyPermissions);
  });
});

describe('seedPiSession — what it refuses, writing nothing', () => {
  it.each<[string, () => SeedSessionRequest, Partial<SeedSessionDeps>, [string, string, boolean]]>([
    [
      'an empty file',
      () => request(place('damaged-empty.jsonl')),
      {},
      ['decode', 'session_invalid', false],
    ],
    [
      'bytes that are not UTF-8',
      () => request(place('damaged-invalid-utf8.jsonl')),
      {},
      ['read', 'source_invalid_utf8', false],
    ],
    [
      'a seq gap',
      () => request(place('damaged-seq-gap.jsonl')),
      {},
      ['decode', 'session_invalid', false],
    ],
    [
      'a legacy file changed after 1.0.x copied it',
      () => request(placeWithCopy('legacy-pi-v3-drifted.jsonl').source),
      {},
      ['read', 'session_import_source_changed', false],
    ],
    ['no file', () => request(join(sessions, 'gone.jsonl')), {}, ['read', 'source_missing', false]],
    ['a directory', () => request(sessions), {}, ['read', 'source_unreadable', false]],
    [
      'a file past the size cap, before reading it',
      () => request(place('v4-basic.jsonl')),
      { maxSourceBytes: 16 },
      ['read', 'source_too_large', false],
    ],
    [
      'a file that changed since Main looked at it',
      () => ({ ...request(place('v4-basic.jsonl')), expect: { bytes: 1, mtimeMs: 0 } }),
      {},
      ['read', 'source_busy', true],
    ],
    [
      'a logical id that cannot name a session',
      () => request(place('v4-basic.jsonl'), '../s1'),
      {},
      ['request', 'seed_logical_id_invalid', false],
    ],
    [
      'an image store that fails',
      () => request(place('v4-basic.jsonl')),
      { attachments: fakeStore('broken') },
      ['admit', 'seed_admit_failed', false],
    ],
  ])('refuses %s', async (_label, make, extra, [stage, code, retryable]) => {
    const dsh = new FakeDsh();
    const error = await failure(seedPiSession(deps(dsh, extra), make()));
    expect([error.stage, error.code, error.retryable]).toEqual([stage, code, retryable]);
    expect(dsh.created).toEqual([]);
    expect(existsSync(stubFile())).toBe(false);
  });

  it('answers Main’s stat when it still matches', async () => {
    const source = place('v4-basic.jsonl');
    const { size, mtimeMs } = statSync(source);
    const result = await seedPiSession(deps(new FakeDsh()), {
      ...request(source),
      expect: { bytes: size, mtimeMs },
    });
    expect(result.dshSessionId).toBe('aiclient-s1');
  });
});

describe('seedPiSession — the DSH side failing', () => {
  it('fails at create, with no stub, when DSH refuses the seed', async () => {
    const dsh = new FakeDsh();
    dsh.failCreate = new Error('seed refused');
    const error = await failure(seedPiSession(deps(dsh), request(place('v4-basic.jsonl'))));
    expect([error.stage, error.code]).toEqual(['create', 'seed_create_failed']);
    expect(existsSync(stubFile())).toBe(false);
  });

  it('fails at create when the flush fails, and still releases the session', async () => {
    const dsh = new FakeDsh();
    dsh.failFlush = new Error('disk full');
    const error = await failure(seedPiSession(deps(dsh), request(place('v4-basic.jsonl'))));
    expect([error.stage, error.code]).toEqual(['create', 'seed_create_failed']);
    expect(dsh.disposed).toBe(1);
    expect(existsSync(stubFile())).toBe(false);
  });

  it('fails at verify when DSH cannot read the session back (E1), and writes no stub', async () => {
    const dsh = new FakeDsh();
    dsh.unreadable.add('aiclient-s1');
    const error = await failure(seedPiSession(deps(dsh), request(place('v4-compaction.jsonl'))));
    expect([error.stage, error.code]).toEqual(['verify', 'seed_readback_failed']);
    expect(existsSync(stubFile())).toBe(false);
    expect(existsSync(grantsSidecarFor(stubFile()))).toBe(false);
  });

  it('fails at verify when DSH reads back other than the seed', async () => {
    const dsh = new FakeDsh();
    dsh.alter = (events) => events.slice(1);
    const error = await failure(seedPiSession(deps(dsh), request(place('v4-basic.jsonl'))));
    expect([error.stage, error.code]).toEqual(['verify', 'seed_readback_mismatch']);
    expect(existsSync(stubFile())).toBe(false);
  });

  it('fails at sidecar, retryable, when the grants cannot be written; no stub follows', async () => {
    const dsh = new FakeDsh();
    const error = await failure(
      seedPiSession(deps(dsh, { writeGrants: () => false }), request(placeGranted()))
    );
    expect([error.stage, error.code, error.retryable]).toEqual([
      'sidecar',
      'seed_sidecar_failed',
      true,
    ]);
    expect(existsSync(stubFile())).toBe(false);
  });

  it('fails at stub, retryable, when the stub cannot be written', async () => {
    const dsh = new FakeDsh();
    const error = await failure(
      seedPiSession(
        deps(dsh, {
          writeStub: () => {
            throw new Error('read-only home');
          },
        }),
        request(place('v4-basic.jsonl'))
      )
    );
    expect([error.stage, error.code, error.retryable]).toEqual(['stub', 'seed_stub_failed', true]);
  });

  it('keeps an image the store refuses as the placeholder text, and counts it', async () => {
    const dsh = new FakeDsh();
    const result = await seedPiSession(
      deps(dsh, { attachments: fakeStore('refuse') }),
      request(place('v4-basic.jsonl'))
    );
    expect(result.images).toEqual({ admitted: 0, refused: 1 });
    expect(JSON.stringify(dsh.logs.get('aiclient-s1'))).toContain(
      '[image not migrated: image/png]'
    );
  });
});

describe('seedPiSession — the same chat again (decision 054 rule 5)', () => {
  it('answers the stub it made for the same bytes, and writes nothing', async () => {
    const source = placeGranted();
    const dsh = new FakeDsh();
    const first = await seedPiSession(deps(dsh), request(source));
    const stubText = readFileSync(stubFile(), 'utf8');
    const sidecar = fingerprint(grantsSidecarFor(stubFile()));
    const again = await seedPiSession(deps(dsh, { now: () => NOW + 1000 }), request(source));
    expect(again).toEqual({ ...first, reused: true, images: { admitted: 0, refused: 0 } });
    expect(dsh.created).toEqual(['aiclient-s1']);
    expect(readFileSync(stubFile(), 'utf8')).toBe(stubText);
    expect(fingerprint(grantsSidecarFor(stubFile()))).toEqual(sidecar);
  });

  it('takes a log an unfinished attempt left under the id, when it holds this seed', async () => {
    const source = place('v4-basic.jsonl');
    const dsh = new FakeDsh();
    const broken = deps(dsh, {
      writeStub: () => {
        throw new Error('crash before the stub');
      },
    });
    await failure(seedPiSession(broken, request(source)));
    expect(dsh.created).toEqual(['aiclient-s1']);
    const result = await seedPiSession(deps(dsh), request(source));
    expect(result).toMatchObject({ dshSessionId: 'aiclient-s1', reused: false });
    expect(dsh.created).toEqual(['aiclient-s1']);
    expect(readStub(stubFile()).dshSessionId).toBe('aiclient-s1');
  });

  it('steps past a log under the id that holds something else, to _m2', async () => {
    const dsh = new FakeDsh();
    dsh.logs.set('aiclient-s1', [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]);
    const result = await seedPiSession(deps(dsh), request(place('v4-basic.jsonl')));
    expect(result.dshSessionId).toBe('aiclient-s1_m2');
    expect(result.dshSessionId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(readStub(stubFile()).dshSessionId).toBe('aiclient-s1_m2');
  });

  it('replaces a migration of other bytes that was never used, under a new id', async () => {
    const dsh = new FakeDsh();
    await seedPiSession(deps(dsh), request(place('v4-internal.jsonl', 'old.jsonl')));
    // The pi file changed (1.0.x was reinstalled and used) before Main committed the first.
    const result = await seedPiSession(deps(dsh), request(place('v4-basic.jsonl')));
    expect(result).toMatchObject({ dshSessionId: 'aiclient-s1_m2', reused: false });
    const stub = readStub(stubFile());
    expect(stub.dshSessionId).toBe('aiclient-s1_m2');
    expect(stub.origin?.file.sha256).toBe(result.source.sha256);
  });

  it('redoes a migration whose session no longer reads (an older converter’s)', async () => {
    const source = place('v4-basic.jsonl');
    const dsh = new FakeDsh();
    await seedPiSession(deps(dsh), request(source));
    dsh.unreadable.add('aiclient-s1');
    const result = await seedPiSession(deps(dsh), request(source));
    expect(result).toMatchObject({ dshSessionId: 'aiclient-s1_m2', reused: false });
  });

  it('refuses a stub that is a chat of its own, or one someone has talked in since', async () => {
    const own: SessionStub = {
      engine: 'dsh',
      version: 2,
      dshSessionId: 'aiclient-s1',
      logicalSessionId: 's1',
      cwd: CWD,
      createdAt: 1,
      lineage: [{ dshSessionId: 'aiclient-s1', reason: 'create', at: 1 }],
    };
    mkdirSync(dirname(stubFile()), { recursive: true });
    writeFileSync(stubFile(), JSON.stringify(own));
    const dsh = new FakeDsh();
    const refused = await failure(seedPiSession(deps(dsh), request(place('v4-basic.jsonl'))));
    expect([refused.stage, refused.code]).toEqual(['stub', 'seed_stub_conflict']);
    expect(JSON.parse(readFileSync(stubFile(), 'utf8'))).toEqual(own);
    expect(dsh.created).toEqual([]);

    rmSync(stubFile());
    await seedPiSession(deps(dsh), request(place('v4-internal.jsonl', 'old.jsonl')));
    const log = dsh.logs.get('aiclient-s1') as DshLogEvent[];
    log.push({ type: 'turn/start', seq: log.length, time: 2, data: { turn: 99 } });
    const used = await failure(seedPiSession(deps(dsh), request(place('v4-crash-dangling.jsonl'))));
    expect([used.stage, used.code]).toEqual(['stub', 'seed_stub_conflict']);
  });

  it('removes a sidecar an unfinished attempt left, when this session has no grants', async () => {
    mkdirSync(dirname(stubFile()), { recursive: true });
    writeFileSync(grantsSidecarFor(stubFile()), '{"version":2,"grants":[]}');
    await seedPiSession(deps(new FakeDsh()), request(place('v4-basic.jsonl')));
    expect(existsSync(grantsSidecarFor(stubFile()))).toBe(false);
  });
});

describe('holdsExactlySeed', () => {
  const seed: DshSeedEvent[] = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }];
  const endSeed = { type: 'session/end-seed', seq: 1, time: 9, data: {} };

  it('takes the seed, its marker and the setup events DSH writes, nothing said after', () => {
    expect(holdsExactlySeed([...seed, endSeed], seed)).toBe(true);
    expect(
      holdsExactlySeed(
        [...seed, endSeed, { type: 'permission/preset', seq: 2, time: 9, data: {} }],
        seed
      )
    ).toBe(true);
    expect(
      holdsExactlySeed([...seed, endSeed, { type: 'turn/start', seq: 2, time: 9, data: {} }], seed)
    ).toBe(false);
    expect(holdsExactlySeed(seed, seed)).toBe(false);
    expect(holdsExactlySeed([{ ...seed[0], time: 2 } as DshLogEvent, endSeed], seed)).toBe(false);
  });
});
