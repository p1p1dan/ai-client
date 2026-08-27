/**
 * D47 S3b §2 — the Main-materialized `<userData>/codex-home` tree. Mirrors
 * `claudeHome.ts`'s "pure generators, electron-facing orchestration lives in
 * the caller" split: this module owns path/shape only, `main/index.ts`
 * (startup phase ③) and `OnboardingService` (login/logout) own calling it at
 * the right lifecycle point (D47 S34 spec rev.2 §2 S3b — "codex-home 物化并入
 * claude-home 同一生命周期").
 *
 * ## Why this writes `config.toml`, never `auth.json`
 *
 * `config.toml`'s `[model_providers.jyw].env_key = "AICLIENT_CODEX_API_KEY"`
 * means the actual credential travels through an ENV VAR Main injects at
 * spawn time (`hostEnv.ts` for the Agent Host, `SessionManager.ts` for a
 * local terminal PTY) — never through a file. `codex-home/auth.json` is a
 * LEGACY ARTIFACT: it only exists if a prior fallback-mode session (or an
 * older build) copied the user's real `~/.codex/auth.json` in there
 * (`src/agent-host/codexHome.ts`'s fallback branch). A stale copy sitting
 * next to our env_key-based config would let codex prefer file-based auth
 * over the env var, silently defeating the whole managed-credentials design —
 * so every one of this module's three lifecycle touch points deletes it,
 * DOUBLING agent-host's own managed-mode deletion (`src/agent-host/codexHome.ts`,
 * S4a) rather than replacing it: whichever side runs first wins, and the
 * other's delete is then a no-op.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateManagedCodexConfigToml,
  type ManagedCodexConfigInput,
} from '@shared/codexManagedConfig';

import { writeManagedFile } from './managedFileWriter';

/**
 * Sidecar filename for the generated-artifact header, written beside a
 * generated `config.toml` — never a key INSIDE it ("no unknown keys").
 *
 * Lived in `claudeHome.ts` until D60, back when both managed homes wrote one.
 * The managed claude-home is gone, so it moved to its only remaining consumer
 * rather than staying behind as a Claude-shaped export nothing Claude uses.
 */
export const AICLIENT_GENERATED_SIDECAR_NAME = '.aiclient-generated';

export interface GeneratedSidecarStamp {
  version: string;
  commit: string;
  generatedAt: string;
}

export function generateSidecarStamp(
  version: string,
  commit: string,
  generatedAt: string = new Date().toISOString()
): GeneratedSidecarStamp {
  return { version, commit, generatedAt };
}

const CODEX_HOME_DIR_NAME = 'codex-home';
const CODEX_CONFIG_BASENAME = 'config.toml';
const CODEX_AUTH_BASENAME = 'auth.json';

/** `<userData>/codex-home` — same directory `AICLIENT_CODEX_HOME`/`AICLIENT_CODEX_HOME_MANAGED_DIR` point the Agent Host at (`hostEnv.ts`, `AgentHostManager.ts`) and `SessionManager.ts` sets `CODEX_HOME` to for a local terminal PTY. */
export function getManagedCodexHomeDir(userDataDir: string): string {
  return join(userDataDir, CODEX_HOME_DIR_NAME);
}

/**
 * D47 S34 spec rev.2 §2 S3b — the three lifecycle touch points that call
 * `regenerateManagedCodexHome`. Recorded in the sidecar stamp's `source`
 * field purely for diagnostics (B-track m1 "验收断言"). `'logout'` is a
 * valid call-site label even though it is never observed on a written
 * sidecar — logout always passes `credentials: null`, so
 * `regenerateManagedCodexHome` never reaches the sidecar-write branch for
 * it; the label exists so the logout call site stays self-documenting
 * instead of borrowing `'startup'` as a meaningless filler.
 */
export type CodexHomeRegenerateSource = 'startup' | 'login' | 'logout';

export interface CodexHomeSidecarStamp {
  /** Constant today — forward-compatible slot for a future non-`'managed'` mode (S4a's fallback branch owns its own, unrelated home). */
  mode: 'managed';
  source: CodexHomeRegenerateSource;
  generatedAt: string;
}

export function generateCodexHomeSidecarStamp(
  source: CodexHomeRegenerateSource,
  generatedAt: string = new Date().toISOString()
): CodexHomeSidecarStamp {
  return { mode: 'managed', source, generatedAt };
}

/**
 * Idempotent, best-effort: absent is not an error (nothing to delete), and a
 * failure is logged, never thrown — this call must never turn a successful
 * login/logout/startup regenerate into a rejected one (mirrors every other
 * best-effort write in this slice, e.g. `managedClaudeHomeStartup.ts`'s
 * CLAUDE.md adoption copy).
 */
function removeManagedCodexAuthJsonIfPresent(codexHomeDir: string): void {
  const authPath = join(codexHomeDir, CODEX_AUTH_BASENAME);
  try {
    if (existsSync(authPath)) {
      rmSync(authPath, { force: true });
    }
  } catch (error) {
    console.warn('[codexHome] Failed to remove stale codex-home/auth.json:', error);
  }
}

export interface RegenerateManagedCodexHomeInput {
  userDataDir: string;
  source: CodexHomeRegenerateSource;
  /**
   * `null` means "leave `config.toml`'s bytes exactly as they are" — the
   * D47 S34 spec rev.2 §2 S3b contract for BOTH cases that map to it:
   *  - startup phase ③ when the vault read is anything other than `status:
   *    'ok'` ("vault 非 ok：config 保留既有字节", aligned with
   *    `claudeHome`'s `locked`/`unsupported`/`invalid` skip semantics — see
   *    `managedClaudeHomeStartup.ts`'s `regenerateFromVault`);
   *  - logout, ALWAYS: `config.toml` never contained the credential (only
   *    `env_key`, an indirection), so there is no "no-credentials" form to
   *    regenerate into — logout only needs the Host/PTY layer to stop
   *    injecting `AICLIENT_CODEX_API_KEY` (`hostEnv.ts`, `SessionManager.ts`).
   *    Leaving `config.toml` in place is the intended end state: a
   *    logged-out terminal launch gets "config present, `Missing
   *    environment variable: AICLIENT_CODEX_API_KEY`" — the E4-present
   *    shape, on purpose (B-track B1). Callers implement this by simply
   *    never invoking this function from a logout path at all — logout's
   *    only codex-home action is `auth.json` cleanup, which every call here
   *    already performs regardless of `credentials`.
   */
  credentials: ManagedCodexConfigInput | null;
}

/**
 * D47 S34 spec rev.2 §2 S3b — the single regenerate entry point for all
 * three codex-home lifecycle touch points (startup phase ③, login, logout).
 * Always deletes a stale `auth.json` first (unconditional — see module
 * header); writes `config.toml` + refreshes the sidecar stamp ONLY when
 * `credentials` is non-null (startup with a vault-`ok` read, or login —
 * logout always passes `null`, so its only effect here is the `auth.json`
 * cleanup).
 */
export async function regenerateManagedCodexHome(
  input: RegenerateManagedCodexHomeInput
): Promise<void> {
  const dir = getManagedCodexHomeDir(input.userDataDir);
  removeManagedCodexAuthJsonIfPresent(dir);

  if (!input.credentials) {
    return;
  }

  const configPath = join(dir, CODEX_CONFIG_BASENAME);
  await writeManagedFile(configPath, generateManagedCodexConfigToml(input.credentials));

  const stamp = generateCodexHomeSidecarStamp(input.source);
  const sidecarPath = join(dir, AICLIENT_GENERATED_SIDECAR_NAME);
  await writeManagedFile(sidecarPath, `${JSON.stringify(stamp, null, 2)}\n`);
}
