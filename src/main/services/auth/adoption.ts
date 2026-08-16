/**
 * D47 S6 §1 — legacy-credential adoption. On a machine that already
 * completed the LEGACY onboarding flow (`~/.aiclient/settings.json` +
 * `~/.claude/settings.json`), promote those bytes into the S1 vault ONCE,
 * so flipping the managed-credentials flag on an already-registered machine
 * does not force a re-login.
 *
 * Zero network, zero self-built regenerate/refresh (A-B3): this module only
 * reads two on-disk legacy sources, runs a pure origin-comparison guard, and
 * (on a match) calls `vault.save()` — `regenerateFromVault()` /
 * `AuthStateService.refresh()` / the probe scheduler are left entirely to
 * the existing startup chain (`main/index.ts`'s two calls stay where they
 * are), never re-implemented here.
 *
 * `vault.save()` is the ONLY writer this module is allowed to reach for
 * credential bytes — it never imports `CredentialVault`'s own file path or
 * any raw `fs` WRITE api (only the read-only `existsSync`/`readFileSync`
 * for the legacy sources + the marker-existence check; the marker itself is
 * written through `managedFileWriter.writeManagedFile`, the same atomic
 * primitive every other managed-file writer in this codebase already uses —
 * "who is allowed to write vault.json" stays a single, greppable fact).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveManagedCredentialsEnabled } from './AuthStateService';
import type { VaultPayload, VaultReadResult, VaultSaveResult } from './CredentialVault';
import type { ClaudeHomeCredentials } from './claudeHome';
import { writeManagedFile } from './managedFileWriter';

const ADOPTION_MARKER_FILE_NAME = '.adopted-v1';
const DEFAULT_ONBOARDING_SERVICE_URL = 'https://onboarding-jyw.pipidan.qzz.io';

// ---------------------------------------------------------------------------
// §1.2 — legacy reader (decoupled from `OnboardingService.checkRegistration()`,
// which folds `registered:false` into a shape that drops `email`/`serverUrl`
// entirely).
// ---------------------------------------------------------------------------

export type LegacyOnboardingReadResult =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'present'; registered: boolean; email: string | null; serverUrl: string | null };

/** Malformed JSON never throws, never writes a marker — every failure mode collapses to `{status:'invalid'}`, which the orchestration treats identically to "not registered" (skip). */
export function readLegacyOnboardingState(): LegacyOnboardingReadResult {
  const settingsPath = join(homedir(), '.aiclient', 'settings.json');
  if (!existsSync(settingsPath)) {
    return { status: 'absent' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return { status: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 'invalid' };
  }

  const onboarding = (parsed as Record<string, unknown>).onboarding;
  if (!onboarding || typeof onboarding !== 'object') {
    return { status: 'invalid' };
  }
  const rec = onboarding as Record<string, unknown>;
  return {
    status: 'present',
    registered: rec.registered === true,
    email: typeof rec.email === 'string' && rec.email.length > 0 ? rec.email : null,
    serverUrl: typeof rec.serverUrl === 'string' && rec.serverUrl.length > 0 ? rec.serverUrl : null,
  };
}

/**
 * §1.1 — OS home HARDCODED path (`homedir()`), NEVER a `CLAUDE_CONFIG_DIR`-
 * aware helper: reusing the managed-home-aware readers elsewhere in this
 * codebase would read back the app's OWN already-written managed
 * `claude-home/settings.json` — "self-adoption" (A-m3). Three-state missing
 * judgment: no `env` key / `env:{}` / an empty-string value on either field
 * all count as missing.
 */
function readClaudeHomeCredentials(): ClaudeHomeCredentials | null {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const env = (parsed as Record<string, unknown>).env;
  if (!env || typeof env !== 'object') {
    return null;
  }
  const envRec = env as Record<string, unknown>;
  const baseUrl = envRec.ANTHROPIC_BASE_URL;
  const authToken = envRec.ANTHROPIC_AUTH_TOKEN;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return null;
  }
  if (typeof authToken !== 'string' || authToken.length === 0) {
    return null;
  }
  return { baseUrl, authToken };
}

/**
 * `~/.codex/auth.json`'s key — corroborating evidence ONLY (§1.1). Never
 * throws, never returns the secret itself to a caller that might log it;
 * `logAuthJsonCorroboration` below only ever prints the classification word.
 */
function readCodexAuthOpenAiKey(): string | null {
  try {
    const authPath = join(homedir(), '.codex', 'auth.json');
    if (!existsSync(authPath)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>;
    const key = parsed.OPENAI_API_KEY;
    return typeof key === 'string' && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * §1.1 — diagnostic only, NEVER affects the adoption decision: a personal
 * OpenAI key (or a ChatGPT-OAuth `auth.json` with no `OPENAI_API_KEY` field
 * at all) must not veto adoption — the probe scheduler verifies the real
 * claude token independently once the vault is populated. Logs only the
 * classification word, never a secret value.
 */
function logAuthJsonCorroboration(claudeToken: string): void {
  const key = readCodexAuthOpenAiKey();
  if (key === null) {
    console.log('[adoption] auth.json corroboration: absent');
    return;
  }
  console.log(
    key === claudeToken
      ? '[adoption] auth.json corroboration: corroborated'
      : '[adoption] auth.json corroboration: divergent'
  );
}

// ---------------------------------------------------------------------------
// §1.1 — cchBaseUrl derivation (never reads legacy `serverUrl`: pre-2354a6b
// machines stored an onboarding-service address there, not a cch address).
// ---------------------------------------------------------------------------

export function deriveCchBaseUrl(claudeBaseUrl: string): string {
  return claudeBaseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

// ---------------------------------------------------------------------------
// §1.3 — guard
// ---------------------------------------------------------------------------

export type AdoptionGatewayGuardResult = 'match' | 'mismatch' | 'invalid_url';

function getInjectedOnboardingServiceUrl(): string {
  const injected = typeof __ONBOARDING_SERVICE_URL__ === 'string' ? __ONBOARDING_SERVICE_URL__ : '';
  return injected || DEFAULT_ONBOARDING_SERVICE_URL;
}

/**
 * The "registered domain family" of `__ONBOARDING_SERVICE_URL__` — its
 * hostname with the leftmost label dropped (`onboarding-jyw.pipidan.qzz.io`
 * -> `pipidan.qzz.io`), matching §1.3's literal `*.pipidan.qzz.io` example.
 * Derived (not hardcoded) so a build-time constant change never silently
 * diverges from the guard. Falls back to the literal suffix if the injected
 * constant itself fails to parse.
 */
function deriveCompanyGatewayFamilySuffix(): string {
  try {
    const hostname = new URL(getInjectedOnboardingServiceUrl()).hostname;
    const labels = hostname.split('.');
    return labels.length > 2 ? labels.slice(1).join('.') : hostname;
  } catch {
    return 'pipidan.qzz.io';
  }
}

function isCompanyGatewayFamilyOrigin(url: URL): boolean {
  if (url.protocol !== 'https:') {
    return false;
  }
  const suffix = deriveCompanyGatewayFamilySuffix();
  const hostname = url.hostname.toLowerCase();
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/**
 * §1.3 — compares **origin**, not host (a plaintext-http same-host URL must
 * never pass). Company gateway set = the `__ONBOARDING_SERVICE_URL__` domain
 * family (https-only) ∪ legacy `serverUrl`'s origin (if parseable). Any
 * parse failure on `claudeBaseUrl` itself, a non-http(s) scheme, or
 * embedded userinfo = `invalid_url`. An unparsable `legacyServerUrl` simply
 * contributes no gateway-set member — it never turns an otherwise-valid
 * `claudeBaseUrl` into `invalid_url` (§1.3's "若可解析" already scopes this
 * branch to the parseable case).
 */
export function adoptionGatewayGuard(
  claudeBaseUrl: string,
  legacyServerUrl: string | null
): AdoptionGatewayGuardResult {
  let claudeUrl: URL;
  try {
    claudeUrl = new URL(claudeBaseUrl);
  } catch {
    return 'invalid_url';
  }
  if (claudeUrl.protocol !== 'http:' && claudeUrl.protocol !== 'https:') {
    return 'invalid_url';
  }
  if (claudeUrl.username !== '' || claudeUrl.password !== '') {
    return 'invalid_url';
  }

  if (isCompanyGatewayFamilyOrigin(claudeUrl)) {
    return 'match';
  }

  if (legacyServerUrl) {
    try {
      const legacyUrl = new URL(legacyServerUrl);
      if (
        legacyUrl.username === '' &&
        legacyUrl.password === '' &&
        legacyUrl.origin === claudeUrl.origin
      ) {
        return 'match';
      }
    } catch {
      // Unparsable legacy serverUrl: not a gateway-set member, not a reason
      // to fail the whole guard either.
    }
  }

  return 'mismatch';
}

// ---------------------------------------------------------------------------
// §1.5 — orchestration
// ---------------------------------------------------------------------------

export interface AdoptionVault {
  read(): VaultReadResult;
  save(payload: VaultPayload): Promise<VaultSaveResult>;
}

export type VaultAdoptionOutcome =
  | { kind: 'skipped'; reason: 'flag_off' }
  | { kind: 'skipped'; reason: 'vault_not_absent'; vaultStatus: VaultReadResult['status'] }
  | { kind: 'skipped'; reason: 'marker_present' }
  | { kind: 'skipped'; reason: 'legacy_not_registered' }
  | { kind: 'skipped'; reason: 'claude_credentials_missing'; legacyEmail: string | null }
  | {
      kind: 'skipped';
      reason: 'guard_rejected';
      guardResult: 'mismatch' | 'invalid_url';
      legacyEmail: string | null;
    }
  | {
      kind: 'skipped';
      reason: 'save_failed';
      saveReason: Extract<VaultSaveResult, { ok: false }>['reason'];
    }
  | { kind: 'adopted' };

interface AdoptionMarkerContents {
  version: 1;
  adoptedAt: string;
}

function assertNever(value: never): never {
  throw new Error(`ensureVaultAdoption: unreachable vault.read() status: ${JSON.stringify(value)}`);
}

async function writeAdoptionMarker(markerPath: string, now: Date): Promise<void> {
  const contents: AdoptionMarkerContents = { version: 1, adoptedAt: now.toISOString() };
  await writeManagedFile(markerPath, `${JSON.stringify(contents)}\n`);
}

async function performAdoption(
  vault: AdoptionVault,
  userDataDir: string,
  now: () => Date
): Promise<VaultAdoptionOutcome> {
  // vault.read() exhaustive switch — only `absent` proceeds. B-M5: `cleared`
  // must NOT be folded together with `absent` (a logged-out machine must
  // never be silently re-adopted back into a signed-in vault) — every other
  // status is an explicit skip, closed off with `assertNever`.
  const readResult = vault.read();
  switch (readResult.status) {
    case 'absent':
      break;
    case 'cleared':
    case 'rejected':
    case 'locked':
    case 'unsupported':
    case 'invalid':
    case 'ok':
      return { kind: 'skipped', reason: 'vault_not_absent', vaultStatus: readResult.status };
    default:
      return assertNever(readResult);
  }

  const markerPath = join(userDataDir, ADOPTION_MARKER_FILE_NAME);
  if (existsSync(markerPath)) {
    return { kind: 'skipped', reason: 'marker_present' };
  }

  const legacy = readLegacyOnboardingState();
  if (legacy.status !== 'present' || !legacy.registered) {
    return { kind: 'skipped', reason: 'legacy_not_registered' };
  }

  const claudeCredentials = readClaudeHomeCredentials();
  if (!claudeCredentials) {
    return { kind: 'skipped', reason: 'claude_credentials_missing', legacyEmail: legacy.email };
  }

  const guardResult = adoptionGatewayGuard(claudeCredentials.baseUrl, legacy.serverUrl);
  if (guardResult !== 'match') {
    return {
      kind: 'skipped',
      reason: 'guard_rejected',
      guardResult,
      legacyEmail: legacy.email,
    };
  }

  // Corroboration-only diagnostic — never affects the decision below.
  logAuthJsonCorroboration(claudeCredentials.authToken);

  const cchBaseUrl = deriveCchBaseUrl(claudeCredentials.baseUrl);
  const payload: VaultPayload = {
    identity: { email: legacy.email ?? '', userId: null },
    cchBaseUrl,
    claude: { baseUrl: claudeCredentials.baseUrl, authToken: claudeCredentials.authToken },
    codex: { baseUrl: `${cchBaseUrl}/v1`, apiKey: claudeCredentials.authToken },
    receivedAt: now().toISOString(),
  };

  // `vault.save()` is the sole writer for credential bytes — crypto
  // unavailable at this instant degrades exactly like a real login's save()
  // (enc:'none' + encReason diagnostic), no special skip/retry path added
  // here (§1.5 A-M6: same semantics as a locked-keyring login).
  const saveResult = await vault.save(payload);
  if (!saveResult.ok) {
    return { kind: 'skipped', reason: 'save_failed', saveReason: saveResult.reason };
  }

  await writeAdoptionMarker(markerPath, now());
  return { kind: 'adopted' };
}

let currentLatch: Promise<void> = Promise.resolve();
let lastOutcome: VaultAdoptionOutcome | null = null;

/**
 * §1.5 — the full adoption entry point. Carries its own
 * `resolveManagedCredentialsEnabled()` check (flag-off is a zero-FS-IO
 * no-op — never even calls `vault.read()`), so callers (`main/index.ts`)
 * never need to duplicate the flag check.
 *
 * Also updates the module-level adoption latch (`getAdoptionLatch()`) and
 * the last-outcome cache (`getMigrationIncompleteSignal()`, consumed by
 * `AuthStateService` to produce `credentials_invalid: migration_incomplete`
 * — §1.4) as a side effect, so `main/index.ts` calling this once at boot is
 * the only wiring needed.
 */
export function ensureVaultAdoption(
  vault: AdoptionVault,
  userDataDir: string,
  options: { now?: () => Date; env?: NodeJS.ProcessEnv } = {}
): Promise<VaultAdoptionOutcome> {
  if (!resolveManagedCredentialsEnabled(options.env)) {
    const result: VaultAdoptionOutcome = { kind: 'skipped', reason: 'flag_off' };
    lastOutcome = result;
    currentLatch = Promise.resolve();
    return Promise.resolve(result);
  }

  const task = performAdoption(vault, userDataDir, options.now ?? (() => new Date())).then(
    (outcome) => {
      lastOutcome = outcome;
      return outcome;
    }
  );
  currentLatch = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

/** `auth.getGateSnapshot`'s IPC handler awaits this before returning a snapshot — see `main/ipc/auth.ts`. Resolves immediately (already-resolved promise) before `ensureVaultAdoption` has ever been called, and on flag-off. */
export function getAdoptionLatch(): Promise<void> {
  return currentLatch;
}

export interface AuthStateMigrationSignal {
  migrationIncomplete: boolean;
  legacyEmail: string | null;
}

/**
 * §1.4 — "registered=true but a required source is missing or the guard
 * rejected" is exactly the `claude_credentials_missing` / `guard_rejected`
 * skip reasons; every other outcome (including "never registered at all")
 * must NOT produce `migration_incomplete`. Consumed by
 * `AuthStateService.refresh()` via its injected `migrationSignal` option
 * (wired in `services/auth/index.ts`).
 */
export function getMigrationIncompleteSignal(): AuthStateMigrationSignal {
  if (lastOutcome?.kind === 'skipped' && lastOutcome.reason === 'claude_credentials_missing') {
    return { migrationIncomplete: true, legacyEmail: lastOutcome.legacyEmail };
  }
  if (lastOutcome?.kind === 'skipped' && lastOutcome.reason === 'guard_rejected') {
    return { migrationIncomplete: true, legacyEmail: lastOutcome.legacyEmail };
  }
  return { migrationIncomplete: false, legacyEmail: null };
}

/** Test-only: reset module state between test cases (mirrors `resetAuthSingletonsForTests`). */
export function resetAdoptionStateForTests(): void {
  currentLatch = Promise.resolve();
  lastOutcome = null;
}
