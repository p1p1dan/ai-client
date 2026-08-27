import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D47 S3b §1 / I5 epoch barrier — `resolveCodexManagedHostEnv()` (the
 * flag+vault → three-key resolver `AgentHostManager.startInternal()` feeds
 * `buildAgentHostEnv`) and the `ensureStarted()`/`shutdown()` shutdown-in-flight
 * gate. Separate file from `AgentHostManager.test.ts` on purpose: this suite
 * needs its own `../auth` mock (a controllable vault double + flag toggle)
 * that the base suite has no reason to carry, mirroring
 * `OnboardingServiceManagedHome.test.ts`'s "new file so the existing suite's
 * setup stays untouched" convention.
 */

const vaultReadMock = vi.fn();
const managedFlagMock = vi.fn();

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app',
    getPath: () => '/userdata',
    getVersion: () => '0.0.0-test',
  },
}));

const logSpy = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../../utils/logger', () => ({ default: logSpy, initLogger: vi.fn() }));

vi.mock('../../auth', () => ({
  getCredentialVault: () => ({ read: vaultReadMock }),
}));

vi.mock('../../auth/AuthStateService', () => ({
  resolveManagedCredentialsEnabled: () => managedFlagMock(),
}));

class FakeAgentHostProcess extends EventEmitter {
  isRunning = true;
  send = vi.fn();
  stop: () => Promise<void>;

  constructor(stopImpl: () => Promise<void> = () => Promise.resolve()) {
    super();
    this.stop = vi.fn(stopImpl);
  }
}

beforeEach(() => {
  vaultReadMock.mockReset();
  managedFlagMock.mockReset();
});

describe('resolveCodexManagedHostEnv (D47 S3b §1)', () => {
  it('flag off: all three keys undefined, and the vault is never read', async () => {
    managedFlagMock.mockReturnValue(false);
    const { resolveCodexManagedHostEnv } = await import('../AgentHostManager');

    expect(resolveCodexManagedHostEnv()).toEqual({
      codexManaged: undefined,
      codexApiKey: undefined,
      codexBaseUrl: undefined,
    });
    expect(vaultReadMock).not.toHaveBeenCalled();
  });

  it('flag on + vault ok: marker + both credential halves populated', async () => {
    managedFlagMock.mockReturnValue(true);
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: { payload: { codex: { apiKey: 'sk-vault-key', baseUrl: 'https://cch.example/v1' } } },
    });
    const { resolveCodexManagedHostEnv } = await import('../AgentHostManager');

    expect(resolveCodexManagedHostEnv()).toEqual({
      codexManaged: '1',
      codexApiKey: 'sk-vault-key',
      codexBaseUrl: 'https://cch.example/v1',
    });
  });

  it.each([
    'absent',
    'locked',
    'unsupported',
    'invalid',
  ])('flag on + vault %s: marker still populated, both credential halves undefined (agent-host resolver turns this into managed_missing_credentials)', async (status) => {
    managedFlagMock.mockReturnValue(true);
    vaultReadMock.mockReturnValue({ status });
    const { resolveCodexManagedHostEnv } = await import('../AgentHostManager');

    const result = resolveCodexManagedHostEnv();
    expect(result.codexManaged).toBe('1');
    expect(result.codexApiKey).toBeUndefined();
    expect(result.codexBaseUrl).toBeUndefined();
  });

  it('reads the vault fresh every call — no caching across calls', async () => {
    managedFlagMock.mockReturnValue(true);
    vaultReadMock
      .mockReturnValueOnce({
        status: 'ok',
        doc: { payload: { codex: { apiKey: 'sk-old', baseUrl: 'https://old.example/v1' } } },
      })
      .mockReturnValueOnce({
        status: 'ok',
        doc: { payload: { codex: { apiKey: 'sk-new', baseUrl: 'https://new.example/v1' } } },
      });
    const { resolveCodexManagedHostEnv } = await import('../AgentHostManager');

    expect(resolveCodexManagedHostEnv().codexApiKey).toBe('sk-old');
    expect(resolveCodexManagedHostEnv().codexApiKey).toBe('sk-new');
    expect(vaultReadMock).toHaveBeenCalledTimes(2);
  });
});

describe('AgentHostManager I5 epoch barrier — shutdown-in-flight gates ensureStarted (D47 S3b, B-track B3 五步)', () => {
  it('old host running -> vault changes -> shutdown triggered but not yet complete -> a concurrent create (ensureStarted) does not spawn until shutdown lands -> the new spawn reads the NEW vault snapshot', async () => {
    // Step 1: "旧 host 在跑" — prime state directly (same trick the base
    // suite uses), with a controllable stop() so shutdown can be held open.
    managedFlagMock.mockReturnValue(true);
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: { payload: { codex: { apiKey: 'sk-old-epoch', baseUrl: 'https://old.example/v1' } } },
    });

    const { AgentHostManager } = await import('../AgentHostManager');
    const manager = new AgentHostManager();

    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const oldProc = new FakeAgentHostProcess(() => stopGate);

    const internals = manager as unknown as {
      process: FakeAgentHostProcess | null;
      state: 'stopped' | 'starting' | 'ready' | 'error';
      startInternal(): Promise<void>;
    };
    internals.state = 'ready';
    internals.process = oldProc;

    // Step: stub startInternal so this test never spawns a real process —
    // its own body reads the CURRENT vault snapshot via
    // resolveCodexManagedHostEnv, exactly like the production method does,
    // so this test also proves "新 host 读新快照" instead of just asserting
    // ordering.
    const { resolveCodexManagedHostEnv } = await import('../AgentHostManager');
    const spawnSnapshots: Array<string | undefined> = [];
    const startInternalSpy = vi.fn(async () => {
      spawnSnapshots.push(resolveCodexManagedHostEnv().codexApiKey);
      internals.state = 'ready';
    });
    internals.startInternal = startInternalSpy;

    // Step 2/3: trigger shutdown (do NOT await yet — its proc.stop() is held
    // open by stopGate) — this is "shutdown 未完时".
    const shutdownPromise = manager.shutdown();
    // shutdownInternal nulls `process`/`state` synchronously before awaiting
    // proc.stop() — assert the old process reference is already gone
    // ("不落旧进程") even though the teardown itself hasn't finished.
    expect(internals.process).toBeNull();
    expect(internals.state).toBe('stopped');

    // Vault changes while the old Host is still mid-teardown.
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: { payload: { codex: { apiKey: 'sk-new-epoch', baseUrl: 'https://new.example/v1' } } },
    });

    // Step 4: a concurrent "create" request calls ensureStarted() while
    // shutdown is still in flight.
    const ensureStartedPromise = manager.ensureStarted();

    // Give both promise chains a couple of microtask turns — if the I5 gate
    // were absent, ensureStarted() would already have called startInternal()
    // by now (oldProc.stop() being pending is otherwise invisible to it).
    await Promise.resolve();
    await Promise.resolve();
    expect(startInternalSpy).not.toHaveBeenCalled();

    // Step 5: shutdown lands — release the held-open stop() — and both
    // promises settle.
    releaseStop?.();
    await shutdownPromise;
    await ensureStartedPromise;

    expect(oldProc.stop).toHaveBeenCalledTimes(1);
    expect(startInternalSpy).toHaveBeenCalledTimes(1);
    // "新 host 读新快照": the (stubbed) spawn observed the POST-shutdown
    // vault value, not the one that was current when the old Host started.
    expect(spawnSnapshots).toEqual(['sk-new-epoch']);
  });
});

/**
 * Packaging spec §7.2 B4 / B5 — the three injection criteria for
 * `AICLIENT_CODEX_JS_PATH` and the seam that feeds them to `buildAgentHostEnv`.
 */
describe('resolveCodexJsPathForEnv (B4 — three criteria)', () => {
  let tmp: string;
  const ENV_KEY = 'AICLIENT_CODEX_JS_PATH';
  const original = process.env[ENV_KEY];

  /** Build a Host entry whose sibling node_modules holds a real codex.js. */
  function makeBundle(root: string, { size = 32 } = {}): string {
    const entry = nodePath.join(root, 'agent-host', 'index.js');
    const codexJs = nodePath.join(
      root,
      'agent-host',
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js'
    );
    fs.mkdirSync(nodePath.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// host\n');
    fs.mkdirSync(nodePath.dirname(codexJs), { recursive: true });
    fs.writeFileSync(codexJs, 'x'.repeat(size));
    return entry;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codex-js-path-'));
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('arm 2: not set + bundled file present → injects the bundled path', async () => {
    const entry = makeBundle(tmp);
    const { resolveCodexJsPathForEnv } = await import('../AgentHostManager');
    expect(resolveCodexJsPathForEnv(entry)).toBe(
      nodePath.join(tmp, 'agent-host', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    );
  });

  it('arm 1: user already set the variable → omits, so their value survives', async () => {
    const entry = makeBundle(tmp);
    process.env[ENV_KEY] = '/opt/mycodex/bin/codex.js';
    const { resolveCodexJsPathForEnv } = await import('../AgentHostManager');
    // M7 arm: dropping the "user env wins" criterion would return the bundled
    // path here and silently override a deliberately-set escape hatch.
    expect(resolveCodexJsPathForEnv(entry)).toBeUndefined();
  });

  it('arm 1: a whitespace-only value does not count as set', async () => {
    const entry = makeBundle(tmp);
    process.env[ENV_KEY] = '   ';
    const { resolveCodexJsPathForEnv } = await import('../AgentHostManager');
    expect(resolveCodexJsPathForEnv(entry)).toBe(
      nodePath.join(tmp, 'agent-host', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    );
  });

  it('arm 3: not set + bundled file missing → omits (mac / broken build / dev)', async () => {
    const entry = nodePath.join(tmp, 'agent-host', 'index.js');
    fs.mkdirSync(nodePath.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// host\n');
    const { resolveCodexJsPathForEnv } = await import('../AgentHostManager');
    expect(resolveCodexJsPathForEnv(entry)).toBeUndefined();
  });

  it('arm 3: a same-named DIRECTORY is not usable (M17 — isFile, not exists)', async () => {
    const entry = nodePath.join(tmp, 'agent-host', 'index.js');
    fs.mkdirSync(nodePath.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// host\n');
    fs.mkdirSync(
      nodePath.join(tmp, 'agent-host', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      { recursive: true }
    );
    const { resolveCodexJsPathForEnv } = await import('../AgentHostManager');
    expect(resolveCodexJsPathForEnv(entry)).toBeUndefined();
  });

  it('arm 3: a zero-byte codex.js is not usable', async () => {
    const entry = makeBundle(tmp, { size: 0 });
    const { resolveCodexJsPathForEnv } = await import('../AgentHostManager');
    expect(resolveCodexJsPathForEnv(entry)).toBeUndefined();
  });
});

describe('AgentHostManager seam (B5)', () => {
  const source = fs.readFileSync(
    nodePath.resolve(import.meta.dirname, '..', 'AgentHostManager.ts'),
    'utf8'
  );

  it('derives the path from the resolved Host entry, not a second resourcesPath join', () => {
    expect(source).toContain('const codexJsPath = resolveCodexJsPathForEnv(hostEntryPath);');
    // A second derivation would be a second source of truth and would point at
    // a non-existent path in the dev branch.
    expect(source).not.toContain("path.join(process.resourcesPath, 'agent-host', 'node_modules'");
  });

  it('feeds that derived value into buildAgentHostEnv', () => {
    expect(source).toContain('buildAgentHostEnv({');
    expect(source).toContain('codexJsPath,');
  });

  it('keeps all three criteria inside the one tested resolver', () => {
    // The criteria are asserted behaviourally above; this pins that they stay
    // in the resolver instead of being re-inlined at the call site where the
    // behaviour arms would no longer reach them.
    expect(source).toContain('const userOverride = process.env[CODEX_JS_PATH_ENV_KEY]?.trim();');
    expect(source).toContain('return isUsableFile(bundled) ? bundled : undefined;');
  });
});
