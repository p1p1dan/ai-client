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
 * user's real `~/.claude` invisible while it was on. D60 took it away. Pi now
 * receives managed credentials through its isolated agentDir, while terminal
 * compatibility remains separately owned by `SessionManager.ts`.
 *
 * What is left here is the small residue that is still genuinely ours:
 *  - stripping credential-shaped vars this process inherited from the OS;
 *  - retaining the legacy CLI onboarding merge until T35 classifies it;
 *  - synchronizing the managed Pi model/auth configuration.
 *
 * ## Why it is a separate module from `main/index.ts`
 *
 * Unchanged from D47: `main/index.ts` has module-load-time `electron` side
 * effects (protocol privilege registration, `setAsDefaultProtocolClient`)
 * that make importing it in vitest's node environment impractical (this
 * repo's `vitest node 环境 import 挂死` lesson). This module has none — every
 * export is a plain function `main/index.ts` calls at the right point.
 */

import { isCredentialEnvKey } from '../../../../scripts/credential-env-keys.mjs';
import { generateClaudeJson, getEffectiveClaudeJsonPath } from './claudeHome';
import { resolveManagedCredentialsEnabled } from './credentialMode';
import { writeSettingsFile } from './managedFileWriter';

/** Managed credentials on? Set by `activateManagedCredentials()`, read by the two functions below. */
let managedActive = false;

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
  stripInheritedCredentialEnv();
  managedActive = true;
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
 * Phase ③ — retired with S0' (D60), kept as an exported no-op.
 *
 * The legacy Claude/Codex materializers are gone. The remaining phase syncs
 * managed Pi models/auth before WorkerManager can create a fresh generation.
 *
 * The function stays rather than being deleted at the call site: `main/index.ts`
 * documents a THREE-PHASE startup order, and phase ③'s position in that order
 * (after the first window, after crypto promotion, after adoption) is a fact
 * about the sequence worth keeping visible even when the phase has no work.
 * Delete it when the phase itself is re-examined, not as a side effect of this
 * slice.
 */
export async function regenerateFromVault(): Promise<void> {
  if (!managedActive) return;
  const { syncManagedPiModels } = await import('../piModelConfig');
  const result = await syncManagedPiModels();
  if (!result.ok) {
    console.warn('[managed-credentials] Pi model sync skipped:', result.error);
  }
}

/** Test-only: reset module state between test cases (mirrors `resetAuthSingletonsForTests`). */
export function resetManagedCredentialsStartupStateForTests(): void {
  managedActive = false;
}
