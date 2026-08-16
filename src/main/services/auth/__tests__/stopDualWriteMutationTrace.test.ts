import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultCrypto } from '../CredentialVault';

/**
 * D47 S6 §5/§8 — stop-dual-write mutation trace: a flag-on
 * `OnboardingService.verifyAndRegister()` run must write ZERO bytes under the
 * three legacy credential surfaces (`~/.claude/**`, `~/.claude.json`,
 * `~/.codex/**`) — the entire `persistCredentialFiles()` chain
 * (writeClaudeConfig/writeCodexConfig/ensureClaudeOnboardingComplete) is
 * skipped once the flag is on (see `OnboardingService.ts`'s
 * `!resolveManagedCredentialsEnabled() && !this.persistCredentialFiles(...)`
 * gate).
 *
 * Method: spy on the seven write-shaped `node:fs` APIs
 * (writeFileSync/mkdirSync/copyFileSync/appendFileSync/renameSync/
 * unlinkSync/rmSync), record every call's raw arguments, then filter down to
 * only the calls touching one of the three protected surfaces (checking ALL
 * string arguments per call, not just the first — `copyFileSync`/
 * `renameSync` both take two path arguments). The filtered trace must be
 * empty.
 *
 * A trace that is empty because the run failed early (e.g. a thrown
 * exception before any writer would ever fire) would be a false-positive
 * green, so this test also asserts four success corroborations: (1) the run
 * resolved `ok:true`, (2) the network leg actually fired, (3) the vault (the
 * sole surviving credential sink) received the adopted bytes, and (4) the
 * UNTARGETED `~/.aiclient/settings.json` write (never part of the
 * stop-dual-write gate — see `OnboardingService.ts`'s comment above the
 * gate) both landed on real disk and shows up in the raw (unfiltered) fs
 * trace — proof the spy wired into this test is the SAME instance
 * `OnboardingService.ts`'s own write chain actually uses, not a disconnected
 * mock that would let a real early-return silently produce an empty trace
 * too.
 */

interface FsCallTrace {
  method: string;
  args: unknown[];
}

const fetchMock = vi.fn();
const state = { userDataPath: '/unused-default-userdata' };

// `vi.mock` factories are hoisted above every top-level statement, including
// plain `const` declarations — this file has a static top-level
// `import ... from 'node:fs'` below AND calls `vi.resetModules()` in
// `beforeEach`, so a plain outer `const fsCallTrace = []` referenced inside
// the `vi.mock('node:fs', ...)` factory would throw "Cannot access before
// initialization". `vi.hoisted()` guarantees these are initialized before any
// mock factory runs (same pattern as `UsageService.test.ts`).
const {
  fsCallTrace,
  mockWriteFileSync,
  mockMkdirSync,
  mockCopyFileSync,
  mockAppendFileSync,
  mockRenameSync,
  mockUnlinkSync,
  mockRmSync,
} = vi.hoisted(() => ({
  fsCallTrace: [] as FsCallTrace[],
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockCopyFileSync: vi.fn(),
  mockAppendFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockRmSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();

  function wrap(
    method: string,
    mockFn: ReturnType<typeof vi.fn>,
    actualFn: (...a: unknown[]) => unknown
  ) {
    mockFn.mockImplementation((...args: unknown[]) => {
      fsCallTrace.push({ method, args });
      return actualFn(...args);
    });
  }

  wrap('writeFileSync', mockWriteFileSync, actual.writeFileSync as (...a: unknown[]) => unknown);
  wrap('mkdirSync', mockMkdirSync, actual.mkdirSync as (...a: unknown[]) => unknown);
  wrap('copyFileSync', mockCopyFileSync, actual.copyFileSync as (...a: unknown[]) => unknown);
  wrap('appendFileSync', mockAppendFileSync, actual.appendFileSync as (...a: unknown[]) => unknown);
  wrap('renameSync', mockRenameSync, actual.renameSync as (...a: unknown[]) => unknown);
  wrap('unlinkSync', mockUnlinkSync, actual.unlinkSync as (...a: unknown[]) => unknown);
  wrap('rmSync', mockRmSync, actual.rmSync as (...a: unknown[]) => unknown);

  return {
    ...actual,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    copyFileSync: mockCopyFileSync,
    appendFileSync: mockAppendFileSync,
    renameSync: mockRenameSync,
    unlinkSync: mockUnlinkSync,
    rmSync: mockRmSync,
  };
});

vi.mock('electron', () => ({
  net: { fetch: fetchMock },
  app: {
    on: vi.fn(),
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
    setPath: vi.fn((name: string, value: string) => {
      if (name === 'userData') state.userDataPath = value;
    }),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  ipcMain: { handle: vi.fn() },
}));

function fakeCrypto(): VaultCrypto {
  return {
    available: () => true,
    encrypt: (plainText) => plainText,
    decrypt: (cipherText) => cipherText,
  };
}

function successFetchResponse(token: string) {
  return {
    json: async () => ({
      ok: true,
      data: {
        user: { id: 7, name: 'Byte Check' },
        apiKey: token,
        config: {
          claude: { baseUrl: 'https://cch-test.example.com/v1', authToken: token },
          codex: { baseUrl: 'https://cch-test.example.com/v1', apiKey: token },
        },
      },
    }),
  };
}

/** Matches any string argument that points inside one of the three protected legacy credential surfaces. */
function matchesProtectedPath(value: string, tempHome: string): boolean {
  const claudeDir = join(tempHome, '.claude');
  const claudeJson = join(tempHome, '.claude.json');
  const codexDir = join(tempHome, '.codex');
  return (
    value === claudeDir ||
    value.startsWith(`${claudeDir}${sep}`) ||
    value === claudeJson ||
    value.startsWith(`${claudeJson}.`) || // defensive: hypothetical .bak/.tmp siblings
    value === codexDir ||
    value.startsWith(`${codexDir}${sep}`)
  );
}

/** Checks ALL string arguments of each captured call, not just the first — `copyFileSync`/`renameSync` both take two path arguments. */
function filterProtectedCalls(trace: FsCallTrace[], tempHome: string): FsCallTrace[] {
  return trace.filter((call) =>
    call.args.some((arg) => typeof arg === 'string' && matchesProtectedPath(arg, tempHome))
  );
}

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalManagedCredentials = process.env.AICLIENT_MANAGED_CREDENTIALS;

let tempHome: string;
let userDataDir: string;

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  fsCallTrace.length = 0;
  tempHome = mkdtempSync(join(tmpdir(), 'aiclient-stop-dual-write-home-'));
  userDataDir = mkdtempSync(join(tmpdir(), 'aiclient-stop-dual-write-userdata-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.stubGlobal('__ONBOARDING_SERVICE_URL__', 'https://onboarding-test.example.com');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalManagedCredentials === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  else process.env.AICLIENT_MANAGED_CREDENTIALS = originalManagedCredentials;
});

describe('stop-dual-write mutation trace — flag-on verifyAndRegister never touches ~/.claude/**, ~/.claude.json, ~/.codex/** (D47 S6 §5/§8)', () => {
  it('a full flag-on login writes zero bytes under the three legacy credential surfaces, while still succeeding end-to-end', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const token = 'claude-secret-token-mutation-trace';
    fetchMock.mockResolvedValue(successFetchResponse(token));

    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', userDataDir);
    authIndex.getCredentialVault().promoteCrypto(fakeCrypto());

    const { onboardingService } = await import('../../onboarding/OnboardingService');

    // Only trace fs write activity from `verifyAndRegister` itself — the
    // temp-dir setup above (mkdtempSync et al.) is not wrapped, but the
    // module imports themselves can still touch mkdirSync/writeFileSync
    // (e.g. lazy cache dirs); reset the trace right before the call under
    // test so only its own writes are measured.
    fsCallTrace.length = 0;
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');

    // Corroboration #1 — the run genuinely succeeded end-to-end (not an
    // early throw/return that would vacuously produce an empty trace).
    expect(result.ok).toBe(true);

    // Corroboration #2 — the network leg the whole flow depends on actually
    // fired (proves this run reached past validation/early-return branches).
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/onboarding/verify-and-register'),
      expect.anything()
    );

    // Corroboration #3 — the managed vault (the sole surviving credential
    // sink once dual-write stops) actually received the adopted bytes.
    const vaultRead = authIndex.getCredentialVault().read();
    expect(vaultRead.status).toBe('ok');
    if (vaultRead.status === 'ok') {
      expect(vaultRead.doc.payload.claude.authToken).toBe(token);
    }

    // Corroboration #4 — the untargeted `~/.aiclient/settings.json` write
    // (deliberately NOT part of the stop-dual-write gate — `onboarding.
    // serverUrl` still gets written every login regardless of the flag, D47
    // S6 §2 A-M3) both landed on real disk AND shows up in the raw
    // (unfiltered) fs trace, proving the spy wired into this test is the
    // SAME instance the production write chain actually runs through.
    const aiclientSettingsPath = join(tempHome, '.aiclient', 'settings.json');
    expect(existsSync(aiclientSettingsPath)).toBe(true);
    const savedOnboarding = JSON.parse(readFileSync(aiclientSettingsPath, 'utf-8'));
    expect(savedOnboarding.onboarding.registered).toBe(true);
    expect(
      fsCallTrace.some(
        (call) =>
          call.method === 'writeFileSync' &&
          call.args.some(
            (arg) => typeof arg === 'string' && arg.startsWith(join(tempHome, '.aiclient'))
          )
      )
    ).toBe(true);

    // The assertion under test (D47 S6 §8): filtered down to the three
    // legacy credential surfaces, the flag-on trace is empty — the whole
    // `persistCredentialFiles()` chain (writeClaudeConfig/writeCodexConfig/
    // ensureClaudeOnboardingComplete) never ran.
    const protectedTrace = filterProtectedCalls(fsCallTrace, tempHome);
    expect(protectedTrace).toEqual([]);
  });
});
