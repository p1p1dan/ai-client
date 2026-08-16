import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultCrypto, VaultPayload } from '../../auth/CredentialVault';

/**
 * D47 S5 §3/§5 — third entry-point wiring half of "矩阵 = 入口(3) × 状态(5)":
 * `SessionManager.create`'s `kind === 'agent'` arm. Real `services/auth`
 * singleton (not mocked) so `assertAgentSpawnAllowed` actually runs against
 * a real vault, same style as `chatSpawnGate.test.ts`.
 */

const state = { userDataPath: '' };

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
  },
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

function fakeCrypto(): VaultCrypto {
  return { available: () => true, encrypt: (s) => s, decrypt: (s) => s };
}

function makePayload(overrides?: Partial<VaultPayload>): VaultPayload {
  return {
    identity: { email: 'user@jcdz.cc', userId: 1 },
    cchBaseUrl: 'https://cch.example.com',
    claude: { baseUrl: 'https://cch.example.com/v1', authToken: 'claude-secret' },
    codex: { baseUrl: 'https://cch.example.com/v1', apiKey: 'codex-secret' },
    receivedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

let userDataDir: string;
const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;

beforeEach(() => {
  vi.resetModules();
  userDataDir = mkdtempSync(join(tmpdir(), 'session-manager-spawn-gate-'));
  state.userDataPath = userDataDir;
  process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
  delete process.env.AICLIENT_SKIP_AUTH_GATE;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(userDataDir, { recursive: true, force: true });
  if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
});

async function authenticate(): Promise<void> {
  const authIndex = await import('../../auth');
  authIndex.getCredentialVault().promoteCrypto(fakeCrypto());
  await authIndex.getCredentialVault().save(makePayload());
  authIndex.getAuthStateService().refresh();
}

describe("SessionManager.create kind='agent' spawn gate wiring (D47 S5 §3)", () => {
  it('rejects with a structured auth_required message when signed out', async () => {
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();

    await expect(manager.create(1, { cwd: '/repo/local', kind: 'agent' })).rejects.toThrow(
      /auth_required/
    );
  });

  it('never reaches localPtyManager.create when rejected', async () => {
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    const createSpy = vi.spyOn(manager.localPtyManager, 'create');

    await expect(manager.create(1, { cwd: '/repo/local', kind: 'agent' })).rejects.toThrow();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('succeeds once authenticated', async () => {
    await authenticate();
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');

    const result = await manager.create(1, { cwd: '/repo/local', kind: 'agent' });
    expect(result.session.sessionId).toBe('s1');
  });

  it('a plain terminal session (kind not agent) is never gated, even while signed out', async () => {
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');

    const result = await manager.create(1, { cwd: '/repo/local', kind: 'terminal' });
    expect(result.session.sessionId).toBe('s1');
  });

  it('the escape hatch (skipAuthGate) allows an agent spawn even while signed out', async () => {
    process.env.AICLIENT_SKIP_AUTH_GATE = '1';
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');

    const result = await manager.create(1, { cwd: '/repo/local', kind: 'agent' });
    expect(result.session.sessionId).toBe('s1');
  });
});
