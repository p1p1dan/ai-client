import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { legacyImportDedupeKey, type SessionIndexEntry } from '@shared/types';
import type { DshHostSeeded, DshSeedImportResult } from '@shared/types/dshHostProtocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSessionScanner } from '../ClaudeSessionScanner';
import { ClaudeImportSourceError } from '../ClaudeSourceAdapter';
import { CodexSessionScanner } from '../CodexSessionScanner';
import {
  DshLegacyImportHost,
  type DshLegacyImportSeeder,
  dshImportStubPath,
  type LegacyImportCreatePayload,
} from '../DshLegacyImportHost';
import { LegacyImportManifest } from '../LegacyImportManifest';
import { LegacyImportService, type LegacyImportSessionIndex } from '../LegacyImportService';
import {
  claudeSourceImporter,
  codexSourceImporter,
  type LegacySourceImporter,
} from '../LegacyImportSources';

let root: string;
let configDir: string;
let workspacePath: string;
let sourceFile: string;
let manifestPath: string;
let dshHome: string;
const TEST_INTEGRITY_KEY = Buffer.alloc(32, 7);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'legacy-import-service-'));
  configDir = path.join(root, 'claude');
  workspacePath = path.join(root, 'workspace');
  sourceFile = path.join(configDir, 'projects', 'project-a', 'session-a.jsonl');
  manifestPath = path.join(root, 'manifest.json');
  dshHome = path.join(root, 'dsh-home');
  await mkdir(path.dirname(sourceFile), { recursive: true });
  // The recorded cwd has to exist for the import to keep it (H/21 C3).
  await mkdir(workspacePath, { recursive: true });
  await writeSource('hello');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSource(text: string, cwd: string = workspacePath): Promise<void> {
  await writeFile(
    sourceFile,
    `${JSON.stringify({ type: 'system', subtype: 'init', cwd })}\n${JSON.stringify({ type: 'user', uuid: 'u1', cwd, message: { role: 'user', content: text } })}\n${JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: `answer:${text}` }] } })}\n`,
    'utf8'
  );
}

class FakeIndex implements LegacyImportSessionIndex {
  readonly rows = new Map<string, SessionIndexEntry>();
  failCreate = false;
  failRemove = false;

  async get(sessionId: string): Promise<SessionIndexEntry | undefined> {
    return this.rows.get(sessionId);
  }

  async createImported(entry: SessionIndexEntry): Promise<SessionIndexEntry> {
    if (this.failCreate) throw new Error('index failed');
    this.rows.set(entry.sessionId, { ...entry });
    return { ...entry };
  }

  async removeImported(sessionId: string, runtimeIdentity: string): Promise<boolean> {
    if (this.failRemove) throw new Error('remove failed');
    const row = this.rows.get(sessionId);
    if (!row || row.runtimeIdentity !== runtimeIdentity) return false;
    this.rows.delete(sessionId);
    return true;
  }
}

/**
 * dsh-rebase P1-9f: the shared host's `seedSession {kind:'imported-conversation'}`,
 * as far as Main sees it. It writes the identity stub where the bridge would
 * (`<DSH_HOME>/aiclient-sessions/aiclient-<logical id>.dsh.json`) and answers
 * `seeded`; the DSH log itself is the host's and never Main's to see.
 */
function fakeSeeder(options: { refuse?: boolean } = {}) {
  const seeded: Array<{ logicalSessionId: string; cwd: string; userInitiated?: boolean }> = [];
  const seeder: DshLegacyImportSeeder = {
    seedImportedConversation: vi.fn(
      async (input, opts): Promise<DshHostSeeded<DshSeedImportResult>> => {
        seeded.push({
          logicalSessionId: input.logicalSessionId,
          cwd: input.cwd,
          userInitiated: opts?.userInitiated,
        });
        if (options.refuse) {
          return {
            host: 'seeded',
            id: seeded.length,
            ok: false,
            error: {
              stage: 'build',
              code: 'WORKER_IMPORT_VALIDATION_FAILED',
              message: `nothing kept from ${input.cwd}`,
              retryable: false,
            },
            ms: 1,
          };
        }
        const dshSessionId = `aiclient-${input.logicalSessionId}`;
        const stubFile = dshImportStubPath(dshHome, dshSessionId);
        await mkdir(path.dirname(stubFile), { recursive: true });
        await writeFile(
          stubFile,
          JSON.stringify({
            engine: 'dsh',
            version: 2,
            dshSessionId,
            logicalSessionId: input.logicalSessionId,
            cwd: input.cwd,
            createdAt: 1,
            origin: { kind: 'imported-conversation', importedAt: 1 },
          })
        );
        return {
          host: 'seeded',
          id: seeded.length,
          ok: true,
          result: {
            kind: 'imported-conversation',
            stubFile,
            dshSessionId,
            reused: false,
            images: { admitted: 0, refused: 0 },
            report: {
              converterVersion: 2,
              source: { kind: 'imported-conversation', generation: 'claude-code', entries: {} },
            },
          },
          ms: 1,
        };
      }
    ),
  };
  return { seeder, seeded };
}

function harness(
  options: {
    manifest?: LegacyImportManifest;
    importers?: LegacySourceImporter[];
    mutateSourceAfterImport?: boolean;
    refuse?: boolean;
  } = {}
) {
  const index = new FakeIndex();
  const manifest =
    options.manifest ??
    new LegacyImportManifest({ manifestPath, integrityKey: TEST_INTEGRITY_KEY });
  let id = 0;
  const { seeder, seeded } = fakeSeeder({ refuse: options.refuse });
  const engine = new DshLegacyImportHost({
    host: seeder,
    dshHome: () => dshHome,
    log: { warn: () => undefined },
  });
  const createImport = vi.fn(async (payload: LegacyImportCreatePayload) => {
    const created = await engine.create(payload);
    if (options.mutateSourceAfterImport) {
      await writeFile(sourceFile, `${await readFile(sourceFile, 'utf8')}changed\n`, 'utf8');
    }
    return created;
  });
  const inspectImport = vi.fn((target: Parameters<DshLegacyImportHost['inspect']>[0]) =>
    engine.inspect(target)
  );
  // Stands in for ScratchWorkspaceService: same contract (allocate a directory
  // we own, recognise it later), inside the test's temp root.
  const scratchRoot = path.join(root, 'unbound-sessions');
  const workspaceFallback = {
    ensure: vi.fn(async (sessionId: string) => {
      const target = path.join(scratchRoot, sessionId);
      await mkdir(target, { recursive: true });
      return target;
    }),
    isScratchPath: (candidate: string) => candidate.startsWith(`${scratchRoot}${path.sep}`),
  };
  const service = new LegacyImportService({
    scanner: new ClaudeSessionScanner({
      resolveRoots: () => [{ dir: configDir, kind: 'legacy' }],
    }),
    workspaceFallback,
    manifest,
    importers: options.importers,
    sessionIndex: index,
    createImport,
    inspectImport,
    reconcileImport: vi.fn((target) => engine.reconcile(target)),
    createId: () => `id-${++id}`,
    now: () => 100,
  });
  return {
    service,
    manifest,
    index,
    engine,
    seeded,
    createImport,
    inspectImport,
    workspaceFallback,
    scratchRoot,
  };
}

/** Where the harness's host writes the stub of the chat `session-import-claude-code-<id>`. */
const stubOf = (logicalSessionId: string) =>
  dshImportStubPath(dshHome, `aiclient-${logicalSessionId}`);

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false
  );

const source = {
  sourceKind: 'claude-code' as const,
  projectId: 'project-a',
  sourceSessionId: 'session-a',
};

describe('LegacyImportService transaction', () => {
  it('dedupes the same immutable snapshot and creates a new session when the source grows', async () => {
    const h = harness();
    const first = await h.service.importBatch([source]);
    expect(first.results[0]?.status).toBe('imported');
    expect(h.createImport).toHaveBeenCalledTimes(1);

    const duplicate = await h.service.importBatch([source]);
    expect(duplicate.results[0]?.status).toBe('already-imported');
    expect(h.createImport).toHaveBeenCalledTimes(1);

    await writeSource('hello again');
    const snapshot = await h.service.importBatch([source]);
    expect(snapshot.results[0]?.status).toBe('imported');
    expect(snapshot.results[0]?.session?.sessionId).not.toBe(first.results[0]?.session?.sessionId);
    expect(h.createImport).toHaveBeenCalledTimes(2);
  });

  it('stays deduped across a restart: publish, reload the manifest in a fresh instance, already-imported (import-catalog-01/-11)', async () => {
    const h = harness();
    const first = await h.service.importBatch([source]);
    expect(first.results[0]?.status).toBe('imported');
    expect(h.createImport).toHaveBeenCalledTimes(1);

    // A brand-new LegacyImportManifest reading the same file back is what a
    // process restart looks like. import-catalog-01: the manifest's naming
    // check required pi's `_<id>.jsonl` suffix, but NativeLegacyImportWriter
    // writes a bare `${id}.jsonl` — so every completed record vanished on
    // reload, silently, and a re-import would have gone through again.
    const reloadedManifest = new LegacyImportManifest({
      manifestPath,
      integrityKey: TEST_INTEGRITY_KEY,
    });
    const reloadedRecords = await reloadedManifest.list();
    expect(reloadedRecords).toHaveLength(1);
    expect(reloadedRecords[0]?.status).toBe('complete');
    expect(reloadedRecords[0]?.dedupeKey).toBe((await h.manifest.list())[0]?.dedupeKey);
    // P1-9f: the record names the DSH identity stub, `<target id>.dsh.json`,
    // and the naming check still takes it after the restart.
    expect(reloadedRecords[0]?.targetSessionFile).toBe(first.results[0]?.session?.runtimeIdentity);
    expect(path.basename(reloadedRecords[0]?.targetSessionFile ?? '')).toBe(
      `${reloadedRecords[0]?.targetPiSessionId}.dsh.json`
    );

    const restarted = new LegacyImportService({
      scanner: new ClaudeSessionScanner({
        resolveRoots: () => [{ dir: configDir, kind: 'legacy' }],
      }),
      manifest: reloadedManifest,
      sessionIndex: h.index,
      createImport: h.createImport,
      inspectImport: h.inspectImport,
      reconcileImport: vi.fn(async () => ({ removedFiles: 0, remainingFiles: 0 })),
    });
    const second = await restarted.importBatch([source]);
    expect(second.results[0]?.status).toBe('already-imported');
    expect(h.createImport).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent requests for the same snapshot', async () => {
    const h = harness();
    const [left, right] = await Promise.all([
      h.service.importBatch([source]),
      h.service.importBatch([source]),
    ]);
    expect(h.createImport).toHaveBeenCalledTimes(1);
    expect(left.results[0]?.session?.sessionId).toBe(right.results[0]?.session?.sessionId);
  });

  it('warns instead of silently dropping a manifest record that fails to parse (import-catalog-01)', async () => {
    const manifest = new LegacyImportManifest({ manifestPath, integrityKey: TEST_INTEGRITY_KEY });
    const record = {
      dedupeKey: 'unparseable-key',
      status: 'importing' as const,
      source,
      sourcePath: sourceFile,
      sourceFingerprint: {
        stableSourceIdentity: 'x',
        contentHash: 'y',
        size: 1,
        mode: 0o100644,
        mtimeMs: 1,
      },
      workspacePath,
      title: 'broken',
      logicalSessionId: 'session-broken',
      targetPiSessionId: 'import-broken',
      startedAt: 1,
    };
    await manifest.reserve(record);
    // Matches neither the native `${id}.jsonl` nor the pi-era `_${id}.jsonl`
    // naming — parseRecord must reject the whole record shape.
    await manifest.updateImporting(record.dedupeKey, {
      targetSessionFile: path.join(root, 'totally-unrelated-name.jsonl'),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const reloaded = new LegacyImportManifest({ manifestPath, integrityKey: TEST_INTEGRITY_KEY });
      expect(await reloaded.list()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to parse (dedupeKey=unparseable-key)')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('completes an interrupted manifest when the target and index row were already committed', async () => {
    const h = harness();
    const first = await h.service.importBatch([source]);
    const session = first.results[0]?.session;
    expect(session?.runtimeIdentity).toBeTruthy();
    const records = await h.manifest.list();
    const completed = records[0];
    expect(completed?.status).toBe('complete');

    const recoveryManifest = new LegacyImportManifest({
      manifestPath: path.join(root, 'recovery-manifest.json'),
      integrityKey: TEST_INTEGRITY_KEY,
    });
    if (!completed || !session?.runtimeIdentity) throw new Error('missing completed fixture');
    await recoveryManifest.reserve({ ...completed, status: 'importing', completedAt: undefined });
    await recoveryManifest.updateImporting(completed.dedupeKey, {
      targetSessionFile: session.runtimeIdentity,
    });
    const recovered = new LegacyImportService({
      scanner: new ClaudeSessionScanner({
        resolveRoots: () => [{ dir: configDir, kind: 'legacy' }],
      }),
      manifest: recoveryManifest,
      sessionIndex: h.index,
      createImport: h.createImport,
      inspectImport: h.inspectImport,
      reconcileImport: vi.fn(async () => ({ removedFiles: 0, remainingFiles: 0 })),
    });
    await recovered.reconcile();
    expect((await recoveryManifest.list())[0]?.status).toBe('complete');
  });

  it('retries cleanup on restart when manifest completion and immediate index rollback fail', async () => {
    let writes = 0;
    const manifest = new LegacyImportManifest({
      manifestPath,
      integrityKey: TEST_INTEGRITY_KEY,
      writeAtomically: async (targetPath, data) => {
        writes += 1;
        if (writes === 3) throw new Error('manifest completion failed');
        await writeFile(targetPath, JSON.stringify(data), 'utf8');
      },
    });
    const h = harness({ manifest });
    h.index.failRemove = true;
    const failed = await h.service.importBatch([source]);
    expect(failed.results[0]?.status).toBe('failed');
    expect(h.index.rows.size).toBe(1);
    const pending = (await manifest.list())[0];
    expect(pending?.status).toBe('failed');
    expect(pending?.cleanupPending).toBe(true);
    await expect(h.service.importBatch([source])).rejects.toThrow(/cleanup pending/);
    expect((await manifest.list())[0]?.targetPiSessionId).toBe(pending?.targetPiSessionId);

    h.index.failRemove = false;
    const recovered = new LegacyImportService({
      scanner: new ClaudeSessionScanner({
        resolveRoots: () => [{ dir: configDir, kind: 'legacy' }],
      }),
      manifest,
      sessionIndex: h.index,
      createImport: h.createImport,
      inspectImport: h.inspectImport,
      reconcileImport: vi.fn(async () => ({ removedFiles: 0, remainingFiles: 0 })),
    });
    await recovered.reconcile();
    expect(h.index.rows.size).toBe(0);
    expect((await manifest.list())[0]?.error).toContain('Recovered and cleaned');
  });

  it('reconciles every unresolved record even when an earlier one can never be cleaned up (import-catalog-10)', async () => {
    // Two independently-interrupted imports, reserved in this order so record
    // A sorts first in manifest.list() (Map insertion order) — that ordering
    // is exactly what let the old fail-closed throw inside the loop wedge B
    // behind A forever.
    const manifest = new LegacyImportManifest({ manifestPath, integrityKey: TEST_INTEGRITY_KEY });
    const recordBase = {
      source,
      sourcePath: sourceFile,
      sourceFingerprint: {
        stableSourceIdentity: 'x',
        contentHash: 'y',
        size: 1,
        mode: 0o100644,
        mtimeMs: 1,
      },
      workspacePath,
      title: 'interrupted',
      startedAt: 1,
    };
    const recordA = {
      ...recordBase,
      dedupeKey: 'dedupe-a',
      status: 'importing' as const,
      logicalSessionId: 'session-a',
      targetPiSessionId: 'import-a',
    };
    const recordB = {
      ...recordBase,
      dedupeKey: 'dedupe-b',
      status: 'importing' as const,
      logicalSessionId: 'session-b',
      targetPiSessionId: 'import-b',
    };
    await manifest.reserve(recordA);
    await manifest.reserve(recordB);

    // B left an orphaned file behind (as if the process died between staging
    // and reconcile); a working reconcile removes it.
    const orphanB = path.join(root, `${recordB.targetPiSessionId}.jsonl`);
    await writeFile(orphanB, 'orphaned', 'utf8');

    const index = new FakeIndex();
    const service = new LegacyImportService({
      scanner: new ClaudeSessionScanner({
        resolveRoots: () => [{ dir: configDir, kind: 'legacy' }],
      }),
      manifest,
      sessionIndex: index,
      createImport: async () => {
        throw new Error('unused');
      },
      // A's worker inspection never comes back — permanently unresolvable.
      inspectImport: vi.fn(async (payload: { targetPiSessionId: string }) => {
        if (payload.targetPiSessionId === recordA.targetPiSessionId) {
          throw new Error('worker unavailable for A');
        }
        try {
          await stat(orphanB);
          return { sessionFiles: [orphanB] };
        } catch {
          return { sessionFiles: [] };
        }
      }),
      reconcileImport: vi.fn(async (payload: { targetPiSessionId: string }) => {
        if (payload.targetPiSessionId === recordB.targetPiSessionId) {
          await unlink(orphanB).catch(() => undefined);
          return { removedFiles: 1, remainingFiles: 0 };
        }
        return { removedFiles: 0, remainingFiles: 0 };
      }),
    });

    await expect(service.reconcile()).rejects.toThrow(/cleanup pending/);

    const records = await manifest.list();
    const a = records.find((record) => record.dedupeKey === 'dedupe-a');
    const b = records.find((record) => record.dedupeKey === 'dedupe-b');
    expect(a?.status).toBe('failed');
    expect(a?.cleanupPending).toBe(true);
    // The point of the fix: B is fully reconciled despite A being stuck.
    expect(b?.status).toBe('failed');
    expect(b?.cleanupPending).toBe(false);
    await expect(stat(orphanB)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans the target when the source changes before publish commit', async () => {
    const h = harness({ mutateSourceAfterImport: true });
    const result = await h.service.importBatch([source]);
    expect(result.results[0]).toMatchObject({ status: 'failed' });
    expect(result.results[0]?.error).toContain('changed before publish');
    expect(h.index.rows.size).toBe(0);
    const record = (await h.manifest.list())[0];
    expect(record?.status).toBe('failed');
    await expect(
      import('node:fs/promises').then(({ stat }) => stat(record?.targetSessionFile ?? ''))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('commits a DSH chat: the row names the stub, the manifest the same file (P1-9f)', async () => {
    const h = harness();
    const result = await h.service.importBatch([source]);
    expect(result.results[0]?.status).toBe('imported');
    const session = result.results[0]?.session;
    const logicalSessionId = session?.sessionId ?? '';
    expect(logicalSessionId).toMatch(/^session-import-claude-code-/);
    // Decision 056: agent dsh, the stub as identity, no pi leaf; the ABI field
    // keeps its name and carries the id the stub is named after.
    expect(session).toMatchObject({
      agent: 'dsh',
      runtimeIdentity: stubOf(logicalSessionId),
      workspacePath,
      legacyImport: {
        sourceKind: 'claude-code',
        targetPiSessionId: `aiclient-${logicalSessionId}`,
      },
    });
    expect(session).not.toHaveProperty('piLeaf');
    expect(h.index.rows.get(logicalSessionId)).toEqual(session);
    // The host was asked for this chat, in the resolved workspace, for the user.
    expect(h.seeded).toEqual([{ logicalSessionId, cwd: workspacePath, userInitiated: true }]);
    const record = (await h.manifest.list())[0];
    expect(record).toMatchObject({
      status: 'complete',
      logicalSessionId,
      targetPiSessionId: `aiclient-${logicalSessionId}`,
      targetSessionFile: stubOf(logicalSessionId),
    });
    expect(await exists(stubOf(logicalSessionId))).toBe(true);
  });

  it('quarantines a tampered manifest without unlinking or de-indexing an unowned file', async () => {
    const victim = path.join(root, 'victim_import-pi.jsonl');
    await writeFile(victim, 'do-not-delete', 'utf8');
    const tamperedRecord = {
      dedupeKey: 'tampered-key',
      status: 'importing',
      source,
      sourcePath: sourceFile,
      sourceFingerprint: {
        stableSourceIdentity: 'x',
        contentHash: 'y',
        size: 1,
        mode: 0o100644,
        mtimeMs: 1,
      },
      workspacePath,
      title: 'tampered',
      logicalSessionId: 'session-import-tampered',
      targetPiSessionId: 'import-pi',
      targetSessionFile: victim,
      startedAt: 1,
    };
    await writeFile(
      manifestPath,
      JSON.stringify({ version: 1, records: [tamperedRecord] }),
      'utf8'
    );
    const index = new FakeIndex();
    index.rows.set(tamperedRecord.logicalSessionId, {
      sessionId: tamperedRecord.logicalSessionId,
      runtimeIdentity: victim,
      agent: 'pi',
      workspacePath,
      title: 'unrelated',
      updatedAt: 1,
      archived: false,
    });
    const manifest = new LegacyImportManifest({
      manifestPath,
      integrityKey: TEST_INTEGRITY_KEY,
    });
    const service = new LegacyImportService({
      scanner: new ClaudeSessionScanner({
        resolveRoots: () => [{ dir: configDir, kind: 'legacy' }],
      }),
      manifest,
      sessionIndex: index,
      createImport: async () => {
        throw new Error('unused');
      },
      inspectImport: async () => ({ sessionFiles: [] }),
      reconcileImport: async () => ({ removedFiles: 0, remainingFiles: 0 }),
    });
    await expect(service.reconcile()).resolves.toBeUndefined();
    expect(await import('node:fs/promises').then(({ readFile }) => readFile(victim, 'utf8'))).toBe(
      'do-not-delete'
    );
    expect(index.rows.has(tamperedRecord.logicalSessionId)).toBe(true);
    expect(await manifest.list()).toEqual([]);
  });

  it('removes the published target and records failure when index commit fails', async () => {
    const h = harness();
    h.index.failCreate = true;
    const result = await h.service.importBatch([source]);
    expect(result.results[0]).toMatchObject({ status: 'failed' });
    const call = h.createImport.mock.results[0];
    const imported = await call?.value;
    await expect(stat(imported.sessionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const record = (await h.manifest.list())[0];
    expect(record?.status).toBe('failed');
    // Nothing is left to clean: the next import is not blocked.
    expect(record?.cleanupPending).toBe(false);
    expect(h.index.rows.size).toBe(0);

    h.index.failCreate = false;
    const retried = await h.service.importBatch([source]);
    expect(retried.results[0]?.status).toBe('imported');
    expect(retried.results[0]?.session?.sessionId).not.toBe(
      path.basename(imported.sessionFile, '.dsh.json').slice('aiclient-'.length)
    );
  });

  it('fails an import the engine refuses, with its stage and code only, and leaves nothing', async () => {
    const h = harness({ refuse: true });
    const result = await h.service.importBatch([source]);
    expect(result.results[0]).toMatchObject({ status: 'failed' });
    expect(result.results[0]?.error).toContain('(build/WORKER_IMPORT_VALIDATION_FAILED)');
    // The host's message named a path; the item's error does not.
    expect(result.results[0]?.error).not.toContain(workspacePath);
    expect(h.index.rows.size).toBe(0);
    const record = (await h.manifest.list())[0];
    expect(record).toMatchObject({ status: 'failed', cleanupPending: false });
  });
});

/**
 * dsh-rebase P1-9f (plan P1-9 shard 04 §5, decision 056 rule 4): an import
 * 1.0.x made is a pi chat, and on its first continue it became a DSH chat
 * under the same logical id, the pi row kept under `<id>_pi` (decision 051).
 * Either way the conversation is already here and is not imported again;
 * and an interrupted record never takes a migrated chat away.
 */
describe('LegacyImportService and 1.0.x imports (P1-9f)', () => {
  const legacyId = 'session-import-claude-code-old';
  const legacyTarget = 'import-claude-code-old';
  let piFile: string;

  beforeEach(async () => {
    piFile = path.join(root, 'pi-agent', 'sessions', `${legacyTarget}.jsonl`);
    await mkdir(path.dirname(piFile), { recursive: true });
    await writeFile(piFile, 'a 1.0.x import\n', 'utf8');
  });

  /** The manifest record 1.0.x wrote for the source as it is now. */
  async function legacyRecord(
    manifest: LegacyImportManifest,
    status: 'complete' | 'importing' | 'failed'
  ): Promise<string> {
    const read = await claudeSourceImporter(
      new ClaudeSessionScanner({ resolveRoots: () => [{ dir: configDir, kind: 'legacy' }] })
    ).convert(source);
    const dedupeKey = legacyImportDedupeKey(read.conversation);
    await manifest.reserve({
      dedupeKey,
      status: 'importing',
      source,
      sourcePath: read.sourcePath,
      sourceFingerprint: read.conversation.sourceFingerprint,
      workspacePath,
      title: read.conversation.title,
      logicalSessionId: legacyId,
      targetPiSessionId: legacyTarget,
      startedAt: 1,
    });
    await manifest.updateImporting(dedupeKey, { targetSessionFile: piFile });
    if (status === 'complete') await manifest.complete(dedupeKey, piFile);
    if (status === 'failed') await manifest.fail(dedupeKey, 'index cleanup failed', true);
    return dedupeKey;
  }

  function piRow(dedupeKey: string): SessionIndexEntry {
    return {
      sessionId: legacyId,
      agent: 'pi',
      runtimeIdentity: piFile,
      piLeaf: { activeEntryId: 'leaf', fileTailEntryId: 'leaf' },
      legacyImport: { sourceKind: 'claude-code', targetPiSessionId: legacyTarget, dedupeKey },
      workspacePath,
      title: 'hello',
      updatedAt: 1,
      archived: false,
    };
  }

  /** The pair `commitMigrated` leaves (decision 051). */
  function migratedPair(dedupeKey: string): SessionIndexEntry[] {
    const legacy = piRow(dedupeKey);
    const { piLeaf: _leaf, ...carried } = legacy;
    return [
      { ...legacy, sessionId: `${legacyId}_pi`, migratedTo: legacyId },
      {
        ...carried,
        agent: 'dsh',
        runtimeIdentity: stubOf(legacyId),
        updatedAt: 2,
        migratedFrom: {
          legacySessionId: `${legacyId}_pi`,
          runtimeIdentity: piFile,
          sourceSha256: 'a'.repeat(64),
          sourceBytes: 16,
          sourceMtimeMs: 1,
          migratedAt: 2,
          converter: 'pi-dsh/2',
        },
      },
    ];
  }

  it('does not import again a conversation 1.0.x imported and nobody continued (decision 056 rule 4)', async () => {
    const h = harness();
    const dedupeKey = await legacyRecord(h.manifest, 'complete');
    h.index.rows.set(legacyId, piRow(dedupeKey));
    const result = await h.service.importBatch([source]);
    expect(result.results[0]).toMatchObject({
      status: 'already-imported',
      session: { sessionId: legacyId, agent: 'pi' },
    });
    expect(h.createImport).not.toHaveBeenCalled();
  });

  it('does not import again a 1.0.x import migrated to DSH since: the migration pair is recognised', async () => {
    const h = harness();
    const dedupeKey = await legacyRecord(h.manifest, 'complete');
    for (const row of migratedPair(dedupeKey)) h.index.rows.set(row.sessionId, row);
    const result = await h.service.importBatch([source]);
    expect(result.results[0]).toMatchObject({
      status: 'already-imported',
      session: { sessionId: legacyId, agent: 'dsh', runtimeIdentity: stubOf(legacyId) },
    });
    expect(h.createImport).not.toHaveBeenCalled();
    expect(h.index.rows.size).toBe(2);
  });

  it('completes an interrupted 1.0.x record whose row was migrated, and keeps the chat', async () => {
    const h = harness();
    const dedupeKey = await legacyRecord(h.manifest, 'importing');
    for (const row of migratedPair(dedupeKey)) h.index.rows.set(row.sessionId, row);
    // Even with the pi file gone: the chat lives in DSH now.
    await rm(piFile);
    await h.service.reconcile();
    expect((await h.manifest.list())[0]?.status).toBe('complete');
    expect(h.index.rows.get(legacyId)?.agent).toBe('dsh');
  });

  it('keeps a migrated chat a failed 1.0.x record still wanted cleaned, and unblocks imports', async () => {
    const h = harness();
    const dedupeKey = await legacyRecord(h.manifest, 'failed');
    for (const row of migratedPair(dedupeKey)) h.index.rows.set(row.sessionId, row);
    await h.service.reconcile();
    expect((await h.manifest.list())[0]).toMatchObject({ status: 'failed', cleanupPending: false });
    expect(h.index.rows.size).toBe(2);
    expect(await exists(piFile)).toBe(true);
  });

  it('cleans a failed 1.0.x record: the pi row goes, the pi file is left in place', async () => {
    const h = harness();
    const dedupeKey = await legacyRecord(h.manifest, 'failed');
    h.index.rows.set(legacyId, piRow(dedupeKey));
    await h.service.reconcile();
    expect(h.index.rows.size).toBe(0);
    expect((await h.manifest.list())[0]).toMatchObject({ status: 'failed', cleanupPending: false });
    // This build never deletes a 1.0.x file; unindexed, it shows nowhere.
    expect(await exists(piFile)).toBe(true);
  });

  it('takes back the stub of an import the host finished and Main never recorded', async () => {
    const h = harness();
    const logicalSessionId = 'session-import-claude-code-crashed';
    const target = `aiclient-${logicalSessionId}`;
    await h.manifest.reserve({
      dedupeKey: 'crashed-key',
      status: 'importing',
      source,
      sourcePath: sourceFile,
      sourceFingerprint: {
        stableSourceIdentity: 'x',
        contentHash: 'y',
        size: 1,
        mode: 0o100644,
        mtimeMs: 1,
      },
      workspacePath,
      title: 'crashed',
      logicalSessionId,
      targetPiSessionId: target,
      startedAt: 1,
    });
    // The host wrote the stub; Main died before `updateImporting`.
    await mkdir(path.dirname(stubOf(logicalSessionId)), { recursive: true });
    await writeFile(
      stubOf(logicalSessionId),
      JSON.stringify({ engine: 'dsh', version: 2, dshSessionId: target, logicalSessionId })
    );
    await h.service.reconcile();
    expect(await exists(stubOf(logicalSessionId))).toBe(false);
    expect((await h.manifest.list())[0]).toMatchObject({ status: 'failed', cleanupPending: false });
  });
});

describe('B4 multi-source import', () => {
  async function sources() {
    const codexRoot = path.join(root, 'codex');
    await mkdir(codexRoot);
    await copyFile(
      path.resolve(
        __dirname,
        '../../../../agent-host/__tests__/fixtures/codex/codex-rollout-redacted.jsonl'
      ),
      path.join(codexRoot, 'rollout.jsonl')
    );
    const codex = codexSourceImporter(new CodexSessionScanner(() => codexRoot));
    const claude = claudeSourceImporter(
      new ClaudeSessionScanner({ resolveRoots: () => [{ dir: configDir, kind: 'legacy' }] })
    );
    return { codex, claude };
  }

  it('imports Codex once and persists enough manifest state for deduplication', async () => {
    const { codex, claude } = await sources();
    const h = harness({ importers: [claude, codex] });
    const projects = await h.service.listProjects();
    expect(projects.map((project) => project.sourceKind).sort()).toEqual(['claude-code', 'codex']);
    const project = projects.find((item) => item.sourceKind === 'codex');
    if (!project) throw new Error('missing Codex project');
    const [session] = await h.service.listSessions(project.id, 'codex');
    const ref = {
      sourceKind: 'codex' as const,
      projectId: project.id,
      sourceSessionId: session.id,
    };
    expect((await h.service.importBatch([ref])).results[0].status).toBe('imported');
    expect((await h.service.importBatch([ref])).results[0].status).toBe('already-imported');
    expect(h.createImport).toHaveBeenCalledOnce();
    expect([...h.index.rows.values()][0].legacyImport?.sourceKind).toBe('codex');
    const reloaded = new LegacyImportManifest({ manifestPath, integrityKey: TEST_INTEGRITY_KEY });
    expect((await reloaded.list())[0].source.sourceKind).toBe('codex');
  });

  it('imports matching external ids from two sources as distinct sessions', async () => {
    const { claude, codex } = await sources();
    const [codexProject] = (await codex.scan()).projects;
    const [codexSession] = (await codex.scan(codexProject.id)).sessions;
    const sameIdFile = path.join(path.dirname(sourceFile), `${codexSession.id}.jsonl`);
    await rename(sourceFile, sameIdFile);
    const h = harness({ importers: [claude, codex] });
    const results = (
      await h.service.importBatch([
        { sourceKind: 'claude-code', projectId: 'project-a', sourceSessionId: codexSession.id },
        { sourceKind: 'codex', projectId: codexProject.id, sourceSessionId: codexSession.id },
      ])
    ).results;
    expect(results.map((result) => result.status)).toEqual(['imported', 'imported']);
    expect(h.index.rows.size).toBe(2);
    expect(results[0].session?.sessionId).not.toBe(results[1].session?.sessionId);
    expect(results[0].session?.legacyImport?.dedupeKey).not.toBe(
      results[1].session?.legacyImport?.dedupeKey
    );
    expect(await readFile(sameIdFile, 'utf8')).toContain('answer:hello');
  });

  // H/21 C3 (2026-09-20 revision) — the recorded directory is kept whenever it
  // exists, full stop.
  //
  // This was gated on a `workspaceMatched` verdict from the renderer, whose
  // answer to "does this folder exist" was actually "is it already a project
  // here". A real checkout the user had never opened in this app therefore
  // imported as a temporary chat, and the pane said so before the fact. The
  // existence check moved to the only layer that can make it.
  it('keeps the recorded workspace when the directory exists', async () => {
    const h = harness();
    const result = (await h.service.importBatch([source])).results[0];
    expect(result.status).toBe('imported');
    expect(result.session?.workspacePath).toBe(workspacePath);
    expect(result.session?.unbound).toBeUndefined();
    expect(result.outcome?.workspace).toBe('kept');
    expect(result.outcome?.recordedWorkspacePath).toBe(workspacePath);
    expect(h.workspaceFallback.ensure).not.toHaveBeenCalled();
  });

  it('imports into a scratch workspace and marks the row unbound when the directory is gone', async () => {
    await rm(workspacePath, { recursive: true, force: true });
    const h = harness();
    const result = (await h.service.importBatch([source])).results[0];
    expect(result.status).toBe('imported');
    expect(result.session?.unbound).toBe(true);
    expect(result.session?.workspacePath.startsWith(h.scratchRoot)).toBe(true);
    // The user has to be told WHICH folder went missing; the path in the report
    // is the only part of it they can act on.
    expect(result.outcome?.workspace).toBe('missing');
    expect(result.outcome?.recordedWorkspacePath).toBe(workspacePath);
    expect(result.outcome?.workspacePath).toBe(result.session?.workspacePath);
    // The worker, the manifest and the row must all name the same directory.
    expect(h.createImport.mock.calls[0][0].conversation.workspacePath).toBe(
      result.session?.workspacePath
    );
    const record = (await h.manifest.list())[0];
    expect(record.workspacePath).toBe(result.session?.workspacePath);
  });

  // The 2026-09-20 report, as a test: the directory is a real one that no
  // project in this app has ever pointed at, and the ONLY reason it used to be
  // diverted was that fact. Nothing about the renderer's project list reaches
  // this decision any more — `resolveWorkspace` is given a path and probed.
  it('keeps a real directory that no project is registered against', async () => {
    const unregistered = path.join(root, 'never-opened-here');
    await mkdir(unregistered, { recursive: true });
    await writeSource('hello', unregistered);
    const h = harness();
    const result = (await h.service.importBatch([source])).results[0];
    expect(result.status).toBe('imported');
    expect(result.session?.workspacePath).toBe(unregistered);
    expect(result.session?.unbound).toBeUndefined();
    expect(result.outcome?.workspace).toBe('kept');
  });

  it('keeps Claude projects visible when the Codex root cannot be scanned', async () => {
    const { claude } = await sources();
    // A regular file used as the root produces ENOTDIR on every host, including root users.
    const codex = codexSourceImporter(new CodexSessionScanner(() => sourceFile));
    const h = harness({ importers: [codex, claude] });
    const projects = await h.service.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].sourceKind).toBe('claude-code');
  });
});

/**
 * T066 (D10) — the import chain used to run silently.
 *
 * The 2026-09-17 field pass imported 42 sessions and had 2 rejected by the size
 * guards; grepping main.log, the daily log and the dev-server output for
 * anything about any of it returned zero lines. Every exit of this service was
 * a return value or an item status, and both die in the renderer.
 */
describe('LegacyImportService logging (T066)', () => {
  let logged: string[];
  let warned: string[];

  beforeEach(() => {
    logged = [];
    warned = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('brackets a batch with a start line and a result line', async () => {
    const h = harness();

    await h.service.importBatch([source]);

    expect(
      logged.some((line) => line.includes('[legacy-import] Batch started: 1 session(s)'))
    ).toBe(true);
    expect(
      logged.some((line) =>
        line.includes('[legacy-import] Batch done: 1 imported, 0 already imported, 0 failed.')
      )
    ).toBe(true);
    // A clean batch is not an anomaly: nothing may reach the warn channel.
    expect(warned).toEqual([]);
  });

  it('counts an already-imported snapshot apart from a fresh one', async () => {
    const h = harness();
    await h.service.importBatch([source]);
    logged.length = 0;

    await h.service.importBatch([source]);

    expect(
      logged.some((line) =>
        line.includes('[legacy-import] Batch done: 0 imported, 1 already imported, 0 failed.')
      )
    ).toBe(true);
  });

  it('names the failing session and its reason once per failed item', async () => {
    const h = harness();

    const result = await h.service.importBatch([{ ...source, sourceSessionId: 'session-missing' }]);

    expect(result.results[0]?.status).toBe('failed');
    const failure = warned.filter((line) => line.startsWith('[legacy-import] Failed'));
    expect(failure).toHaveLength(1);
    expect(failure[0]).toContain('session-missing');
    expect(
      logged.some((line) =>
        line.includes('[legacy-import] Batch done: 0 imported, 0 already imported, 1 failed.')
      )
    ).toBe(true);
  });

  it('keeps the home directory out of a failure reason', async () => {
    // The reason is an arbitrary error message, and the ones that carry a path
    // carry the user's own (`ENOENT … /home/<user>/.claude/…`). T042's rules
    // collapse the username; nothing else about the line changes.
    const failing: LegacySourceImporter = {
      source: 'claude-code',
      scan: async () => ({ projects: [], sessions: [] }),
      convert: async () => {
        throw new Error('ENOENT: no such file or directory, open /home/tester/.claude/a.jsonl');
      },
    };
    const h = harness({ importers: [failing] });

    await h.service.importBatch([source]);

    const failure = warned.find((line) => line.startsWith('[legacy-import] Failed'));
    expect(failure).toBeDefined();
    expect(failure).toContain('ENOENT');
    expect(failure).not.toContain('/home/tester');
  });
});

/**
 * T067 回炉 — the three lines that turn a refusal into a Chinese sentence.
 *
 * `ClaudeSourceAdapter.test.ts` pins that the adapter THROWS a coded error, and
 * `legacyImportFailure.test.ts` pins that the renderer words a code it is
 * GIVEN. The join between them — `failureFields`, an `instanceof` check on a
 * class imported across modules — had no case at all. If it ever stops
 * matching (a duplicated class through a bundler split, a refactor that wraps
 * the error), the item quietly falls back to the English sentence: D9 back
 * verbatim, with every existing test still green.
 */
describe('LegacyImportService coded failures (T067)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function refusing(failure?: ConstructorParameters<typeof ClaudeImportSourceError>[1]) {
    const importer: LegacySourceImporter = {
      source: 'claude-code',
      scan: async () => ({ projects: [], sessions: [] }),
      convert: async () => {
        throw new ClaudeImportSourceError(
          'This conversation has 9000 entries; the import limit is 4000.',
          failure
        );
      },
    };
    return importer;
  }

  it('hands the renderer the code and the ceiling, beside the English sentence', async () => {
    const h = harness({
      importers: [refusing({ code: 'source-entry-limit', params: { limit: 4000 } })],
    });

    // The exact call the IPC handler makes (`ipc/legacyImport.ts`), so this is
    // the payload that crosses to the renderer.
    const result = await h.service.importBatch([source]);

    expect(result.results[0]).toMatchObject({
      status: 'failed',
      errorCode: 'source-entry-limit',
      errorParams: { limit: 4000 },
    });
    // The sentence survives too — it is the log's copy and the fallback.
    expect(result.results[0]?.error).toContain('the import limit is 4000');
  });

  it('carries the byte ceiling the same way', async () => {
    const h = harness({
      importers: [refusing({ code: 'source-byte-limit', params: { limit: 67_108_864 } })],
    });

    const result = await h.service.importBatch([source]);

    expect(result.results[0]?.errorCode).toBe('source-byte-limit');
    expect(result.results[0]?.errorParams).toEqual({ limit: 67_108_864 });
  });

  it('adds no code to a refusal that carries none', async () => {
    const h = harness({ importers: [refusing()] });

    const result = await h.service.importBatch([source]);

    expect(result.results[0]?.status).toBe('failed');
    expect(result.results[0]?.errorCode).toBeUndefined();
    expect(result.results[0]?.errorParams).toBeUndefined();
  });

  it('adds no code to an ordinary error, so only the two ceilings are re-worded', async () => {
    const plain: LegacySourceImporter = {
      source: 'claude-code',
      scan: async () => ({ projects: [], sessions: [] }),
      convert: async () => {
        throw new Error('source file vanished');
      },
    };
    const h = harness({ importers: [plain] });

    const result = await h.service.importBatch([source]);

    expect(result.results[0]?.error).toBe('source file vanished');
    expect(result.results[0]?.errorCode).toBeUndefined();
  });
});
