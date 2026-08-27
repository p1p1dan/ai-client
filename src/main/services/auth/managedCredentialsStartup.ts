/**
 * The managed-credentials startup orchestration.
 *
 * ## What this module used to be, and why it changed (S0' / D60)
 *
 * It was `managedClaudeHomeStartup.ts`, and its job was to build a managed
 * claude-home: a directory `<userData>/claude-home` that Main pointed
 * `CLAUDE_CONFIG_DIR` at, seeded with our own `settings.json` (carrying the
 * vault credential), a `.claude.json`, a generated-artifact sidecar, empty
 * `commands/` and `skills/` folders, and a one-time copy of the user's
 * CLAUDE.md.
 *
 * The redirection is what made all of that necessary — and what made the
 * user's real `~/.claude` invisible while it was on. D60 took it away: the
 * credential now travels to the Agent Host as env (`hostEnv.ts`), and to a
 * terminal PTY the same way (`SessionManager.ts`), so nothing needs to
 * control which directory Claude Code reads. The user's CLAUDE.md, commands,
 * skills, plugins and hooks are simply theirs again.
 *
 * What is left here is the small residue that is still genuinely ours:
 *  - stripping credential-shaped vars this process inherited from the OS
 *    shell, so a stray `ANTHROPIC_API_KEY` cannot shadow the managed one;
 *  - making sure the user's own `.claude.json` says onboarding is done, so a
 *    first-time user is not dropped into the CLI's theme/trust wizard inside
 *    our GUI (E2 evidence, 2026-08-15) — a MERGE into their file, never a
 *    rewrite;
 *  - the codex-home regenerate tick, which still needs a file on disk.
 *
 * ## Why it is a separate module from `main/index.ts`
 *
 * Unchanged from D47: `main/index.ts` has module-load-time `electron` side
 * effects (protocol privilege registration, `setAsDefaultProtocolClient`)
 * that make importing it in vitest's node environment impractical (this
 * repo's `vitest node 环境 import 挂死` lesson). This module has none — every
 * export is a plain function `main/index.ts` calls at the right point.
 */

import { app } from 'electron';
import { isCredentialEnvKey } from '../../../../scripts/credential-env-keys.mjs';
import { resolveManagedCredentialsEnabled } from './AuthStateService';
import { generateClaudeJson, getEffectiveClaudeJsonPath } from './claudeHome';
import { regenerateManagedCodexHome } from './codexHome';
import { getCredentialVault } from './index';
import { writeSettingsFile } from './managedFileWriter';

/** Managed credentials on? Set by `activateManagedCredentials()`, read by the two functions below. */
let managedActive = false;

/**
 * Dev-only, one-shot: `ANTHROPIC_*` captured before stripping.
 *
 * Kept because `resolveClaudeManagedHostEnv` (AgentHostManager) reads the
 * vault, and a dev machine with an `absent` vault would otherwise spawn a
 * Host with zero credentials — the A-track M9 failure. Exported through
 * {@link getDevCredentialSeed} rather than written into a file, matching how
 * the real credential now travels.
 */
let devCredentialSeed: { baseUrl: string; authToken: string } | null = null;

function captureDevCredentialSeedBeforeStrip(): void {
  if (app.isPackaged) return;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (baseUrl && authToken) {
    devCredentialSeed = { baseUrl, authToken };
  }
}

/** Strips every credential-shaped env var Main inherited from the OS/shell — shared list with `scripts/dev.js` so a stray host `ANTHROPIC_API_KEY` can't shadow the managed credentials. */
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
 * managed-credentials flag is off; that is what the flag-off "env 零变异"
 * test asserts against, and it still holds.
 *
 * D60: this no longer sets `CLAUDE_CONFIG_DIR`. Whatever the user set stays
 * exactly as they set it — including nothing, which is the common case and
 * means Claude Code reads their own `~/.claude`.
 */
export function activateManagedCredentials(): void {
  if (!resolveManagedCredentialsEnabled()) {
    return;
  }
  captureDevCredentialSeedBeforeStrip();
  stripInheritedCredentialEnv();
  managedActive = true;
}

/**
 * The dev fallback credential, or `null`. Read by `AgentHostManager` when the
 * vault has nothing usable — see {@link devCredentialSeed}.
 */
export function getDevCredentialSeed(): { baseUrl: string; authToken: string } | null {
  return devCredentialSeed;
}

/**
 * Phase ① — make sure the user's `.claude.json` reports completed onboarding.
 *
 * A MERGE, and the direction matters: `{ ...generateClaudeJson(), ...current }`
 * puts the user's existing document LAST, so every key they already have wins
 * and we only fill in what is missing. For a user who has run Claude Code
 * before, this is a no-op; for a first-timer whose only Claude Code is ours,
 * it is what keeps the CLI from opening its theme/trust wizard inside our GUI
 * (E2 spike, 2026-08-15).
 *
 * No-op when managed mode is off.
 */
export async function ensureUserClaudeJsonOnboarded(): Promise<void> {
  if (!managedActive) {
    return;
  }
  await writeSettingsFile(getEffectiveClaudeJsonPath(), (current) => ({
    ...generateClaudeJson(),
    ...current,
  }));
}

/**
 * Phase ③ — MUST only run after the first `BrowserWindow` is constructed
 * (same upgrade-latch prerequisite as `promoteVaultCrypto`).
 *
 * D60 shrank this to the codex half. The Claude credential no longer needs
 * materializing at all: `AgentHostManager` reads the vault fresh on every
 * Host spawn and passes the credential as env, so a login/logout is picked up
 * by the Host restart that already follows it — there is no file to keep in
 * sync, and therefore no window in which a file could be stale.
 *
 * Codex still needs a `config.toml` on disk, so its regenerate tick stays.
 * Every non-`'ok'` vault status — including `absent` — maps to "leave
 * config.toml's bytes exactly as they are": a `locked` keyring at boot is a
 * TEMPORARY state, not "no credentials", and rewriting on it would silently
 * wipe a working config on every restart (the B1 failure mode).
 */
export async function regenerateFromVault(): Promise<void> {
  if (!managedActive) {
    return;
  }

  const result = getCredentialVault().read();

  await regenerateManagedCodexHome({
    userDataDir: app.getPath('userData'),
    source: 'startup',
    credentials: result.status === 'ok' ? { baseUrl: result.doc.payload.codex.baseUrl } : null,
  });
}

/** Test-only: reset module state between test cases (mirrors `resetAuthSingletonsForTests`). */
export function resetManagedCredentialsStartupStateForTests(): void {
  managedActive = false;
  devCredentialSeed = null;
}
