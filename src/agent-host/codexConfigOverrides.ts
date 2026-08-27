/**
 * The `-c key=value` overrides every codex spawn carries.
 *
 * S0' codex side (**[D60](../../docs/plans/openchamber-chat-refactor-ledger.md)**).
 * This module is the replacement for a directory: before it, the same facts
 * were expressed by generating a `config.toml` into an app-owned `CODEX_HOME`
 * and pointing codex at it.
 *
 * ## Why the file had to go
 *
 * The credential travelled as a FILE, so we had to control the DIRECTORY the
 * file sat in — and controlling the directory hijacked the user's entire codex
 * config tree along with it: their global `AGENTS.md`, `agents/`, `hooks/`,
 * `skills/`, `plugins/` all stopped existing as far as codex was concerned, with
 * no message saying so. That was never a decision anyone made; it was the price
 * of the file.
 *
 * `-c` costs nothing on disk, so `CODEX_HOME` goes back to being the user's own
 * `~/.codex` and the whole tree comes back structurally — no projection to
 * maintain, no allowlist to keep current, nothing to adopt.
 *
 * ## What is measured, and where
 *
 * Every claim below is [实测], not read off documentation
 * ([E1](../../docs/plans/2026-08-26-s0-spikes/e1-codex-no-home.md) ·
 * [E2](../../docs/plans/2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md)),
 * because the whole design rests on `-c` being able to do what the file did:
 *
 *  - **Credential + provider reach codex** — E1 R2/R3: with `CODEX_HOME` set to
 *    a directory holding the USER'S own provider config, our `-c` overrides win
 *    and authentication succeeds off the env var alone, no file written.
 *  - **A user's own `auth.json` does not shadow us** — E1 R6/R7: a real-shaped
 *    `OPENAI_API_KEY` in their file neither overrides our provider nor acts as a
 *    silent fallback when our env var is missing. This is why the old
 *    "delete `auth.json` so it cannot shadow us" step is gone rather than moved.
 *  - **Posture overrides the user's file** — E1 R5: a config pinning
 *    `approval_policy="never"` / `sandbox_mode="danger-full-access"` is beaten
 *    by our `-c`, with `thread/start` sending no posture params at all.
 *  - **Posture survives a CROSS-PROCESS resume** — E2 A-P2: kill the process,
 *    resume the thread from a fresh one carrying the same `-c`, and the posture
 *    is still ours. The control arm (same resume, no posture `-c`) falls back to
 *    the user's file, so the assertion bites in both directions.
 *
 * ## What `-c` cannot do, and why nothing here tries
 *
 * `-c` MERGES into the config, it does not replace it (E1 R9: `-c
 * mcp_servers={}` does not clear the table; only per-entry
 * `-c mcp_servers.<name>.enabled=false` works, E1 R10). So the user's
 * `mcp_servers` / `developer_instructions` / `notify` flow through and take
 * effect — E2 C1 measured all of them landing in the real outbound request.
 *
 * That is not a gap. It is
 * **[D61](../../docs/plans/openchamber-chat-refactor-ledger.md)**: user config
 * is inherited whole, deliberately. Suppressing it per-entry would mean reading
 * the user's config to enumerate names — which is the "read and rewrite the
 * user's configuration" semantics D60 just removed, wearing a different hat.
 *
 * ## Pure
 *
 * No `fs`, no `process.env`, no clock. The caller resolves the credential and
 * the posture and passes both in, so the same inputs always produce the same
 * argv — which is what makes the spawn line assertable without spawning.
 */

import { CODEX_MANAGED_API_KEY_ENV } from './agentSupport.ts';

/**
 * The provider id our overrides define. It only has to be a name the user's own
 * config is unlikely to have taken; nothing outside this module reads it.
 *
 * Was `CODEX_MANAGED_CONFIG_PROVIDER_ID` in `@shared/codexManagedConfig` while
 * Main generated the TOML. Main no longer writes any codex config, so the
 * constant moved to the only process that still uses it rather than staying
 * shared and needing a same-source test to keep two copies honest.
 */
export const CODEX_MANAGED_PROVIDER_ID = 'jyw';

/** The posture keys, spelled once. */
export const CODEX_POSTURE_CONFIG_KEYS = {
  approvalPolicy: 'approval_policy',
  sandboxMode: 'sandbox_mode',
} as const;

/** What a managed spawn needs to describe its provider. The KEY itself is not here — it travels in the env, and only its NAME appears in an override. */
export interface CodexManagedProvider {
  baseUrl: string;
}

export interface CodexConfigOverrideInput {
  /**
   * The posture this connection runs under — the same object `thread/start`
   * sends, passed in rather than imported so the two carriers cannot be handed
   * different values (the import direction would also be a cycle:
   * `codexRuntime` imports this module).
   */
  posture: { approvalPolicy: string; sandboxMode: string };
  /**
   * `null` in fallback mode: the user's own provider config stands, and we add
   * nothing but the posture. Note that the posture is added EITHER WAY —
   * fallback means "we do not supply the credential", never "the user's
   * `danger-full-access` is in force".
   */
  provider: CodexManagedProvider | null;
}

/**
 * TOML value rendering.
 *
 * `JSON.stringify` for strings: TOML basic strings and JSON strings escape the
 * two characters that matter here (quote, backslash) identically, which is the
 * same equivalence the generator this replaces relied on. Booleans are bare —
 * `"false"` would be the STRING false, which TOML would happily accept and
 * codex would then read as a truthy provider flag.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Flat `['-c', 'k=v', '-c', 'k=v', …]`, ready to concatenate onto the launch
 * plan's args.
 *
 * Flat rather than pairs because that is the shape `spawn` takes, and building
 * the pairs somewhere else is how an argv ends up with a `-c` whose value went
 * missing.
 */
export function buildCodexConfigOverrides(input: CodexConfigOverrideInput): string[] {
  const entries: string[] = [
    `${CODEX_POSTURE_CONFIG_KEYS.approvalPolicy}=${tomlString(input.posture.approvalPolicy)}`,
    `${CODEX_POSTURE_CONFIG_KEYS.sandboxMode}=${tomlString(input.posture.sandboxMode)}`,
  ];

  if (input.provider) {
    const table = `model_providers.${CODEX_MANAGED_PROVIDER_ID}`;
    entries.push(
      `model_provider=${tomlString(CODEX_MANAGED_PROVIDER_ID)}`,
      `${table}.name=${tomlString(CODEX_MANAGED_PROVIDER_ID)}`,
      `${table}.base_url=${tomlString(input.provider.baseUrl)}`,
      `${table}.wire_api=${tomlString('responses')}`,
      `${table}.requires_openai_auth=false`,
      `${table}.env_key=${tomlString(CODEX_MANAGED_API_KEY_ENV)}`
    );
  }

  return entries.flatMap((entry) => ['-c', entry]);
}
