import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildAppStateRoot } from '@shared/appStateLayout';
import { LEGACY_APP_STATE_DIR } from '@shared/defaultPaths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AdoptionVault,
  adoptionGatewayGuard,
  deriveCchBaseUrl,
  ensureVaultAdoption,
  getAdoptionLatch,
  getMigrationIncompleteSignal,
  readLegacyOnboardingState,
  resetAdoptionStateForTests,
} from '../adoption';
import type { VaultPayload, VaultReadResult, VaultSaveResult } from '../CredentialVault';
import { resetManagedFileWriterQueuesForTests } from '../managedFileWriter';

/**
 * D47 S6 §1/§5 — unit coverage for `adoption.ts`'s own new surface: the
 * legacy reader's three-state judgment, `deriveCchBaseUrl`'s stripping
 * rules, the origin guard's six-cell matrix, `ensureVaultAdoption`'s
 * seven-arm `vault.read()` switch + full skip-reason enumeration, the
 * marker file, the latch, and `getMigrationIncompleteSignal`'s three cases.
 *
 * `homedir()` is a NAMED import in `adoption.ts` (`import { homedir } from
 * 'node:os'`) — `McpManager.test.ts` already found `vi.spyOn` unusable for
 * this import shape ("Module namespace is not configurable"); this file
 * follows the same `HOME`/`USERPROFILE` env-override convention already
 * used by `OnboardingService.test.ts` for exactly that reason.
 */

const FLAG_ON = { AICLIENT_MANAGED_CREDENTIALS: '1' };
const FLAG_OFF = {};
const FIXED_NOW = () => new Date('2026-08-15T00:00:00.000Z');

// Deliberately NOT under the `__ONBOARDING_SERVICE_URL__` family below, so
// these count as "legacy serverUrl branch only" test domains unless a test
// explicitly sets a matching `legacyServerUrl`.
const UNRELATED_ORIGIN = 'https://custom-legacy.test';

describe('adoption.ts (D47 S6 §1)', () => {
  let homeDir: string;
  let userDataDir: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'adoption-home-'));
    userDataDir = mkdtempSync(join(tmpdir(), 'adoption-userdata-'));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    vi.stubGlobal('__ONBOARDING_SERVICE_URL__', 'https://onboarding-test.example.com');
    resetManagedFileWriterQueuesForTests();
    resetAdoptionStateForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  // ---------------------------------------------------------------------
  // fixture helpers
  // ---------------------------------------------------------------------

  function writeJsonFile(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), 'utf-8');
  }

  function writeRawFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }

  /**
   * The PRE-RENAME location. Most cases below still seed here on purpose: it
   * is the "machine that was never migrated" arm of the S2 fallback, and it
   * is the arm that carries the "never make an existing user log in again"
   * promise.
   */
  function legacySettingsPath(): string {
    return join(homeDir, LEGACY_APP_STATE_DIR, 'settings.json');
  }

  /** The post-rename location: `~/.pilab/<profile>/settings.json`. */
  function currentSettingsPath(): string {
    return join(buildAppStateRoot(homeDir, userDataDir), 'settings.json');
  }

  function claudeSettingsPath(): string {
    return join(homeDir, '.claude', 'settings.json');
  }

  function codexAuthPath(): string {
    return join(homeDir, '.codex', 'auth.json');
  }

  function writeLegacyOnboarding(opts: {
    registered?: boolean;
    email?: string | null;
    serverUrl?: string | null;
  }): void {
    writeJsonFile(legacySettingsPath(), {
      onboarding: {
        registered: opts.registered,
        email: opts.email ?? undefined,
        serverUrl: opts.serverUrl ?? undefined,
      },
    });
  }

  function writeClaudeCredentials(env: Record<string, unknown> | undefined): void {
    writeJsonFile(claudeSettingsPath(), env === undefined ? {} : { env });
  }

  function markerPath(): string {
    return join(userDataDir, '.adopted-v1');
  }

  function createFakeVault(
    readResult: VaultReadResult,
    saveResult: VaultSaveResult = { ok: true }
  ): AdoptionVault & { saveCalls: VaultPayload[] } {
    const saveCalls: VaultPayload[] = [];
    return {
      read: () => readResult,
      save: async (payload: VaultPayload) => {
        saveCalls.push(payload);
        return saveResult;
      },
      saveCalls,
    };
  }

  const absentVault = (): AdoptionVault & { saveCalls: VaultPayload[] } =>
    createFakeVault({ status: 'absent' });

  // ---------------------------------------------------------------------
  // readLegacyOnboardingState — three-state judgment
  // ---------------------------------------------------------------------

  describe('readLegacyOnboardingState', () => {
    it('absent: settings.json missing', () => {
      expect(readLegacyOnboardingState(userDataDir)).toEqual({ status: 'absent' });
    });

    it('invalid: malformed JSON', () => {
      writeRawFile(legacySettingsPath(), '{not json');
      expect(readLegacyOnboardingState(userDataDir)).toEqual({ status: 'invalid' });
    });

    it('invalid: top-level value is not an object (array)', () => {
      writeRawFile(legacySettingsPath(), '[]');
      expect(readLegacyOnboardingState(userDataDir)).toEqual({ status: 'invalid' });
    });

    it('invalid: top-level value is not an object (string)', () => {
      writeRawFile(legacySettingsPath(), '"hello"');
      expect(readLegacyOnboardingState(userDataDir)).toEqual({ status: 'invalid' });
    });

    it('invalid: missing onboarding key', () => {
      writeJsonFile(legacySettingsPath(), { somethingElse: true });
      expect(readLegacyOnboardingState(userDataDir)).toEqual({ status: 'invalid' });
    });

    it('invalid: onboarding key present but not an object', () => {
      writeJsonFile(legacySettingsPath(), { onboarding: 'not-an-object' });
      expect(readLegacyOnboardingState(userDataDir)).toEqual({ status: 'invalid' });
    });

    it('present: registered true with email + serverUrl', () => {
      writeLegacyOnboarding({
        registered: true,
        email: 'user@example.com',
        serverUrl: 'https://custom-legacy.test',
      });
      expect(readLegacyOnboardingState(userDataDir)).toEqual({
        status: 'present',
        registered: true,
        email: 'user@example.com',
        serverUrl: 'https://custom-legacy.test',
      });
    });

    it('present: registered explicitly false', () => {
      writeLegacyOnboarding({ registered: false, email: 'user@example.com' });
      const result = readLegacyOnboardingState(userDataDir);
      expect(result.status).toBe('present');
      expect(result.status === 'present' && result.registered).toBe(false);
    });

    it('present: registered field missing collapses to false', () => {
      writeJsonFile(legacySettingsPath(), { onboarding: { email: 'user@example.com' } });
      const result = readLegacyOnboardingState(userDataDir);
      expect(result.status).toBe('present');
      expect(result.status === 'present' && result.registered).toBe(false);
    });

    it('present: empty-string email collapses to null', () => {
      writeLegacyOnboarding({ registered: true, email: '' });
      const result = readLegacyOnboardingState(userDataDir);
      expect(result.status === 'present' && result.email).toBeNull();
    });

    it('present: missing email collapses to null', () => {
      writeJsonFile(legacySettingsPath(), { onboarding: { registered: true } });
      const result = readLegacyOnboardingState(userDataDir);
      expect(result.status === 'present' && result.email).toBeNull();
    });

    it('present: empty-string serverUrl collapses to null', () => {
      writeLegacyOnboarding({ registered: true, email: 'user@example.com', serverUrl: '' });
      const result = readLegacyOnboardingState(userDataDir);
      expect(result.status === 'present' && result.serverUrl).toBeNull();
    });

    it('present: missing serverUrl collapses to null', () => {
      writeLegacyOnboarding({ registered: true, email: 'user@example.com' });
      const result = readLegacyOnboardingState(userDataDir);
      expect(result.status === 'present' && result.serverUrl).toBeNull();
    });

    // -------------------------------------------------------------------
    // S2 — two roots. Everything above seeds the PRE-RENAME path, so it
    // already covers the "never migrated" fallback; these cover the other
    // two positions.
    // -------------------------------------------------------------------

    it('S2: reads the post-rename root, which is where the migration puts it', () => {
      writeJsonFile(currentSettingsPath(), {
        onboarding: { registered: true, email: 'migrated@example.com' },
      });
      expect(readLegacyOnboardingState(userDataDir)).toEqual({
        status: 'present',
        registered: true,
        email: 'migrated@example.com',
        serverUrl: null,
      });
    });

    it('S2: the post-rename root wins when both exist', () => {
      writeJsonFile(legacySettingsPath(), {
        onboarding: { registered: true, email: 'stale@example.com' },
      });
      writeJsonFile(currentSettingsPath(), {
        onboarding: { registered: true, email: 'current@example.com' },
      });
      const result = readLegacyOnboardingState(userDataDir);
      expect(result.status === 'present' && result.email).toBe('current@example.com');
    });

    it('S2: a different profile does not see this profile settings', () => {
      writeJsonFile(currentSettingsPath(), {
        onboarding: { registered: true, email: 'prod@example.com' },
      });
      // Another install (`<userData>` differs) with no legacy file to fall
      // back to must read nothing at all — that separation IS the profile layer.
      expect(readLegacyOnboardingState(join(dirname(userDataDir), 'someone-else'))).toEqual({
        status: 'absent',
      });
    });
  });

  // ---------------------------------------------------------------------
  // deriveCchBaseUrl
  // ---------------------------------------------------------------------

  describe('deriveCchBaseUrl', () => {
    it('strips a trailing /v1', () => {
      expect(deriveCchBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com');
    });

    it('strips trailing slashes before stripping /v1', () => {
      expect(deriveCchBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com');
    });

    it('leaves a URL with no /v1 suffix unchanged', () => {
      expect(deriveCchBaseUrl('https://api.example.com')).toBe('https://api.example.com');
    });

    it('strips /v1 case-insensitively', () => {
      expect(deriveCchBaseUrl('https://api.example.com/V1')).toBe('https://api.example.com');
    });

    it('trims surrounding whitespace', () => {
      expect(deriveCchBaseUrl('  https://api.example.com/v1  ')).toBe('https://api.example.com');
    });

    it('collapses multiple trailing slashes then strips /v1', () => {
      expect(deriveCchBaseUrl('https://api.example.com/v1///')).toBe('https://api.example.com');
    });
  });

  // ---------------------------------------------------------------------
  // adoptionGatewayGuard — six-cell origin matrix (+ extra contract rows)
  // ---------------------------------------------------------------------

  describe('adoptionGatewayGuard', () => {
    it('cell 1 — company-gateway-family origin match (subdomain, path irrelevant)', () => {
      // `__ONBOARDING_SERVICE_URL__` stubbed to onboarding-test.example.com
      // in beforeEach → derived family suffix is "example.com".
      expect(adoptionGatewayGuard('https://api.example.com/v1', null)).toBe('match');
    });

    it('cell 1b — legacy-serverUrl origin match despite a /v1 path difference', () => {
      expect(adoptionGatewayGuard(`${UNRELATED_ORIGIN}/v1`, UNRELATED_ORIGIN)).toBe('match');
    });

    it('cell 2 — different host is a mismatch', () => {
      expect(adoptionGatewayGuard('https://other-host.test/v1', UNRELATED_ORIGIN)).toBe('mismatch');
    });

    it('cell 3 — different port is a mismatch', () => {
      expect(adoptionGatewayGuard('https://custom-legacy.test:8443/v1', UNRELATED_ORIGIN)).toBe(
        'mismatch'
      );
    });

    it('cell 4 — http vs. https on the same host is a mismatch', () => {
      expect(adoptionGatewayGuard('http://custom-legacy.test/v1', UNRELATED_ORIGIN)).toBe(
        'mismatch'
      );
    });

    it('cell 5 — an unparsable claude base URL is invalid_url', () => {
      expect(adoptionGatewayGuard('not a url at all', UNRELATED_ORIGIN)).toBe('invalid_url');
    });

    it('cell 6a — userinfo in the claude base URL is invalid_url', () => {
      expect(
        adoptionGatewayGuard('https://user:pass@custom-legacy.test/v1', UNRELATED_ORIGIN)
      ).toBe('invalid_url');
    });

    it('cell 6b — a non-http(s) scheme in the claude base URL is invalid_url', () => {
      expect(adoptionGatewayGuard('ftp://custom-legacy.test/v1', UNRELATED_ORIGIN)).toBe(
        'invalid_url'
      );
    });

    it('an unrelated host with no legacy serverUrl at all is a mismatch (not invalid_url)', () => {
      expect(adoptionGatewayGuard('https://other-host.test/v1', null)).toBe('mismatch');
    });

    it('an unparsable legacy serverUrl is swallowed, not promoted to invalid_url', () => {
      expect(adoptionGatewayGuard('https://other-host.test/v1', 'not a url')).toBe('mismatch');
    });

    it('userinfo in the legacy serverUrl disqualifies it from the match branch', () => {
      expect(
        adoptionGatewayGuard(
          'https://custom-legacy.test/v1',
          'https://user:pass@custom-legacy.test'
        )
      ).toBe('mismatch');
    });
  });

  // ---------------------------------------------------------------------
  // ensureVaultAdoption — orchestration
  // ---------------------------------------------------------------------

  describe('ensureVaultAdoption — flag-off', () => {
    it('is a no-op regardless of vault/legacy/marker state', async () => {
      const vault = absentVault();
      writeLegacyOnboarding({ registered: true, email: 'user@example.com' });
      writeClaudeCredentials({
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: 'tok',
      });
      const outcome = await ensureVaultAdoption(vault, userDataDir, { env: FLAG_OFF });
      expect(outcome).toEqual({ kind: 'skipped', reason: 'flag_off' });
      expect(vault.saveCalls).toEqual([]);
      expect(existsSync(markerPath())).toBe(false);
    });
  });

  describe('ensureVaultAdoption — vault.read() seven-arm switch (flag-on)', () => {
    const nonAbsentStatuses: Array<{ label: string; result: VaultReadResult }> = [
      { label: 'cleared', result: { status: 'cleared', lastEmail: null } },
      { label: 'rejected', result: { status: 'rejected', lastEmail: 'user@example.com' } },
      { label: 'locked', result: { status: 'locked' } },
      { label: 'unsupported', result: { status: 'unsupported' } },
      {
        label: 'invalid',
        result: { status: 'invalid', reason: 'malformed_json' },
      },
      {
        label: 'ok',
        result: {
          status: 'ok',
          doc: {
            payload: {
              identity: { email: 'user@example.com', userId: null },
              cchBaseUrl: 'https://api.example.com',
              claude: { baseUrl: 'https://api.example.com', authToken: 'tok' },
              codex: { baseUrl: 'https://api.example.com/v1', apiKey: 'tok' },
              receivedAt: '2026-01-01T00:00:00.000Z',
            },
            invalidatedAt: null,
          },
        } as unknown as VaultReadResult,
      },
    ];

    for (const { label, result } of nonAbsentStatuses) {
      it(`status '${label}' skips with reason vault_not_absent (vaultStatus='${label}')`, async () => {
        const vault = createFakeVault(result);
        const outcome = await ensureVaultAdoption(vault, userDataDir, { env: FLAG_ON });
        expect(outcome).toEqual({
          kind: 'skipped',
          reason: 'vault_not_absent',
          vaultStatus: label,
        });
        expect(vault.saveCalls).toEqual([]);
      });
    }

    it("status 'absent' proceeds past the switch (does not itself short-circuit)", async () => {
      // No legacy file at all → falls through to legacy_not_registered, NOT
      // vault_not_absent — proves 'absent' is the one arm that keeps going.
      const vault = absentVault();
      const outcome = await ensureVaultAdoption(vault, userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({ kind: 'skipped', reason: 'legacy_not_registered' });
    });
  });

  describe('ensureVaultAdoption — marker guard', () => {
    it('skips with marker_present when the marker file already exists, before touching legacy state', async () => {
      writeRawFile(markerPath(), JSON.stringify({ version: 1, adoptedAt: 'x' }));
      const vault = absentVault();
      // Deliberately leave legacy files absent — if the marker check didn't
      // run first, this would instead report legacy_not_registered.
      const outcome = await ensureVaultAdoption(vault, userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({ kind: 'skipped', reason: 'marker_present' });
      expect(vault.saveCalls).toEqual([]);
    });
  });

  describe('ensureVaultAdoption — legacy_not_registered', () => {
    it('collapses legacy absent into this reason', async () => {
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({ kind: 'skipped', reason: 'legacy_not_registered' });
    });

    it('collapses legacy invalid into this reason', async () => {
      writeRawFile(legacySettingsPath(), '{not json');
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({ kind: 'skipped', reason: 'legacy_not_registered' });
    });

    it('collapses legacy registered:false into this reason', async () => {
      writeLegacyOnboarding({ registered: false, email: 'user@example.com' });
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({ kind: 'skipped', reason: 'legacy_not_registered' });
    });
  });

  describe('ensureVaultAdoption — claude_credentials_missing (three-state "missing" judgment)', () => {
    beforeEach(() => {
      writeLegacyOnboarding({ registered: true, email: 'user@example.com' });
    });

    it('claude settings.json entirely absent', async () => {
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({
        kind: 'skipped',
        reason: 'claude_credentials_missing',
        legacyEmail: 'user@example.com',
      });
    });

    it('env:{} present but empty', async () => {
      writeClaudeCredentials({});
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({
        kind: 'skipped',
        reason: 'claude_credentials_missing',
        legacyEmail: 'user@example.com',
      });
    });

    it('env present but ANTHROPIC_BASE_URL key missing', async () => {
      writeClaudeCredentials({ ANTHROPIC_AUTH_TOKEN: 'tok' });
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome.kind).toBe('skipped');
      expect(outcome.kind === 'skipped' && outcome.reason).toBe('claude_credentials_missing');
    });

    it('env present but ANTHROPIC_AUTH_TOKEN key missing', async () => {
      writeClaudeCredentials({ ANTHROPIC_BASE_URL: 'https://api.example.com' });
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome.kind === 'skipped' && outcome.reason).toBe('claude_credentials_missing');
    });

    it('ANTHROPIC_BASE_URL is an empty string', async () => {
      writeClaudeCredentials({ ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: 'tok' });
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome.kind === 'skipped' && outcome.reason).toBe('claude_credentials_missing');
    });

    it('ANTHROPIC_AUTH_TOKEN is an empty string', async () => {
      writeClaudeCredentials({
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: '',
      });
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome.kind === 'skipped' && outcome.reason).toBe('claude_credentials_missing');
    });

    it('legacyEmail is carried through as null when the legacy email itself was empty', async () => {
      writeLegacyOnboarding({ registered: true, email: '' });
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({
        kind: 'skipped',
        reason: 'claude_credentials_missing',
        legacyEmail: null,
      });
    });
  });

  describe('ensureVaultAdoption — guard_rejected', () => {
    beforeEach(() => {
      writeLegacyOnboarding({
        registered: true,
        email: 'user@example.com',
        serverUrl: UNRELATED_ORIGIN,
      });
    });

    it('mismatch sub-case', async () => {
      writeClaudeCredentials({
        ANTHROPIC_BASE_URL: 'https://other-host.test/v1',
        ANTHROPIC_AUTH_TOKEN: 'tok',
      });
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({
        kind: 'skipped',
        reason: 'guard_rejected',
        guardResult: 'mismatch',
        legacyEmail: 'user@example.com',
      });
    });

    it('invalid_url sub-case', async () => {
      writeClaudeCredentials({
        ANTHROPIC_BASE_URL: 'not a url at all',
        ANTHROPIC_AUTH_TOKEN: 'tok',
      });
      const outcome = await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({
        kind: 'skipped',
        reason: 'guard_rejected',
        guardResult: 'invalid_url',
        legacyEmail: 'user@example.com',
      });
    });
  });

  describe('ensureVaultAdoption — save_failed', () => {
    beforeEach(() => {
      writeLegacyOnboarding({ registered: true, email: 'user@example.com' });
      writeClaudeCredentials({
        ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'tok',
      });
    });

    it('crypto_not_ready reason is surfaced and the marker is never written', async () => {
      const vault = createFakeVault(
        { status: 'absent' },
        { ok: false, reason: 'crypto_not_ready' }
      );
      const outcome = await ensureVaultAdoption(vault, userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({
        kind: 'skipped',
        reason: 'save_failed',
        saveReason: 'crypto_not_ready',
      });
      expect(existsSync(markerPath())).toBe(false);
    });

    it('unsupported_version reason is surfaced', async () => {
      const vault = createFakeVault(
        { status: 'absent' },
        { ok: false, reason: 'unsupported_version' }
      );
      const outcome = await ensureVaultAdoption(vault, userDataDir, { env: FLAG_ON });
      expect(outcome).toEqual({
        kind: 'skipped',
        reason: 'save_failed',
        saveReason: 'unsupported_version',
      });
    });
  });

  describe('ensureVaultAdoption — successful adoption', () => {
    beforeEach(() => {
      writeLegacyOnboarding({ registered: true, email: 'user@example.com' });
      writeClaudeCredentials({
        ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'claude-token-xyz',
      });
    });

    it('saves a payload with the same-key doctrine, null userId, and derived cchBaseUrl', async () => {
      const vault = absentVault();
      const outcome = await ensureVaultAdoption(vault, userDataDir, {
        env: FLAG_ON,
        now: FIXED_NOW,
      });
      expect(outcome).toEqual({ kind: 'adopted' });
      expect(vault.saveCalls).toHaveLength(1);
      expect(vault.saveCalls[0]).toEqual({
        identity: { email: 'user@example.com', userId: null },
        cchBaseUrl: 'https://api.example.com',
        claude: { baseUrl: 'https://api.example.com/v1', authToken: 'claude-token-xyz' },
        codex: { baseUrl: 'https://api.example.com/v1', apiKey: 'claude-token-xyz' },
        receivedAt: FIXED_NOW().toISOString(),
      });
    });

    it('writes the marker file atomically with version + adoptedAt after a successful save', async () => {
      const vault = absentVault();
      await ensureVaultAdoption(vault, userDataDir, { env: FLAG_ON, now: FIXED_NOW });
      expect(existsSync(markerPath())).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath(), 'utf-8')) as {
        version: number;
        adoptedAt: string;
      };
      expect(marker).toEqual({ version: 1, adoptedAt: FIXED_NOW().toISOString() });
    });

    it('a second call after the marker was written skips as marker_present, even against a fresh absent vault', async () => {
      const firstVault = absentVault();
      await ensureVaultAdoption(firstVault, userDataDir, { env: FLAG_ON, now: FIXED_NOW });

      const secondVault = absentVault();
      const outcome = await ensureVaultAdoption(secondVault, userDataDir, {
        env: FLAG_ON,
        now: FIXED_NOW,
      });
      expect(outcome).toEqual({ kind: 'skipped', reason: 'marker_present' });
      expect(secondVault.saveCalls).toEqual([]);
    });

    it('falls back to an empty-string identity.email when the legacy email was missing', async () => {
      writeLegacyOnboarding({ registered: true });
      writeClaudeCredentials({
        ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'claude-token-xyz',
      });
      const vault = absentVault();
      await ensureVaultAdoption(vault, userDataDir, { env: FLAG_ON, now: FIXED_NOW });
      expect(vault.saveCalls[0]?.identity.email).toBe('');
    });

    describe('auth.json corroboration is logged but never vetoes adoption', () => {
      let logSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      });

      it('absent: no ~/.codex/auth.json at all', async () => {
        const outcome = await ensureVaultAdoption(absentVault(), userDataDir, {
          env: FLAG_ON,
          now: FIXED_NOW,
        });
        expect(outcome).toEqual({ kind: 'adopted' });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('corroboration: absent'));
      });

      it('absent: ChatGPT-OAuth-shaped auth.json with no OPENAI_API_KEY field', async () => {
        writeJsonFile(codexAuthPath(), { tokens: { access_token: 'oauth-token' } });
        const outcome = await ensureVaultAdoption(absentVault(), userDataDir, {
          env: FLAG_ON,
          now: FIXED_NOW,
        });
        expect(outcome).toEqual({ kind: 'adopted' });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('corroboration: absent'));
      });

      it('corroborated: OPENAI_API_KEY matches the claude token', async () => {
        writeJsonFile(codexAuthPath(), { OPENAI_API_KEY: 'claude-token-xyz' });
        const outcome = await ensureVaultAdoption(absentVault(), userDataDir, {
          env: FLAG_ON,
          now: FIXED_NOW,
        });
        expect(outcome).toEqual({ kind: 'adopted' });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('corroboration: corroborated'));
      });

      it('divergent: OPENAI_API_KEY differs from the claude token — adoption still proceeds', async () => {
        writeJsonFile(codexAuthPath(), { OPENAI_API_KEY: 'a-totally-different-key' });
        const outcome = await ensureVaultAdoption(absentVault(), userDataDir, {
          env: FLAG_ON,
          now: FIXED_NOW,
        });
        expect(outcome).toEqual({ kind: 'adopted' });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('corroboration: divergent'));
      });
    });
  });

  // ---------------------------------------------------------------------
  // getAdoptionLatch
  // ---------------------------------------------------------------------

  describe('getAdoptionLatch', () => {
    it('resolves immediately on flag-off', async () => {
      const outcome = ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_OFF });
      await outcome;
      await expect(getAdoptionLatch()).resolves.toBeUndefined();
    });

    it('resolves immediately for every already-settled skip outcome', async () => {
      // legacy_not_registered — a fast synchronous skip path.
      await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      await expect(getAdoptionLatch()).resolves.toBeUndefined();
    });

    it('stays pending until the in-flight adoption task actually settles', async () => {
      writeLegacyOnboarding({ registered: true, email: 'user@example.com' });
      writeClaudeCredentials({
        ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'tok',
      });

      let resolveSave: (result: VaultSaveResult) => void = () => undefined;
      const savePromise = new Promise<VaultSaveResult>((resolve) => {
        resolveSave = resolve;
      });
      const vault: AdoptionVault = {
        read: () => ({ status: 'absent' }),
        save: () => savePromise,
      };

      const outcomePromise = ensureVaultAdoption(vault, userDataDir, { env: FLAG_ON });

      let latchSettled = false;
      const latchWatch = getAdoptionLatch().then(() => {
        latchSettled = true;
      });

      // Flush pending microtasks without resolving the save — a macrotask
      // boundary guarantees every microtask queued so far has drained.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(latchSettled).toBe(false);

      resolveSave({ ok: true });
      await outcomePromise;
      await latchWatch;
      expect(latchSettled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // getMigrationIncompleteSignal
  // ---------------------------------------------------------------------

  describe('getMigrationIncompleteSignal', () => {
    it('default (never run / reset): not incomplete, no email', () => {
      expect(getMigrationIncompleteSignal()).toEqual({
        migrationIncomplete: false,
        legacyEmail: null,
      });
    });

    it('reflects claude_credentials_missing outcomes', async () => {
      writeLegacyOnboarding({ registered: true, email: 'user@example.com' });
      await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(getMigrationIncompleteSignal()).toEqual({
        migrationIncomplete: true,
        legacyEmail: 'user@example.com',
      });
    });

    it('reflects guard_rejected outcomes', async () => {
      writeLegacyOnboarding({
        registered: true,
        email: 'user@example.com',
        serverUrl: UNRELATED_ORIGIN,
      });
      writeClaudeCredentials({
        ANTHROPIC_BASE_URL: 'https://other-host.test/v1',
        ANTHROPIC_AUTH_TOKEN: 'tok',
      });
      await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(getMigrationIncompleteSignal()).toEqual({
        migrationIncomplete: true,
        legacyEmail: 'user@example.com',
      });
    });

    it('does not flag a successful adoption as incomplete', async () => {
      writeLegacyOnboarding({ registered: true, email: 'user@example.com' });
      writeClaudeCredentials({
        ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'tok',
      });
      await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON, now: FIXED_NOW });
      expect(getMigrationIncompleteSignal()).toEqual({
        migrationIncomplete: false,
        legacyEmail: null,
      });
    });

    it('does not flag legacy_not_registered as incomplete', async () => {
      await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_ON });
      expect(getMigrationIncompleteSignal()).toEqual({
        migrationIncomplete: false,
        legacyEmail: null,
      });
    });

    it('does not flag flag_off as incomplete', async () => {
      await ensureVaultAdoption(absentVault(), userDataDir, { env: FLAG_OFF });
      expect(getMigrationIncompleteSignal()).toEqual({
        migrationIncomplete: false,
        legacyEmail: null,
      });
    });
  });
});
