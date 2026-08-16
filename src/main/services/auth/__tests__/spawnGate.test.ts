import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultCrypto, VaultPayload } from '../CredentialVault';

/**
 * D47 S5 §3/§5 — `assertAgentSpawnAllowed` exhaustive matrix: managed(on/off)
 * × skipAuthGate(on/off) × vault(ok/cleared/rejected/locked/invalid). This is
 * the function-level half of the "矩阵 = 入口(3) × 状态(5)" requirement — all
 * three real call sites (`CHAT_CREATE_SESSION`/`CHAT_RESUME_SESSION`/
 * `SessionManager.create`) route through this SAME function, so the 5-state
 * coverage is proven once here and the entry-point suites
 * (`chatSpawnGate.test.ts`, `SessionManager.test.ts`'s agent-kind case) only
 * need to prove correct WIRING for a couple of representative states.
 */

const state = { userDataPath: '', isPackaged: false };

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
  },
}));

function fakeCrypto(available = true): VaultCrypto {
  return { available: () => available, encrypt: (s) => s, decrypt: (s) => s };
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

type VaultShape = 'ok' | 'cleared' | 'rejected' | 'locked' | 'invalid';

let userDataDir: string;
const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;
const originalSkip = process.env.AICLIENT_SKIP_AUTH_GATE;

beforeEach(() => {
  vi.resetModules();
  userDataDir = mkdtempSync(join(tmpdir(), 'aiclient-spawn-gate-'));
  state.userDataPath = userDataDir;
  state.isPackaged = false;
  delete process.env.AICLIENT_SKIP_AUTH_GATE;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(userDataDir, { recursive: true, force: true });
  if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
  if (originalSkip === undefined) delete process.env.AICLIENT_SKIP_AUTH_GATE;
  else process.env.AICLIENT_SKIP_AUTH_GATE = originalSkip;
});

async function setupVault(shape: VaultShape): Promise<void> {
  const authIndex = await import('../index');
  const vault = authIndex.getCredentialVault();
  switch (shape) {
    case 'ok':
      vault.promoteCrypto(fakeCrypto());
      await vault.save(makePayload());
      break;
    case 'cleared':
      vault.promoteCrypto(fakeCrypto());
      await vault.save(makePayload());
      await vault.clear({ keepLastEmail: true });
      break;
    case 'rejected':
      vault.promoteCrypto(fakeCrypto());
      await vault.save(makePayload());
      await vault.markInvalidated('2026-08-15T12:00:00.000Z');
      break;
    case 'locked': {
      // Write the raw envelope directly, `enc:'safeStorage'`, and never
      // promote the singleton's crypto adapter — `CredentialVault` starts
      // with an inert `available() => false` adapter until
      // `promoteVaultCrypto` swaps it, so `read()` hits the `locked` branch.
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(userDataDir, 'credentials'), { recursive: true });
      writeFileSync(
        join(userDataDir, 'credentials', 'vault.json'),
        JSON.stringify({
          version: 1,
          enc: 'safeStorage',
          lastEmail: 'user@jcdz.cc',
          invalidatedAt: null,
          encReason: 'ok',
          payload: 'opaque-ciphertext',
        })
      );
      break;
    }
    case 'invalid': {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(userDataDir, 'credentials'), { recursive: true });
      writeFileSync(join(userDataDir, 'credentials', 'vault.json'), 'not json{{{');
      break;
    }
  }
  authIndex.getAuthStateService().refresh();
}

describe('assertAgentSpawnAllowed — managed × skipAuthGate × vault matrix (D47 S5 §3)', () => {
  const VAULTS: VaultShape[] = ['ok', 'cleared', 'rejected', 'locked', 'invalid'];

  it.each(VAULTS)('managed off allows spawn regardless of vault=%s', async (shape) => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    await setupVault(shape);
    const { assertAgentSpawnAllowed } = await import('../spawnGate');
    expect(() => assertAgentSpawnAllowed()).not.toThrow();
  });

  it.each(
    VAULTS
  )('managed on + skipAuthGate allows spawn regardless of vault=%s', async (shape) => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    process.env.AICLIENT_SKIP_AUTH_GATE = '1';
    await setupVault(shape);
    const { assertAgentSpawnAllowed } = await import('../spawnGate');
    expect(() => assertAgentSpawnAllowed()).not.toThrow();
  });

  it('managed on, gate off, vault=ok (authenticated) allows spawn', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    await setupVault('ok');
    const { assertAgentSpawnAllowed } = await import('../spawnGate');
    expect(() => assertAgentSpawnAllowed()).not.toThrow();
  });

  it.each([
    'cleared',
    'rejected',
    'locked',
    'invalid',
  ] as const)('managed on, gate off, vault=%s rejects spawn with a structured auth_required message', async (shape) => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    await setupVault(shape);
    const { assertAgentSpawnAllowed } = await import('../spawnGate');
    expect(() => assertAgentSpawnAllowed()).toThrow(/auth_required/);
  });

  it('a packaged build forces skipAuthGate off even with the env var set — vault=cleared still rejects', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    process.env.AICLIENT_SKIP_AUTH_GATE = '1';
    state.isPackaged = true;
    await setupVault('cleared');
    const { assertAgentSpawnAllowed } = await import('../spawnGate');
    expect(() => assertAgentSpawnAllowed()).toThrow(/auth_required/);
  });
});
