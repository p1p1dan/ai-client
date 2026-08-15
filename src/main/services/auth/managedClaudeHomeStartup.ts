/**
 * D47 S2a §1 — the managed claude-home two-phase startup orchestration.
 * Extracted out of `main/index.ts` (rather than left inline) SPECIFICALLY so
 * the flag-off byte-equivalence contract (D47 S2 spec §2/§3-7: "env zero
 * mutation" + "disk golden diff") is actually testable — `main/index.ts`
 * itself has module-load-time `electron` side effects (protocol privilege
 * registration, `app.setAsDefaultProtocolClient`, etc.) that make it
 * impractical/unsafe to import directly in vitest's node environment (see
 * this repo's `vitest node 环境 import 挂死` lesson). This module has none of
 * that — every export is a plain function `main/index.ts` calls at the right
 * point in its own bootstrap sequence.
 *
 * Not a "pure module" in S1's strict sense (it imports `electron`'s `app`
 * and `getCredentialVault()`), same tier as `OnboardingService.ts`.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { isCredentialEnvKey } from '../../../../scripts/credential-env-keys.mjs';
import { resolveManagedCredentialsEnabled } from './AuthStateService';
import {
  AICLIENT_GENERATED_SIDECAR_NAME,
  type ClaudeHomeCredentials,
  generateClaudeJson,
  generateClaudeSettings,
  generateSidecarStamp,
  getManagedClaudeHomeDir,
} from './claudeHome';
import { regenerateManagedCodexHome } from './codexHome';
import { getCredentialVault } from './index';
import { writeSettingsFile } from './managedFileWriter';

/** Set by `activateManagedClaudeHome()`; `null` whenever the flag is off. */
let managedClaudeHomeDir: string | null = null;
/** Dev-only, one-shot: `ANTHROPIC_*` captured before stripping, so a vault `absent` read in phase ③ still has something to seed with (A-track M9 — otherwise dev flag-on runs with zero credentials). */
let devCredentialSeed: ClaudeHomeCredentials | null = null;

function captureDevCredentialSeedBeforeStrip(): void {
  if (app.isPackaged) return;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (baseUrl && authToken) {
    devCredentialSeed = { baseUrl, authToken };
  }
}

/** Strips every credential-shaped env var Main inherited from the OS/shell — shared list with `scripts/dev.js` (D47 S2a §1) so a stray host `ANTHROPIC_API_KEY` can't shadow the managed credentials this process is about to write. */
function stripInheritedCredentialEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (isCredentialEnvKey(key)) {
      delete process.env[key];
    }
  }
}

/**
 * Phase ① entry point — call right after `app.setPath('userData', ...)`,
 * before any other service action. No-op (zero env mutation) when the
 * managed-credentials flag is off — this is the function the flag-off
 * "env 零变异" test asserts against.
 */
export function activateManagedClaudeHome(): void {
  if (!resolveManagedCredentialsEnabled()) {
    return;
  }
  captureDevCredentialSeedBeforeStrip();
  stripInheritedCredentialEnv();
  managedClaudeHomeDir = getManagedClaudeHomeDir(app.getPath('userData'));
  // Overrides whatever `scripts/dev.js` already set — managed mode is
  // authoritative over the dev-only isolated config dir.
  process.env.CLAUDE_CONFIG_DIR = managedClaudeHomeDir;
}

/**
 * Phase ① skeleton: directories + `.claude.json` + `commands`/`skills`
 * subdirs, plus a one-time CLAUDE.md adoption copy. Deliberately does NOT
 * touch settings.json — phase ③ (`regenerateFromVault`) owns that file
 * entirely. No-op when `activateManagedClaudeHome()` didn't turn managed
 * mode on (flag off, or not yet called).
 */
export async function ensureManagedHomeSkeleton(): Promise<void> {
  if (!managedClaudeHomeDir) {
    return;
  }
  const dir = managedClaudeHomeDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'commands'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });

  const claudeJsonPath = join(dir, '.claude.json');
  await writeSettingsFile(claudeJsonPath, (current) => ({ ...generateClaudeJson(), ...current }));

  // One-time CLAUDE.md adoption (D47 S2a f 裁定 / U1 spirit): COPY (never
  // move — the original stays put) only if the managed home doesn't already
  // have one, so a user's global instructions don't silently stop applying
  // the moment managed mode turns on.
  const managedClaudeMdPath = join(dir, 'CLAUDE.md');
  const legacyClaudeMdPath = join(homedir(), '.claude', 'CLAUDE.md');
  if (!existsSync(managedClaudeMdPath) && existsSync(legacyClaudeMdPath)) {
    try {
      copyFileSync(legacyClaudeMdPath, managedClaudeMdPath);
    } catch (error) {
      console.warn('[app] Failed to adopt CLAUDE.md into managed claude-home:', error);
    }
  }

  // Generated-artifact header (D47 S2a §1): sidecar file, NEVER a
  // settings.json key. Refreshed on every skeleton pass (i.e. every
  // managed-mode app start) — not merged/preserved like settings.json, this
  // file is entirely AiClient's own.
  try {
    const stamp = generateSidecarStamp(
      app.getVersion(),
      process.env.AICLIENT_BUILD_COMMIT ?? 'unknown'
    );
    writeFileSync(
      join(dir, AICLIENT_GENERATED_SIDECAR_NAME),
      `${JSON.stringify(stamp, null, 2)}\n`,
      'utf-8'
    );
  } catch (error) {
    console.warn('[app] Failed to write claude-home sidecar stamp:', error);
  }
}

/**
 * Phase ③ — MUST only run after the first `BrowserWindow` is constructed
 * (same upgrade-latch prerequisite as `promoteVaultCrypto`; `main/index.ts`
 * calls this right after `openLocalWindow()`, where the crypto adapter is
 * already installed). `locked`/`unsupported`/`invalid` skip the env section
 * entirely — the B1 failure mode this guards against is a `locked` read on
 * every restart silently wiping working credentials (win/mac keyring not yet
 * unlocked at boot is a TEMPORARY state, not "no credentials"). No-op when
 * managed mode isn't on.
 */
export async function regenerateFromVault(): Promise<void> {
  if (!managedClaudeHomeDir) {
    return;
  }

  const result = getCredentialVault().read();

  // D47 S3b — codex-home materialization rides the same phase ③ tick as
  // claude-home, off the SAME vault read (no second read). Unlike claude
  // (which has a dev-seed fallback for `absent`), codex has no comparable
  // seed, so EVERY non-`'ok'` status — including `absent` — maps to "leave
  // config.toml's bytes exactly as they are" (D47 S34 spec rev.2 §2 S3b
  // "vault 非 ok：config 保留既有字节", aligned with claude's
  // locked/unsupported/invalid skip below, but a strict superset for codex).
  // The stale `auth.json` cleanup inside `regenerateManagedCodexHome` still
  // runs unconditionally either way (idempotent, harmless when absent).
  await regenerateManagedCodexHome({
    userDataDir: app.getPath('userData'),
    source: 'startup',
    credentials: result.status === 'ok' ? { baseUrl: result.doc.payload.codex.baseUrl } : null,
  });

  if (
    result.status === 'locked' ||
    result.status === 'unsupported' ||
    result.status === 'invalid'
  ) {
    return;
  }

  const credentials: ClaudeHomeCredentials | null =
    result.status === 'ok'
      ? {
          baseUrl: result.doc.payload.claude.baseUrl,
          authToken: result.doc.payload.claude.authToken,
        }
      : devCredentialSeed; // status === 'absent'

  const settingsPath = join(managedClaudeHomeDir, 'settings.json');
  await writeSettingsFile(settingsPath, (current) => ({
    ...current,
    ...generateClaudeSettings(credentials),
  }));
}

/** Test-only: reset module state between test cases (mirrors `resetAuthSingletonsForTests`). */
export function resetManagedClaudeHomeStartupStateForTests(): void {
  managedClaudeHomeDir = null;
  devCredentialSeed = null;
}
