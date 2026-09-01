import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  SessionIndexEntry,
  WorkerImportConversationPayload,
  WorkerImportConversationResult,
} from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSessionScanner } from '../ClaudeSessionScanner';
import { LegacyImportManifest } from '../LegacyImportManifest';
import { LegacyImportService, type LegacyImportSessionIndex } from '../LegacyImportService';

let root: string;
let configDir: string;
let workspacePath: string;
let sourceFile: string;
let manifestPath: string;
const TEST_INTEGRITY_KEY = Buffer.alloc(32, 7);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'legacy-import-service-'));
  configDir = path.join(root, 'claude');
  workspacePath = path.join(root, 'workspace');
  sourceFile = path.join(configDir, 'projects', 'project-a', 'session-a.jsonl');
  manifestPath = path.join(root, 'manifest.json');
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeSource('hello');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSource(text: string): Promise<void> {
  await writeFile(
    sourceFile,
    `${JSON.stringify({ type: 'system', subtype: 'init', cwd: workspacePath })}\n${JSON.stringify({ type: 'user', uuid: 'u1', cwd: workspacePath, message: { role: 'user', content: text } })}\n${JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: `answer:${text}` }] } })}\n`,
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

function harness(
  options: {
    manifest?: LegacyImportManifest;
    disposeFails?: boolean;
    mutateSourceAfterImport?: boolean;
  } = {}
) {
  const index = new FakeIndex();
  const manifest =
    options.manifest ??
    new LegacyImportManifest({ manifestPath, integrityKey: TEST_INTEGRITY_KEY });
  let id = 0;
  const createImport = vi.fn(async (payload: WorkerImportConversationPayload) => {
    const finalSessionFile = path.join(root, `probe_${payload.targetPiSessionId}.jsonl`);
    await writeFile(finalSessionFile, 'native-pi-session\n', 'utf8');
    if (options.mutateSourceAfterImport) {
      await writeFile(
        sourceFile,
        `${await import('node:fs/promises').then(({ readFile }) => readFile(sourceFile, 'utf8'))}changed\n`,
        'utf8'
      );
    }
    const result: WorkerImportConversationResult = {
      logicalSessionId: payload.logicalSessionId,
      piSessionId: payload.targetPiSessionId,
      workspacePath: payload.conversation.workspacePath,
      stagedSessionFile: `${finalSessionFile}.staged`,
      finalSessionFile,
      leaf: { activeEntryId: 'leaf', fileTailEntryId: 'leaf' },
      history: {
        logicalSessionId: payload.logicalSessionId,
        sessionFile: finalSessionFile,
        workspacePath: payload.conversation.workspacePath,
        page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
      },
    };
    let disposed = false;
    return {
      result,
      pid: 123,
      discard: vi.fn(async () => {
        if (disposed) return false;
        await unlink(finalSessionFile).catch(() => undefined);
        return true;
      }),
      dispose: vi.fn(async () => {
        disposed = true;
        if (options.disposeFails) throw new Error('dispose failed');
      }),
      forceKillNow: vi.fn(() => {
        disposed = true;
        return true;
      }),
    };
  });
  const inspectImport = vi.fn(async (payload: { targetPiSessionId: string }) => {
    const candidate = path.join(root, `probe_${payload.targetPiSessionId}.jsonl`);
    try {
      await import('node:fs/promises').then(({ stat }) => stat(candidate));
      return { sessionFiles: [candidate] };
    } catch {
      return { sessionFiles: [] };
    }
  });
  const service = new LegacyImportService({
    scanner: new ClaudeSessionScanner({
      resolveRoots: () => [{ dir: configDir, kind: 'legacy' }],
    }),
    manifest,
    sessionIndex: index,
    createImport,
    inspectImport,
    reconcileImport: vi.fn(async (payload) => {
      const inspected = await inspectImport(payload);
      for (const file of inspected.sessionFiles) await unlink(file).catch(() => undefined);
      return { removedFiles: inspected.sessionFiles.length, remainingFiles: 0 };
    }),
    createId: () => `id-${++id}`,
    now: () => 100,
  });
  return { service, manifest, index, createImport, inspectImport };
}

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

  it('single-flights concurrent requests for the same snapshot', async () => {
    const h = harness();
    const [left, right] = await Promise.all([
      h.service.importBatch([source]),
      h.service.importBatch([source]),
    ]);
    expect(h.createImport).toHaveBeenCalledTimes(1);
    expect(left.results[0]?.session?.sessionId).toBe(right.results[0]?.session?.sessionId);
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

  it('does not roll back a committed import when worker disposal fails after manifest completion', async () => {
    const h = harness({ disposeFails: true });
    const result = await h.service.importBatch([source]);
    expect(result.results[0]?.status).toBe('imported');
    expect(h.index.rows.size).toBe(1);
    const record = (await h.manifest.list())[0];
    expect(record?.status).toBe('complete');
    expect(
      await import('node:fs/promises').then(({ stat }) => stat(record?.targetSessionFile ?? ''))
    ).toMatchObject({ size: expect.any(Number) });
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
    const imported = await call.value;
    await expect(
      import('node:fs/promises').then(({ stat }) => stat(imported.result.finalSessionFile))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await h.manifest.list())[0]?.status).toBe('failed');
    expect(h.index.rows.size).toBe(0);
  });
});
