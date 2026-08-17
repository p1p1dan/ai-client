import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultCrypto, VaultPayload } from '../../services/auth/CredentialVault';

/**
 * D47 S5 §3/§5 — entry-point wiring half of the "矩阵 = 入口(3) × 状态(5)"
 * requirement: `CHAT_CREATE_SESSION`/`CHAT_RESUME_SESSION` correctly route
 * through `assertAgentSpawnAllowed` (exhaustively matrix-tested at the
 * function level in `services/auth/__tests__/spawnGate.test.ts`) for two
 * representative states — authenticated (allow) and signed_out (reject).
 * `attach` is deliberately NOT covered here — it is a separate IPC channel
 * (`SESSION_ATTACH`) this slice never touches, per S5 §3's explicit
 * exemption.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const state = { userDataPath: '' };

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock('../../services/agent-host/AgentHostManager', () => ({
  agentHostManager: {
    onEvent: vi.fn(),
    createSession: vi.fn(async () => 'req-create'),
    resumeSession: vi.fn(async () => 'req-resume'),
    getStatus: vi.fn(),
  },
}));

vi.mock('../../services/chat/SessionIndexService', () => ({
  sessionIndexService: {
    recordCreated: vi.fn(async () => {}),
    recordResumed: vi.fn(async () => {}),
    handleRuntimeEvent: vi.fn(),
    // D48 S3: create/resume read the row for the captured permission posture.
    get: vi.fn(async () => undefined),
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
  handlers.clear();
  userDataDir = mkdtempSync(join(tmpdir(), 'chat-spawn-gate-'));
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

async function registerHandlers() {
  const { registerChatHandlers } = await import('../chat');
  registerChatHandlers();
  return handlers;
}

async function authenticate(): Promise<void> {
  const authIndex = await import('../../services/auth');
  authIndex.getCredentialVault().promoteCrypto(fakeCrypto());
  await authIndex.getCredentialVault().save(makePayload());
  authIndex.getAuthStateService().refresh();
}

describe('CHAT_CREATE_SESSION / CHAT_RESUME_SESSION spawn gate wiring (D47 S5 §3)', () => {
  it('CHAT_CREATE_SESSION rejects with a structured auth_required message when signed out', async () => {
    const h = await registerHandlers();
    const handler = h.get('chat:createSession');

    await expect(handler?.({}, { sessionId: 's1', workspacePath: '/repo/local' })).rejects.toThrow(
      /auth_required/
    );
  });

  it('CHAT_CREATE_SESSION succeeds once authenticated', async () => {
    const h = await registerHandlers();
    await authenticate();
    const handler = h.get('chat:createSession');

    await expect(handler?.({}, { sessionId: 's1', workspacePath: '/repo/local' })).resolves.toEqual(
      { requestId: 'req-create' }
    );
  });

  it('CHAT_RESUME_SESSION rejects with a structured auth_required message when signed out', async () => {
    const h = await registerHandlers();
    const handler = h.get('chat:resumeSession');

    await expect(
      handler?.({}, { sessionId: 's1', runtimeIdentity: 'r1', workspacePath: '/repo/local' })
    ).rejects.toThrow(/auth_required/);
  });

  it('CHAT_RESUME_SESSION succeeds once authenticated', async () => {
    const h = await registerHandlers();
    await authenticate();
    const handler = h.get('chat:resumeSession');

    await expect(
      handler?.({}, { sessionId: 's1', runtimeIdentity: 'r1', workspacePath: '/repo/local' })
    ).resolves.toEqual({ requestId: 'req-resume' });
  });

  it('the escape hatch (skipAuthGate) allows spawn even while signed out', async () => {
    process.env.AICLIENT_SKIP_AUTH_GATE = '1';
    const h = await registerHandlers();
    const handler = h.get('chat:createSession');

    await expect(handler?.({}, { sessionId: 's1', workspacePath: '/repo/local' })).resolves.toEqual(
      { requestId: 'req-create' }
    );
  });

  it('flag off allows spawn even while signed out', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    const h = await registerHandlers();
    const handler = h.get('chat:createSession');

    await expect(handler?.({}, { sessionId: 's1', workspacePath: '/repo/local' })).resolves.toEqual(
      { requestId: 'req-create' }
    );
  });
});
