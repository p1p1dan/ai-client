import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DshHostSeeded, DshSeedImportResult } from '@shared/types/dshHostProtocol';
import type { ImportedConversation } from '@shared/types/legacyImport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DshLegacyImportHost,
  type DshLegacyImportSeeder,
  dshImportStubPath,
  dshImportTargetId,
  LegacyImportEngineError,
} from '../DshLegacyImportHost';

/**
 * dsh-rebase P1-9f (decision 056): the engine half of an import on the shared
 * DSH host, against a fake supervisor that answers `seeded` the way the
 * bridge does (the real host is in `dshSharedHost.integration.test.ts`).
 * Files are real, in a scratch directory standing in for `DSH_HOME`.
 */

let root = '';
let home = '';
const LOGICAL = 'session-import-codex-1';
const TARGET = dshImportTargetId(LOGICAL);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'p1-9f-import-host-'));
  home = path.join(root, 'dsh-home');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const conversation = (): ImportedConversation => ({
  schemaVersion: 1,
  importerVersion: 'b4-legacy-v2',
  sourceKind: 'codex',
  stableSourceIdentity: 'rollout',
  sourceSessionId: 's1',
  workspacePath: path.join(root, 'workspace'),
  title: 'hello',
  sourceFingerprint: {
    stableSourceIdentity: 'rollout',
    contentHash: 'c'.repeat(64),
    size: 1,
    mode: 0o100644,
    mtimeMs: 1,
  },
  entries: [
    { kind: 'user', text: 'hello' },
    { kind: 'assistant', blocks: [{ type: 'text', text: 'hi' }] },
  ],
  diagnostics: [],
});

const stubFile = () => dshImportStubPath(home, TARGET);
const sidecarOf = (file: string) => file.replace(/\.dsh\.json$/, '.dsh.grants.json');
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false
  );

async function writeStub(file: string, logicalSessionId = LOGICAL): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      engine: 'dsh',
      version: 2,
      dshSessionId: path.basename(file, '.dsh.json'),
      logicalSessionId,
      cwd: '/work',
      createdAt: 1,
    })
  );
}

function seeder(
  answer: (input: { logicalSessionId: string; cwd: string }) => Promise<unknown>
): DshLegacyImportSeeder & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    seedImportedConversation: vi.fn(async (input, options) => {
      calls.push({ input, options });
      return (await answer(input)) as DshHostSeeded<DshSeedImportResult>;
    }),
  };
}

/** What the bridge answers after writing the stub. */
function made(overrides: Partial<DshSeedImportResult> = {}) {
  return async (input: { logicalSessionId: string }) => {
    const file =
      overrides.stubFile ?? dshImportStubPath(home, `aiclient-${input.logicalSessionId}`);
    await writeStub(file, input.logicalSessionId);
    return {
      host: 'seeded',
      id: 1,
      ok: true,
      ms: 1,
      result: {
        kind: 'imported-conversation',
        stubFile: file,
        dshSessionId: `aiclient-${input.logicalSessionId}`,
        reused: false,
        images: { admitted: 0, refused: 0 },
        report: { converterVersion: 2, source: { kind: 'imported-conversation', entries: {} } },
        ...overrides,
      },
    };
  };
}

function engine(host: DshLegacyImportSeeder, warn = vi.fn()) {
  return {
    warn,
    engine: new DshLegacyImportHost({ host, dshHome: () => home, log: { warn } }),
  };
}

async function refusal(promise: Promise<unknown>): Promise<LegacyImportEngineError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyImportEngineError);
    return error as LegacyImportEngineError;
  }
  throw new Error('the import succeeded');
}

describe('DshLegacyImportHost.create', () => {
  it('asks the host for this chat in the resolved workspace, for the user, and hands back the stub', async () => {
    const host = seeder(made());
    const { engine: dsh } = engine(host);
    const input = conversation();
    const created = await dsh.create({
      logicalSessionId: LOGICAL,
      targetPiSessionId: TARGET,
      conversation: input,
    });
    expect(host.calls).toEqual([
      {
        input: { conversation: input, logicalSessionId: LOGICAL, cwd: input.workspacePath },
        options: { userInitiated: true },
      },
    ]);
    expect(created).toMatchObject({
      sessionFile: stubFile(),
      dshSessionId: TARGET,
      reused: false,
    });
    expect(await exists(stubFile())).toBe(true);
  });

  it('takes the import back: the stub and a sidecar beside it go, once and for all', async () => {
    const { engine: dsh } = engine(seeder(made()));
    const created = await dsh.create({
      logicalSessionId: LOGICAL,
      targetPiSessionId: TARGET,
      conversation: conversation(),
    });
    await writeFile(sidecarOf(created.sessionFile), '{"version":2,"grants":[]}');
    expect(await created.discard()).toBe(true);
    expect(await exists(created.sessionFile)).toBe(false);
    expect(await exists(sidecarOf(created.sessionFile))).toBe(false);
    // Gone already is gone.
    expect(await created.discard()).toBe(true);
  });

  it('refuses a target id that is not the chat’s own, without asking the host', async () => {
    const host = seeder(made());
    const { engine: dsh } = engine(host);
    const error = await refusal(
      dsh.create({
        logicalSessionId: LOGICAL,
        targetPiSessionId: 'import-codex-1',
        conversation: conversation(),
      })
    );
    expect([error.stage, error.code]).toEqual(['request', 'import_target_mismatch']);
    expect(host.calls).toEqual([]);
  });

  it('reports where the host stopped, and keeps the host’s message (a path) to the log', async () => {
    const input = conversation();
    const { engine: dsh, warn } = engine(
      seeder(async () => ({
        host: 'seeded',
        id: 1,
        ok: false,
        ms: 1,
        error: {
          stage: 'create',
          code: 'seed_create_failed',
          message: `DSH did not create in ${input.workspacePath}`,
          retryable: false,
        },
      }))
    );
    const error = await refusal(
      dsh.create({ logicalSessionId: LOGICAL, targetPiSessionId: TARGET, conversation: input })
    );
    expect([error.stage, error.code, error.retryable]).toEqual([
      'create',
      'seed_create_failed',
      false,
    ]);
    expect(error.message).toContain('(create/seed_create_failed)');
    expect(error.message).not.toContain(input.workspacePath);
    expect(String(warn.mock.calls[0]?.[0])).toContain('seed_create_failed');
  });

  it.each([
    ['DSH_HOST_SEED_TIMEOUT', 'seed_timeout', true],
    ['DSH_HOST_SEED_INTERRUPTED', 'host_exited', true],
    ['DSH_HOST_SEED_MALFORMED', 'seed_answer_invalid', false],
    ['DSH_HOST_UNAVAILABLE', 'host_unavailable', true],
  ])('maps the supervisor’s %s to host/%s', async (code, expected, retryable) => {
    const { engine: dsh } = engine(
      seeder(async () => {
        throw Object.assign(new Error(`${code}: no`), { code });
      })
    );
    const error = await refusal(
      dsh.create({
        logicalSessionId: LOGICAL,
        targetPiSessionId: TARGET,
        conversation: conversation(),
      })
    );
    expect([error.stage, error.code, error.retryable]).toEqual(['host', expected, retryable]);
  });

  it('refuses a stub named other than the target, and takes it back', async () => {
    const odd = dshImportStubPath(home, 'aiclient-something-else');
    const { engine: dsh } = engine(seeder(made({ stubFile: odd })));
    const error = await refusal(
      dsh.create({
        logicalSessionId: LOGICAL,
        targetPiSessionId: TARGET,
        conversation: conversation(),
      })
    );
    expect([error.stage, error.code]).toEqual(['stub', 'import_stub_misnamed']);
    expect(await exists(odd)).toBe(false);
  });
});

describe('DshLegacyImportHost.inspect and reconcile', () => {
  const target = (extra: { targetSessionFile?: string; targetPiSessionId?: string } = {}) => ({
    logicalSessionId: LOGICAL,
    workspacePath: '/work',
    targetPiSessionId: TARGET,
    ...extra,
  });

  it('finds the stub the target names, with or without the manifest’s record of it', async () => {
    const { engine: dsh } = engine(seeder(made()));
    expect(await dsh.inspect(target())).toEqual({ sessionFiles: [] });
    await writeStub(stubFile());
    expect(await dsh.inspect(target())).toEqual({ sessionFiles: [stubFile()] });
    expect(await dsh.inspect(target({ targetSessionFile: stubFile() }))).toEqual({
      sessionFiles: [stubFile()],
    });
  });

  it('reports a 1.0.x import’s pi file, and never removes it', async () => {
    const piFile = path.join(root, 'pi-agent', 'sessions', 'import-codex-old.jsonl');
    await mkdir(path.dirname(piFile), { recursive: true });
    await writeFile(piFile, 'pi');
    const { engine: dsh } = engine(seeder(made()));
    const legacy = target({ targetPiSessionId: 'import-codex-old', targetSessionFile: piFile });
    expect(await dsh.inspect(legacy)).toEqual({ sessionFiles: [piFile] });
    expect(await dsh.reconcile(legacy)).toEqual({ removedFiles: 0, remainingFiles: 0 });
    expect(await readFile(piFile, 'utf8')).toBe('pi');
  });

  it('removes an unfinished import’s stub and sidecar, here and where the manifest recorded it', async () => {
    const moved = dshImportStubPath(path.join(root, 'old-home'), TARGET);
    await writeStub(stubFile());
    await writeStub(moved);
    await writeFile(sidecarOf(stubFile()), '{}');
    const { engine: dsh } = engine(seeder(made()));
    expect(await dsh.reconcile(target({ targetSessionFile: moved }))).toEqual({
      removedFiles: 2,
      remainingFiles: 0,
    });
    expect(await exists(stubFile())).toBe(false);
    expect(await exists(sidecarOf(stubFile()))).toBe(false);
    expect(await exists(moved)).toBe(false);
  });

  it('leaves a stub that names another chat alone, and does not count it as this import’s', async () => {
    await writeStub(stubFile(), 'someone-else');
    const { engine: dsh } = engine(seeder(made()));
    expect(await dsh.reconcile(target())).toEqual({ removedFiles: 0, remainingFiles: 0 });
    expect(await exists(stubFile())).toBe(true);
  });

  it('counts its own stub it could not remove as remaining', async () => {
    await writeStub(stubFile());
    const dsh = new DshLegacyImportHost({
      host: seeder(made()),
      dshHome: () => home,
      removeFile: async () => undefined,
      log: { warn: () => undefined },
    });
    expect(await dsh.reconcile(target())).toEqual({ removedFiles: 0, remainingFiles: 1 });
  });
});
