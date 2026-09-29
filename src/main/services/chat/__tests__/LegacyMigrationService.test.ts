import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_AGENT } from '@shared/types/agentWire';
import type { DshHostSeeded, DshSeedSessionResult } from '@shared/types/dshHostProtocol';
import { parseLegacyMigrationFailure } from '@shared/types/legacyMigration';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { stripComments } from '../../../../renderer/components/chat/__tests__/stripComments';
import type { SessionMigrationCommit } from '../SessionIndexService';

/**
 * dsh-rebase P1-9d (decisions 050, 051, 122): Main's migration of a legacy pi
 * chat, around a fake host and a fake index. No process is started and none
 * is ever signalled.
 */

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/fake/user-data', getAppPath: () => '/repo' },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('real spawn is forbidden in these tests');
  }),
}));

const { LegacyMigrationService, LEGACY_MIGRATION_RETRY_DELAYS_MS } = await import(
  '../LegacyMigrationService'
);

const PI_FILE = '/home/someone/.pilab/work/pi-agent/sessions/s1.jsonl';
const STUB = '/state/dsh-home/aiclient-sessions/aiclient-s1.dsh.json';

const legacyRow: SessionIndexEntry & { runtimeIdentity: string } = {
  sessionId: 's1',
  agent: PI_AGENT,
  runtimeIdentity: PI_FILE,
  piLeaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
  workspacePath: '/ws/a',
  title: 'Before the switch',
  updatedAt: 10,
  archived: false,
};

const result = (extra: Partial<DshSeedSessionResult> = {}): DshSeedSessionResult => ({
  stubFile: STUB,
  dshSessionId: 'aiclient-s1',
  reused: false,
  source: { sha256: 'c'.repeat(64), bytes: 900, mtimeMs: 1_700_000_000_001.5 },
  converted: 'source',
  legacyPermissions: { mode: 'plan', gear: 'ask' },
  grants: 2,
  images: { admitted: 1, refused: 1 },
  report: { converterVersion: 2, source: {} } as DshSeedSessionResult['report'],
  ...extra,
});

const ok = (extra: Partial<DshSeedSessionResult> = {}): DshHostSeeded => ({
  host: 'seeded',
  id: 1,
  ok: true,
  result: result(extra),
  ms: 12,
});

const failed = (
  stage: NonNullable<DshHostSeeded['error']>['stage'],
  code: string,
  retryable: boolean
): DshHostSeeded => ({
  host: 'seeded',
  id: 1,
  ok: false,
  error: { stage, code, message: `${PI_FILE}: ${code}`, retryable },
  ms: 3,
});

function supervisorError(code: string): Error {
  return Object.assign(new Error(`${code}: something happened to the host`), { code });
}

interface Harness {
  service: InstanceType<typeof LegacyMigrationService>;
  seedSession: ReturnType<typeof vi.fn>;
  commitMigrated: ReturnType<typeof vi.fn>;
  statFile: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  order: string[];
}

type SourceStat = { size: number; mtimeMs: number; isFile(): boolean };

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

function harness(
  answers: Array<DshHostSeeded | Error>,
  options: {
    stat?: () => Promise<SourceStat>;
    commit?: (input: SessionMigrationCommit) => SessionIndexEntry;
  } = {}
): Harness {
  const order: string[] = [];
  let stats = 0;
  const statFile = vi.fn(async (_file: string): Promise<SourceStat> => {
    order.push('stat');
    if (options.stat) return options.stat();
    stats += 1;
    return { size: 900 + stats, mtimeMs: 1_700_000_000_000 + stats, isFile: () => true };
  });
  const seedSession = vi.fn(async (_input: unknown, _options?: unknown) => {
    order.push('seed');
    const next = answers.shift();
    if (!next) throw new Error('no more answers scripted');
    if (next instanceof Error) throw next;
    return next;
  });
  const commitMigrated = vi.fn(
    async (input: SessionMigrationCommit): Promise<SessionIndexEntry> => {
      order.push('commit');
      if (options.commit) return options.commit(input);
      return {
        ...legacyRow,
        agent: 'dsh',
        runtimeIdentity: input.stubFile,
        piLeaf: undefined,
        migratedFrom: {
          legacySessionId: 's1_pi',
          runtimeIdentity: input.legacyRuntimeIdentity,
          sourceSha256: input.source.sha256,
          sourceBytes: input.source.bytes,
          sourceMtimeMs: input.source.mtimeMs,
          migratedAt: 1,
          converter: `pi-dsh/${input.converterVersion}`,
        },
      } satisfies SessionIndexEntry;
    }
  );
  const sleep = vi.fn(async (_ms: number) => {
    order.push('sleep');
  });
  const service = new LegacyMigrationService({
    host: { seedSession },
    index: { commitMigrated },
    statFile,
    sleep,
    log: { info: () => undefined, warn: () => undefined },
  });
  return { service, seedSession, commitMigrated, statFile, sleep, order };
}

let processKill: MockInstance;

beforeEach(() => {
  processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('real process.kill is forbidden in these tests');
  });
});

afterEach(() => {
  expect(processKill).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('LegacyMigrationService (P1-9d)', () => {
  it('stats the file, hands the stat to the host as `expect`, and commits only after the host wrote the stub', async () => {
    const h = harness([ok()]);

    const outcome = await h.service.migrate(legacyRow, '/ws/a');

    expect(h.order).toEqual(['stat', 'seed', 'commit']);
    expect(h.statFile).toHaveBeenCalledWith(PI_FILE);
    expect(h.seedSession).toHaveBeenCalledWith(
      {
        sourceFile: PI_FILE,
        logicalSessionId: 's1',
        cwd: '/ws/a',
        expect: { bytes: 901, mtimeMs: 1_700_000_000_001 },
      },
      { userInitiated: true }
    );
    // `migratedFrom` is the source as the host read it, not Main's stat.
    expect(h.commitMigrated).toHaveBeenCalledWith({
      sessionId: 's1',
      legacyRuntimeIdentity: PI_FILE,
      stubFile: STUB,
      workspacePath: '/ws/a',
      source: { sha256: 'c'.repeat(64), bytes: 900, mtimeMs: 1_700_000_000_001.5 },
      converterVersion: 2,
    });
    expect(outcome.row).toMatchObject({ sessionId: 's1', agent: 'dsh', runtimeIdentity: STUB });
    expect(outcome.summary).toEqual({
      legacySessionId: 's1_pi',
      reused: false,
      converted: 'source',
      images: { admitted: 1, refused: 1 },
      grants: 2,
      legacyPermissions: { mode: 'plan', gear: 'ask' },
    });
  });

  it('prepareResume migrates a legacy row and answers any other row as it is', async () => {
    const h = harness([ok()]);
    const live = { ...legacyRow, agent: 'dsh', runtimeIdentity: STUB };

    await expect(h.service.prepareResume(live, '/ws/a')).resolves.toEqual({ row: live });
    expect(h.seedSession).not.toHaveBeenCalled();

    const prepared = await h.service.prepareResume(legacyRow, '/ws/a');
    expect(prepared.row.runtimeIdentity).toBe(STUB);
    expect(prepared.migration?.legacySessionId).toBe('s1_pi');
  });

  it('runs one migration per chat: a second continue meanwhile gets the same outcome', async () => {
    let release: (answer: DshHostSeeded) => void = () => undefined;
    const h = harness([]);
    h.seedSession.mockImplementation((input: unknown) =>
      (input as { logicalSessionId: string }).logicalSessionId === 's1'
        ? new Promise<DshHostSeeded>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(ok({ stubFile: '/stub/s2.dsh.json' }))
    );

    const first = h.service.migrate(legacyRow, '/ws/a');
    const second = h.service.migrate(legacyRow, '/ws/a');
    expect(second).toBe(first);
    expect(h.service.isMigrating('s1')).toBe(true);
    // Another chat is not held up by it.
    const other = await h.service.migrate(
      { ...legacyRow, sessionId: 's2', runtimeIdentity: '/p/s2.jsonl' },
      '/ws/b'
    );
    expect(other.row.runtimeIdentity).toBe('/stub/s2.dsh.json');

    await vi.waitFor(() => expect(h.seedSession).toHaveBeenCalledTimes(2));
    release(ok());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(h.commitMigrated).toHaveBeenCalledTimes(2);
    expect(h.service.isMigrating('s1')).toBe(false);
  });

  it('tries a retryable host failure again, with a fresh stat each time', async () => {
    const h = harness([
      failed('read', 'source_busy', true),
      failed('stub', 'seed_stub_failed', true),
      ok(),
    ]);

    await expect(h.service.migrate(legacyRow, '/ws/a')).resolves.toMatchObject({
      row: { runtimeIdentity: STUB },
    });

    expect(h.order).toEqual([
      'stat',
      'seed',
      'sleep',
      'stat',
      'seed',
      'sleep',
      'stat',
      'seed',
      'commit',
    ]);
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([...LEGACY_MIGRATION_RETRY_DELAYS_MS]);
    const expects = h.seedSession.mock.calls.map(
      ([input]) => (input as { expect: { bytes: number } }).expect.bytes
    );
    expect(expects).toEqual([901, 902, 903]);
  });

  it('gives up after the retries, reporting the stage and the code but never the path', async () => {
    const h = harness([
      failed('read', 'source_busy', true),
      failed('read', 'source_busy', true),
      failed('read', 'source_busy', true),
    ]);

    const error = await rejectionOf(h.service.migrate(legacyRow, '/ws/a'));

    expect(error).toMatchObject({ code: 'legacy_migration_failed' });
    expect(error.message).toMatch(/^legacy_migration_failed:read\/source_busy: /);
    expect(error.message).not.toContain('/home/');
    expect(error.message).not.toContain('.jsonl');
    expect(
      parseLegacyMigrationFailure(`Error invoking remote method: Error: ${error.message}`)
    ).toEqual({
      stage: 'read',
      code: 'source_busy',
      retryable: true,
    });
    expect(h.seedSession).toHaveBeenCalledTimes(1 + LEGACY_MIGRATION_RETRY_DELAYS_MS.length);
    expect(h.commitMigrated).not.toHaveBeenCalled();
    // Nothing is held: the next continue starts a new migration.
    expect(h.service.isMigrating('s1')).toBe(false);
  });

  it.each([
    ['decode', 'session_invalid'],
    ['stub', 'seed_stub_conflict'],
    ['verify', 'seed_readback_mismatch'],
    ['request', 'seed_logical_id_invalid'],
  ] as const)('does not retry %s/%s, and commits nothing', async (stage, code) => {
    const h = harness([failed(stage, code, false)]);

    await expect(h.service.migrate(legacyRow, '/ws/a')).rejects.toThrow(
      new RegExp(
        `^legacy_migration_failed:${stage}/${code}: Session s1 could not be moved to the current chat engine$`
      )
    );
    expect(h.seedSession).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.commitMigrated).not.toHaveBeenCalled();
  });

  it.each([
    ['DSH_HOST_SEED_TIMEOUT', 'host/seed_timeout', true],
    ['DSH_HOST_SEED_INTERRUPTED', 'host/host_exited', true],
    ['DSH_HOST_UNAVAILABLE', 'host/host_unavailable', true],
    ['DSH_HOST_START_TIMEOUT', 'host/host_unavailable', true],
    ['DSH_HOST_SEED_MALFORMED', 'host/seed_answer_invalid', false],
    ['DSH_HOST_DISPOSED', 'host/host_unavailable', false],
  ] as const)('maps the supervisor’s %s to %s, without an automatic retry', async (code, mapped, retryable) => {
    const h = harness([supervisorError(code)]);

    const error = await rejectionOf(h.service.migrate(legacyRow, '/ws/a'));

    expect(error.message.startsWith(`legacy_migration_failed:${mapped}: `)).toBe(true);
    expect(error.message.endsWith(' (retryable)')).toBe(retryable);
    expect(h.seedSession).toHaveBeenCalledTimes(1);
    expect(h.commitMigrated).not.toHaveBeenCalled();
  });

  it('refuses a file Main cannot find without asking the host', async () => {
    const h = harness([], {
      stat: async () => {
        throw Object.assign(new Error(`ENOENT: no such file, stat '${PI_FILE}'`), {
          code: 'ENOENT',
        });
      },
    });

    await expect(h.service.migrate(legacyRow, '/ws/a')).rejects.toThrow(
      /^legacy_migration_failed:read\/source_missing: Session s1 [^/]*$/
    );
    expect(h.seedSession).not.toHaveBeenCalled();
  });

  it('refuses something that is not a regular file', async () => {
    const h = harness([], { stat: async () => ({ size: 0, mtimeMs: 0, isFile: () => false }) });

    await expect(h.service.migrate(legacyRow, '/ws/a')).rejects.toThrow(
      /^legacy_migration_failed:read\/source_unreadable: /
    );
    expect(h.seedSession).not.toHaveBeenCalled();
  });

  it.each([
    ['index_row_changed', 'index/index_row_changed', true],
    ['legacy_key_taken', 'index/legacy_key_taken', false],
    [undefined, 'index/index_commit_failed', true],
  ] as const)('maps an index failure (%s) to %s', async (code, mapped, retryable) => {
    const h = harness([ok()], {
      commit: () => {
        throw Object.assign(new Error(code ?? 'EIO: i/o error'), code ? { code } : {});
      },
    });

    const error = await rejectionOf(h.service.migrate(legacyRow, '/ws/a'));

    expect(error.message.startsWith(`legacy_migration_failed:${mapped}: `)).toBe(true);
    expect(error.message.endsWith(' (retryable)')).toBe(retryable);
    expect(h.seedSession).toHaveBeenCalledTimes(1);
  });

  it('[static] Main only ever stats the legacy file: no read, write or lock of it here', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'LegacyMigrationService.ts');
    const source = stripComments(readFileSync(file, 'utf8'), file);
    const fsImports = [
      ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g),
    ]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((name) => name.trim())
      .filter(Boolean);
    expect(fsImports).toEqual(['stat']);
    expect(source).not.toMatch(
      /\b(?:writeFile|appendFile|open|rename|unlink|rm|chmod|utimes|truncate|copyFile)\(/
    );
    expect(source).not.toMatch(/JsonlSessionStore|prepareSessionConfig|acquireWriterLock/);
  });

  it('logs the host’s own message redacted, and only in Main’s log', async () => {
    const warn = vi.fn();
    const seedSession = vi.fn(async () => failed('read', 'source_unreadable', false));
    const service = new LegacyMigrationService({
      host: { seedSession },
      index: { commitMigrated: vi.fn() },
      statFile: async () => ({ size: 1, mtimeMs: 1, isFile: () => true }),
      sleep: async () => undefined,
      log: { info: () => undefined, warn },
    });

    await expect(service.migrate(legacyRow, '/ws/a')).rejects.toThrow(/source_unreadable/);

    const line = String(warn.mock.calls.at(-1)?.[0]);
    expect(line).toContain('read/source_unreadable');
    expect(line).not.toContain('/home/someone');
  });
});
