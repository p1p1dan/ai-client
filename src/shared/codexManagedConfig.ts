/**
 * D47 S3b §3 — the Main-generated `<userData>/codex-home/config.toml` shape.
 *
 * Pure function, zero `electron` / `node:fs` import: every input is passed in
 * by the caller (`src/main/services/auth/codexHome.ts`, S3b), and the caller
 * owns the atomic write (`managedFileWriter`) + sidecar stamp.
 *
 * ## Why this is static, not per-session
 *
 * `codexRuntime.ts:1355`/`1440` (agent-host, S4a) always sends the same
 * `CODEX_PERMISSION_DEFAULT` posture on `thread/start` — it is a build-time
 * constant, not a per-session choice — so Main can write the posture into
 * `config.toml` once, ahead of any session ever starting, instead of
 * regenerating it per Host spawn. `blessing spike` (see
 * `src/main/services/auth/__tests__/fixtures/codex-config.README.md`)
 * verified the shape below against a real `codex --strict-config` run.
 *
 * ## Why no `model` root key
 *
 * B-track b (D47 S34 spec rev.2 §3): `buildThreadStartParams` supports a
 * SESSION-level `model` override (`codexRuntime.ts:210`/`1479`), so a global
 * `model` in `config.toml` would only ever apply to the (never-taken) no-model
 * path. Omitting it means "no session model" falls through to whatever the
 * `codex` binary's OWN built-in default is (0.145.0 [实测]: `gpt-5.6-sol`) —
 * a `codex` upgrade can silently change that default. Registered, not fixed
 * here: pinning OUR OWN default would be a second source of truth that drifts
 * from the binary's actual behavior.
 *
 * ## Why no context-window keys
 *
 * `model_context_window` / `model_auto_compact_token_limit` (O4) are dropped —
 * unlike the legacy `~/.codex/config.toml` writer
 * (`OnboardingService.upsertCodexConfigToml`), this generator has no per-model
 * knowledge to size them correctly, and a wrong static number is worse than
 * relying on the binary's own model-aware default.
 */

/** The only `model_providers.*` table this file ever writes. */
export const CODEX_MANAGED_CONFIG_PROVIDER_ID = 'jyw';

/** `env_key` the generated `[model_providers.jyw]` table points at — Main injects the matching value via `AICLIENT_CODEX_API_KEY` (hostEnv.ts / SessionManager.ts, S3b). */
export const CODEX_MANAGED_CONFIG_ENV_KEY = 'AICLIENT_CODEX_API_KEY';

/**
 * The posture written into the two root keys. MUST stay byte-identical to
 * agent-host's `CODEX_PERMISSION_DEFAULT` (`src/agent-host/codexRuntime.ts`) —
 * pinned by a same-source assertion test
 * (`src/shared/__tests__/codexManagedConfig.test.ts`). Cross-tsconfig import
 * is not viable here (agent-host imports its own siblings with explicit
 * `.ts` extensions, which only ITS OWN `tsconfig.json`
 * — `allowImportingTsExtensions: true` — accepts; the root gate does not, and
 * `exclude` does not stop `tsc` from pulling in an explicitly-imported file —
 * [实测] confirmed by probing `tsc --noEmit` against a one-line import of
 * `codexRuntime.ts`, same finding the S4a spec footnote (A-track M7)
 * anticipated for the reverse direction), so the test pins against the
 * SOURCE TEXT instead (same pattern as
 * `src/main/services/agent-host/__tests__/hostEnv.test.ts`'s
 * `readFileSync(...).toContain(...)` checks).
 */
export const CODEX_MANAGED_CONFIG_POSTURE = {
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
} as const;

export interface ManagedCodexConfigInput {
  /** `vault.codex.baseUrl` — the `buildApiBaseUrl`-normalized value, same bytes as the legacy `~/.codex/config.toml` writer uses (S1 spec §2.1 A-track B7 URL-口径 parity). */
  baseUrl: string;
}

/**
 * D47 S3b §3 — generates the full `config.toml` text, byte-exact and
 * deterministic (same input → same output, no clock/env/fs). Values are
 * TOML basic strings; `JSON.stringify` produces byte-identical escaping for
 * the subset of characters TOML basic strings and JSON strings share
 * (quote/backslash), mirroring `codexHome.ts`'s `renderPermissionPosture`.
 */
export function generateManagedCodexConfigToml(input: ManagedCodexConfigInput): string {
  const lines = [
    `model_provider = ${JSON.stringify(CODEX_MANAGED_CONFIG_PROVIDER_ID)}`,
    `approval_policy = ${JSON.stringify(CODEX_MANAGED_CONFIG_POSTURE.approvalPolicy)}`,
    `sandbox_mode = ${JSON.stringify(CODEX_MANAGED_CONFIG_POSTURE.sandboxMode)}`,
    '',
    `[model_providers.${CODEX_MANAGED_CONFIG_PROVIDER_ID}]`,
    `name = ${JSON.stringify(CODEX_MANAGED_CONFIG_PROVIDER_ID)}`,
    `base_url = ${JSON.stringify(input.baseUrl)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `env_key = ${JSON.stringify(CODEX_MANAGED_CONFIG_ENV_KEY)}`,
  ];
  return `${lines.join('\n')}\n`;
}
