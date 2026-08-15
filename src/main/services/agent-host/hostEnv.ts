import type { AgentHostDriver } from '@shared/types/agentHost';

/**
 * The environment contract between Main and the Agent Host process.
 *
 * Extracted from `AgentHostManager.startInternal` so the four values Main owns
 * live in one place and can be asserted without spawning anything. Each one is
 * here because the Host cannot compute it for itself:
 *
 * - `driver` / `cometixVersion`: Main-side configuration.
 * - `nodeExecPath`: makes an implicit cross-process invariant explicit. The
 *   Host process is already spawned with the Node 24 binary that
 *   `resolveNode24Runtime` picked, so `process.execPath` inside the Host is
 *   the right answer today — but that invariant is maintained by a different
 *   file in a different process, and anyone changing how `AgentHostProcess`
 *   spawns would break it silently. Passing it explicitly lets each half be
 *   asserted on its own: Main asserts it injects the resolved path, the Host
 *   asserts it reads this key.
 * - `codexHomeDir` / `appVersion`: derived from Electron's `app`, which the
 *   Host has no access to. The Host deliberately has NO fallback for the home
 *   directory — a missing value is an explicit error, not a guessed path,
 *   because a second default would be a second source of truth.
 *
 * Deliberately absent: `AICLIENT_AGENT_CODEX`. `AgentHostProcess.start()`
 * spreads `process.env` into the child, so a flag the user sets in their shell
 * already reaches the Host; injecting it here would add a second place that
 * decides what the flag means.
 *
 * D47 S3b §1 — `codexManaged` / `codexApiKey` / `codexHomeManagedDir`: the
 * three Codex managed-credentials keys `AgentHostManager` resolves from the
 * managed-credentials flag + a vault snapshot (`AuthStateService`/
 * `CredentialVault`) at spawn time. Unlike every other field on this
 * interface, this trio is INTENTIONALLY ALWAYS PRESENT ON THE RETURNED
 * OBJECT — including when the value is `undefined` — never conditionally
 * spread in. `AgentHostProcess.start()` builds the child's env as
 * `{...process.env, ...this.options.env, ELECTRON_RUN_AS_NODE: undefined}`;
 * an object literal with an explicit `key: undefined` OVERRIDES an inherited
 * `process.env` value (Node's `child_process` drops `undefined`-valued keys
 * from the spawned env — the same idiom `ELECTRON_RUN_AS_NODE: undefined`
 * already relies on there), whereas simply OMITTING the key from this
 * object would let a stray shell/dev-inherited value leak straight through
 * to the Host (D47 S34 spec rev.2 §1, A-track B3 "继承污染防御"). The
 * flag-off arm is therefore all three of these keys present with value
 * `undefined` — which is also why the pre-existing five-key `toEqual` test
 * in `hostEnv.test.ts` keeps passing unmodified: `toEqual` ignores
 * `undefined`-valued object properties.
 */
export interface AgentHostEnvInput {
  driver: AgentHostDriver;
  cometixVersion: string;
  nodeExecPath: string;
  appVersion: string;
  codexHomeDir: string;
  /** `'1'` when Codex managed-credentials mode is on; `undefined` otherwise. Never any other string — the agent-host resolver (`agentSupport.ts`, S4a) reads this literally as `env.AICLIENT_CODEX_MANAGED !== '1'`. */
  codexManaged: string | undefined;
  /** The vault's `codex.apiKey`. `undefined` when managed mode is off, OR managed mode is on but the vault has no usable Codex credentials yet (agent-host's resolver turns that into `managed_missing_credentials`, not this file's concern). */
  codexApiKey: string | undefined;
  /** `<userData>/codex-home` when managed mode is on (same directory Main materializes `config.toml` into — `src/main/services/auth/codexHome.ts`), `undefined` when off. Lets `ensureCodexHome` (agent-host) validate the managed `config.toml` exists there instead of guessing a path. */
  codexHomeManagedDir: string | undefined;
}

export function buildAgentHostEnv(input: AgentHostEnvInput): NodeJS.ProcessEnv {
  return {
    AICLIENT_AGENT_HOST_DRIVER: input.driver,
    AICLIENT_COMETIX_VERSION: input.cometixVersion,
    AICLIENT_NODE_EXEC_PATH: input.nodeExecPath,
    AICLIENT_APP_VERSION: input.appVersion,
    AICLIENT_CODEX_HOME: input.codexHomeDir,
    AICLIENT_CODEX_MANAGED: input.codexManaged,
    AICLIENT_CODEX_API_KEY: input.codexApiKey,
    AICLIENT_CODEX_HOME_MANAGED_DIR: input.codexHomeManagedDir,
  };
}
