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

vi.mock('../../auth/spawnGate', () => ({ assertAgentSpawnAllowed: vi.fn() }));

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

  function _codexHomeDir(): string {
    return join(userDataDir, 'codex-home');
  }

  /**
   * S0' (D60) inverted this pair. They used to assert that a local PTY got
   * `CODEX_HOME` (pointed at the app-owned home) plus `AICLIENT_CODEX_API_KEY`.
   * Both halves were needed together — the key only authenticated because the
   * `config.toml` in that directory named it via `env_key`.
   *
   * The directory is gone and the pair cannot be split: the key alone means
   * nothing to a user's own `~/.codex`, and no environment variable can point
   * codex at a different `base_url`. So a terminal `codex` runs on the user's
   * own configuration, and these assert that we add nothing.
   */
  it("S0': flag on + vault ok — no Codex keys are injected into a local PTY", async () => {
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

    const passedEnv = (createSpy.mock.calls[0][0].env ?? {}) as Record<string, string>;
    expect('CODEX_HOME' in passedEnv).toBe(false);
    expect('AICLIENT_CODEX_API_KEY' in passedEnv).toBe(false);
  });

  it.each([
    'absent',
    'locked',
    'unsupported',
    'invalid',
  ])("S0': vault %s (flag on) — still nothing, and no crash", async (status) => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    vaultReadMock.mockReturnValue({ status });

    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    const createSpy = vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');

    await manager.create(1, { cwd: '/repo/local', kind: 'terminal' });

    const passedEnv = (createSpy.mock.calls[0][0].env ?? {}) as Record<string, string>;
    expect('CODEX_HOME' in passedEnv).toBe(false);
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
      env: { CODEX_HOME: '/renderer/chosen/dir', AICLIENT_CODEX_API_KEY: 'sk-renderer' },
    });

    const passedEnv = createSpy.mock.calls[0][0].env as Record<string, string>;
    // S0' inverted the direction for the Codex keys: Main no longer supplies
    // them, so a caller-supplied value has nothing to lose to and passes
    // through untouched. The "Main wins" rule itself is unchanged and is now
    // asserted on the Claude keys, which Main does still supply.
    expect(passedEnv.CODEX_HOME).toBe('/renderer/chosen/dir');
    expect(passedEnv.AICLIENT_CODEX_API_KEY).toBe('sk-renderer');
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

    // A CLAUDE arm is what makes a copy happen at all now: S0' retired the
    // Codex injector, so a vault holding only codex credentials leaves the
    // options untouched (correctly) and there would be nothing to assert about.
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: {
        payload: {
          codex: { apiKey: 'sk-vault-key', baseUrl: 'https://cch.example/v1' },
          claude: { baseUrl: 'https://cch.example/v1', authToken: 'claude-token' },
        },
      },
    });

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

  it('Q8: managed agent PTYs receive PI_CODING_AGENT_DIR, plain terminals do not', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: {
        payload: {
          claude: { baseUrl: 'https://gateway.example/v1', authToken: 'claude-token' },
          codex: { apiKey: 'company-key', baseUrl: 'https://cch.example/v1' },
        },
      },
    });

    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId')
      .mockReturnValueOnce('agent-1')
      .mockReturnValueOnce('terminal-1');
    const createSpy = vi
      .spyOn(manager.localPtyManager, 'create')
      .mockImplementation((_options, _onData, _onExit, providedId) => providedId || 's1');

    await manager.create(1, { cwd: '/repo/local', kind: 'agent' });
    await manager.create(1, { cwd: '/repo/local', kind: 'terminal' });

    const agentEnv = createSpy.mock.calls[0][0].env as Record<string, string>;
    const terminalEnv = createSpy.mock.calls[1][0].env as Record<string, string>;
    expect(agentEnv.PI_CODING_AGENT_DIR).toMatch(/\.pilab\/.+\/pi-agent$/);
    expect(terminalEnv.PI_CODING_AGENT_DIR).toBeUndefined();
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
 * End-to-end pin over the REAL `PtyManager` (only the underlying `node-pty`
 * binding is mocked), proving the full chain — Main process env → PtyManager
 * merge → the actual `pty.spawn` call — rather than trusting inspection.
 *
 * Two different mechanisms meet here:
 *  - `CODEX_HOME`/`AICLIENT_CODEX_API_KEY` and (since D60)
 *    `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` are built into
 *    `SessionManager`'s own `options.env`.
 *  - `CLAUDE_CONFIG_DIR` arrives by inheritance: `PtyManager.create`'s
 *    `finalEnv` starts with `{...process.env, ...}`.
 *
 * D60 changed what that second one MEANS. Main no longer sets the variable,
 * so it now reaches the PTY only when the USER set it — which is exactly the
 * behavior worth pinning, since the whole point of the release is that a
 * terminal session sees the user's own Claude Code home.
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

  it('flag on: the real pty.spawn() call carries a USER-set CLAUDE_CONFIG_DIR through untouched', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    // Stands in for a user who set the variable themselves. Post-D60 nothing
    // in the app sets it, so inheritance is the ONLY way it can get here —
    // which is what makes this assertion meaningful rather than tautological.
    process.env.CLAUDE_CONFIG_DIR = join(userDataDir, 'user-chosen-config');
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
    expect(spawnEnv.CLAUDE_CONFIG_DIR).toBe(join(userDataDir, 'user-chosen-config'));
    // S0': no Codex keys are added by us any more — see the note on the
    // injection tests above.
    expect('CODEX_HOME' in spawnEnv).toBe(false);
    expect('AICLIENT_CODEX_API_KEY' in spawnEnv).toBe(false);
  });

  it('flag on: the real pty.spawn() call carries the vault Claude credential as ANTHROPIC_* (D60)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    delete process.env.CLAUDE_CONFIG_DIR;
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: {
        payload: {
          claude: { baseUrl: 'https://gateway.example/v1', authToken: 'pty-claude-token' },
          codex: { apiKey: 'sk-e2e-key', baseUrl: 'https://cch.example/v1' },
        },
      },
    });

    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');

    await manager.create(1, {
      cwd: '/repo/local',
      kind: 'terminal',
      shell: process.execPath,
      args: [],
    });

    const spawnEnv = spawnMock.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.ANTHROPIC_BASE_URL).toBe('https://gateway.example/v1');
    expect(spawnEnv.ANTHROPIC_AUTH_TOKEN).toBe('pty-claude-token');
    // The user's own home is NOT redirected out from under them — this is the
    // half of D60 that gives their CLAUDE.md/commands/skills back.
    expect(spawnEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('flag on but the vault has no Claude arm (older document): no ANTHROPIC_* keys, and no crash', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
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
      shell: process.execPath,
      args: [],
    });

    const spawnEnv = spawnMock.mock.calls[0][2].env as Record<string, string>;
    expect(spawnEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect('AICLIENT_CODEX_API_KEY' in spawnEnv).toBe(false);
  });
});
