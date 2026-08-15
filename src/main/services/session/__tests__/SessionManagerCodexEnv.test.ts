import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetManagedFileWriterQueuesForTests } from '../../auth/managedFileWriter';

/**
 * D47 S34 spec rev.2 §2 S3b — `SessionManager.create`'s local-PTY branch:
 * `CODEX_HOME` / `AICLIENT_CODEX_API_KEY` injection. B-track B6 六面接缝:
 * ① input carries no secret (caller-supplied `options.env` never needs one)
 * ② output has it (flag on: the object handed to `localPtyManager.create`
 *    carries both keys) ③ the input `options` object is never mutated
 * ④ Main's values win over a renderer-supplied same-named key ⑤ remote path
 * never gets it ⑥ flag off is a byte-for-byte zero mutation (same object
 * reference, not just "same shape").
 *
 * Separate file from `SessionManagerTrust.test.ts` — this suite needs its
 * own `../../auth` vault mock (a controllable read()), which the trust
 * suite has no reason to carry.
 */

const vaultReadMock = vi.fn();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => globalThis.__testUserDataDir as string) },
  BrowserWindow: {
    fromWebContents: vi.fn(),
    fromId: vi.fn(() => null),
  },
}));

vi.mock('../../remote/RemoteConnectionManager', () => ({
  remoteConnectionManager: {
    getStatus: vi.fn(),
    call: vi.fn(),
    addEventListener: vi.fn(),
    onDidDisconnect: vi.fn(),
    onDidStatusChange: vi.fn(),
  },
}));

vi.mock('../../auth', () => ({
  getCredentialVault: () => ({ read: vaultReadMock }),
}));

/**
 * Real `node-pty` never runs under vitest — this fake is only used by the
 * "end-to-end spawn env" describe block below, which keeps `PtyManager`
 * itself REAL (unlike every other test in this file, which mocks
 * `localPtyManager.create` directly and never reaches `node-pty` at all) so
 * the actual `{...process.env, ...options.env}` merge
 * (`PtyManager.ts` — not part of this slice's file set, deliberately
 * unmodified) is the thing under test for the CLAUDE_CONFIG_DIR pin below.
 */
const spawnMock = vi.fn(
  (_file: string, _args: string[] | string, _options: { env?: Record<string, string> }) => ({
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    pid: 4242,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })
);
vi.mock('node-pty', () => ({ spawn: spawnMock }));

declare global {
  // eslint-disable-next-line no-var
  var __testUserDataDir: string;
}

describe('SessionManager.create local-PTY Codex env injection (D47 S3b §2, B-track B6 六面)', () => {
  const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;
  let userDataDir: string;

  beforeEach(() => {
    vi.resetModules();
    userDataDir = mkdtempSync(join(tmpdir(), 'session-manager-codex-env-'));
    globalThis.__testUserDataDir = userDataDir;
    resetManagedFileWriterQueuesForTests();
    vaultReadMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(userDataDir, { recursive: true, force: true });
    if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
  });

  function codexHomeDir(): string {
    return join(userDataDir, 'codex-home');
  }

  it('② flag on + vault ok: injects CODEX_HOME + AICLIENT_CODEX_API_KEY', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: { payload: { codex: { apiKey: 'sk-vault-key', baseUrl: 'https://cch.example/v1' } } },
    });

    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    const createSpy = vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');

    await manager.create(1, { cwd: '/repo/local', kind: 'terminal' });

    const passedOptions = createSpy.mock.calls[0][0];
    expect(passedOptions.env).toEqual({
      CODEX_HOME: codexHomeDir(),
      AICLIENT_CODEX_API_KEY: 'sk-vault-key',
    });
  });

  it.each([
    'absent',
    'locked',
    'unsupported',
    'invalid',
  ])('vault %s (flag on): CODEX_HOME still injected, AICLIENT_CODEX_API_KEY key OMITTED (not merely undefined)', async (status) => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    vaultReadMock.mockReturnValue({ status });

    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    const createSpy = vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');

    await manager.create(1, { cwd: '/repo/local', kind: 'terminal' });

    const passedEnv = createSpy.mock.calls[0][0].env as Record<string, string>;
    expect(passedEnv.CODEX_HOME).toBe(codexHomeDir());
    expect('AICLIENT_CODEX_API_KEY' in passedEnv).toBe(false);
  });

  it('④ Main values win over a renderer-supplied same-named key (B-track B6 合并向)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: { payload: { codex: { apiKey: 'sk-main-key', baseUrl: 'https://cch.example/v1' } } },
    });

    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    const createSpy = vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');

    await manager.create(1, {
      cwd: '/repo/local',
      kind: 'terminal',
      env: { CODEX_HOME: '/renderer/stale/dir', AICLIENT_CODEX_API_KEY: 'sk-renderer-stale' },
    });

    const passedEnv = createSpy.mock.calls[0][0].env as Record<string, string>;
    expect(passedEnv.CODEX_HOME).toBe(codexHomeDir());
    expect(passedEnv.AICLIENT_CODEX_API_KEY).toBe('sk-main-key');
  });

  it('③ does not mutate the caller-supplied options object (or its env sub-object) in place', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: { payload: { codex: { apiKey: 'sk-vault-key', baseUrl: 'https://cch.example/v1' } } },
    });

    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    const createSpy = vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');

    const originalEnv = { SOME_RENDERER_KEY: 'renderer-value' };
    const options = { cwd: '/repo/local', kind: 'terminal' as const, env: originalEnv };

    await manager.create(1, options);

    // The object handed to localPtyManager.create is a DIFFERENT object...
    const passedOptions = createSpy.mock.calls[0][0];
    expect(passedOptions).not.toBe(options);
    expect(passedOptions.env).not.toBe(originalEnv);
    // ...and the caller's own objects are untouched.
    expect(options.env).toBe(originalEnv);
    expect(originalEnv).toEqual({ SOME_RENDERER_KEY: 'renderer-value' });
  });

  it('⑥ flag off: the SAME options object reference reaches localPtyManager.create (byte-for-byte zero mutation, not just same shape)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';

    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    const createSpy = vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');

    const options = { cwd: '/repo/local', kind: 'terminal' as const };
    await manager.create(1, options);

    expect(createSpy.mock.calls[0][0]).toBe(options);
    expect(vaultReadMock).not.toHaveBeenCalled();
  });

  it('⑤ remote path: never injects CODEX_HOME/AICLIENT_CODEX_API_KEY, even with the flag on', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: {
        payload: { codex: { apiKey: 'sk-should-not-appear', baseUrl: 'https://cch.example/v1' } },
      },
    });

    const { SessionManager } = await import('../SessionManager');
    const { remoteConnectionManager } = await import('../../remote/RemoteConnectionManager');
    vi.mocked(remoteConnectionManager.call).mockResolvedValue({
      session: {
        sessionId: 'r1',
        backend: 'remote',
        kind: 'terminal',
        cwd: '/remote/path',
        persistOnDisconnect: true,
        createdAt: Date.now(),
      },
      replay: '',
    });
    vi.mocked(remoteConnectionManager.getStatus).mockReturnValue({
      connectionId: 'conn-1',
      connected: true,
      recoverable: false,
    });
    vi.mocked(remoteConnectionManager.addEventListener).mockResolvedValue(() => {});

    const manager = new SessionManager();
    await manager.create(1, {
      cwd: '/__aiclient_remote__/conn-1/remote/path',
      kind: 'terminal',
    });

    const forwardedCall = vi.mocked(remoteConnectionManager.call).mock.calls[0];
    const forwardedOptions = forwardedCall[2] as { options: { env?: Record<string, string> } };
    expect(forwardedOptions.options.env).toBeUndefined();
    expect(vaultReadMock).not.toHaveBeenCalled();
  });
});

/**
 * D47 S34 spec rev.2 §2 S3b — "claude 侧 pin": CODEX_HOME/AICLIENT_CODEX_API_KEY
 * flow through `SessionManager`'s own `options.env` construction (proven
 * above); `CLAUDE_CONFIG_DIR` flows through a COMPLETELY DIFFERENT path —
 * `activateManagedClaudeHome()` sets it on `process.env` for the whole Main
 * process (`managedClaudeHomeStartup.ts`, S2a), and `PtyManager.create`'s
 * `finalEnv` starts with `{...process.env, ...}`. This slice never touches
 * that mechanism, so this is a REGRESSION PIN, not new behavior: it keeps
 * `PtyManager` REAL (mocking only the underlying `node-pty` binding) to prove
 * the full chain — Main process env → PtyManager merge → the actual
 * `pty.spawn` call — still carries `CLAUDE_CONFIG_DIR` alongside the new
 * Codex keys, rather than trusting the claim by inspection alone.
 */
describe('end-to-end local PTY spawn env (D47 S3b — real PtyManager, mocked node-pty)', () => {
  const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let userDataDir: string;

  beforeEach(() => {
    vi.resetModules();
    userDataDir = mkdtempSync(join(tmpdir(), 'session-manager-codex-env-e2e-'));
    globalThis.__testUserDataDir = userDataDir;
    resetManagedFileWriterQueuesForTests();
    vaultReadMock.mockReset();
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(userDataDir, { recursive: true, force: true });
    if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  });

  it('flag on: the real pty.spawn() call carries CLAUDE_CONFIG_DIR (inherited from process.env) AND the Main-injected CODEX_HOME/AICLIENT_CODEX_API_KEY together', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    // Mirrors what `activateManagedClaudeHome()` does at boot — this slice
    // doesn't call it (out of scope), so the pin sets the same process.env
    // key directly.
    process.env.CLAUDE_CONFIG_DIR = join(userDataDir, 'claude-home');
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: { payload: { codex: { apiKey: 'sk-e2e-key', baseUrl: 'https://cch.example/v1' } } },
    });

    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');

    await manager.create(1, {
      cwd: '/repo/local',
      kind: 'terminal',
      // A real, existing, cross-platform-safe "shell" path — node-pty is
      // mocked, so this is never actually executed, only stat'd by
      // PtyManager's `existsSync(shell)` fallback-shell check.
      shell: process.execPath,
      args: [],
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnEnv = spawnMock.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.CLAUDE_CONFIG_DIR).toBe(join(userDataDir, 'claude-home'));
    expect(spawnEnv.CODEX_HOME).toBe(join(userDataDir, 'codex-home'));
    expect(spawnEnv.AICLIENT_CODEX_API_KEY).toBe('sk-e2e-key');
  });
});
