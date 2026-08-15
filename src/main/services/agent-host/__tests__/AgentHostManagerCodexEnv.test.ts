import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      codexHomeManagedDir: undefined,
    });
    expect(vaultReadMock).not.toHaveBeenCalled();
  });

  it('flag on + vault ok: marker + api key + managed dir all populated', async () => {
    managedFlagMock.mockReturnValue(true);
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: { payload: { codex: { apiKey: 'sk-vault-key', baseUrl: 'https://cch.example/v1' } } },
    });
    const { resolveCodexManagedHostEnv } = await import('../AgentHostManager');

    expect(resolveCodexManagedHostEnv()).toEqual({
      codexManaged: '1',
      codexApiKey: 'sk-vault-key',
      codexHomeManagedDir: '/userdata/codex-home',
    });
  });

  it.each([
    'absent',
    'locked',
    'unsupported',
    'invalid',
  ])('flag on + vault %s: marker + dir still populated, api key undefined (agent-host resolver turns this into managed_missing_credentials)', async (status) => {
    managedFlagMock.mockReturnValue(true);
    vaultReadMock.mockReturnValue({ status });
    const { resolveCodexManagedHostEnv } = await import('../AgentHostManager');

    const result = resolveCodexManagedHostEnv();
    expect(result.codexManaged).toBe('1');
    expect(result.codexHomeManagedDir).toBe('/userdata/codex-home');
    expect(result.codexApiKey).toBeUndefined();
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
