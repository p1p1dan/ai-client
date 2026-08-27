import path from 'node:path';
import { COMETIX_PIN } from '@shared/agentHost/cometixPin';
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
 *
 * Packaging spec §4.2 — `codexJsPath` is the DELIBERATE OPPOSITE of the D47
 * trio above: it is conditionally spread in, so a `undefined` value means the
 * key is not an own property at all. The two rules differ because the two keys
 * defend against opposite failures:
 *
 * - The D47 trio carries CREDENTIALS. A stray shell/dev-inherited value leaking
 *   into the Host is a contamination bug, so those keys are always present and
 *   explicitly `undefined` to override anything inherited from `process.env`.
 * - `AICLIENT_CODEX_JS_PATH` is a PATH, and the Host treats a user-set value as
 *   an escape hatch (`codexNodeEntry.ts:297`, candidate rule 1). Overriding it
 *   with `undefined` would slam that escape hatch shut for anyone who set the
 *   variable deliberately. Omitting the key instead lets the user's value pass
 *   straight through `AgentHostProcess.start()`'s `{...process.env, ...env}`.
 *
 * So: never "make it consistent" with the trio — the asymmetry IS the design.
 */
/**
 * Read side lives in `src/agent-host/codexNodeEntry.ts:100`. The key name is
 * duplicated as a literal on each side on purpose: Main and the Agent Host are
 * separate builds and Main imports nothing from `src/agent-host` — the exact
 * same arrangement `AICLIENT_NODE_EXEC_PATH` already uses.
 */
export const CODEX_JS_PATH_ENV_KEY = 'AICLIENT_CODEX_JS_PATH';

/**
 * S0' (D60) — the two keys carrying the vault's Claude credential to the Host.
 *
 * Read side: `src/agent-host/claudeSettings.ts`. As with every other key in
 * this file, the name is spelled as a literal on BOTH sides on purpose — Main
 * and the Agent Host are separate builds and Main imports nothing from
 * `src/agent-host`.
 *
 * Deliberately NOT named `ANTHROPIC_*`: those names are the user's to set, and
 * `codexRuntime.ts`'s managed branch strips the whole `ANTHROPIC_` prefix off a
 * managed Codex child. A credential of ours wearing a user-owned name would be
 * both stripped by that rule and indistinguishable from an inherited one.
 */
export const CLAUDE_MANAGED_BASE_URL_ENV_KEY = 'AICLIENT_CLAUDE_BASE_URL';
export const CLAUDE_MANAGED_AUTH_TOKEN_ENV_KEY = 'AICLIENT_CLAUDE_AUTH_TOKEN';

/** Basename of the Node-executable Codex entry point (REQ-8). */
const CODEX_JS_BASENAME = 'codex.js';

/**
 * `<dir(hostEntry)>/node_modules/@openai/codex/bin/codex.js` — pure, no IO.
 *
 * Derived from the Host entry path rather than re-deriving
 * `process.resourcesPath` because `resolveHostEntryPath()` is already the one
 * source of truth for "where the Host artifact lives", and `node_modules` is
 * its sibling in BOTH shapes: packaged (`afterPack.copyAgentHost` copies the
 * whole tree) and dev (`src/agent-host/node_modules`). A second derivation
 * would silently point at a non-existent path in the dev branch.
 *
 * Same-platform by construction: Main derives a path for the machine it is
 * running on, so `node:path`'s host bindings are the correct ones here.
 */
export function deriveBundledCodexJsPath(hostEntryPath: string): string {
  return path.join(
    path.dirname(hostEntryPath),
    'node_modules',
    '@openai',
    'codex',
    'bin',
    CODEX_JS_BASENAME
  );
}

/**
 * `<dir(hostEntry)>/node_modules/@cometix/claude-code/cli.js` — pure, no IO.
 *
 * The runtime this app actually talks to. `@cometix/claude-code` is an
 * unofficial NODE build of Claude Code, pinned and shipped inside the Host
 * bundle, and `agent-host/cometix.ts` hands its path to the Agent SDK as
 * `pathToClaudeCodeExecutable`. A user's globally-installed `claude` is not it
 * and never was — which is why "is Claude available" must be answered from
 * here rather than from a `claude --version` probe.
 *
 * Same derivation as `deriveBundledCodexJsPath` above, for the same reason:
 * `resolveHostEntryPath()` is the one source of truth for where the Host
 * artifact lives, and `node_modules` is its sibling in both the packaged and
 * the dev shape.
 *
 * `cli.js` only. `agent-host/cometix.ts` also tries `cli.mjs` as a second
 * candidate, but that is its business at spawn time; this path exists to answer
 * "did the bundle ship", and a bundle whose `cli.js` is missing is broken
 * whatever else is beside it.
 */
export function deriveBundledCometixCliPath(hostEntryPath: string): string {
  // Segments split off `COMETIX_PIN.name`, not spelled here. Two reasons, and
  // the second one is the load-bearing one: the package name has exactly one
  // definition (bumping the pin cannot leave a stale path behind), and writing
  // the second half of `@cometix/claude-code` as a literal would put the string
  // `claude-code` in a file that has nothing to do with the agent-binding
  // literal of the same spelling — which `agentWireStatic.test.ts` refuses, and
  // is right to refuse, since it cannot tell a package path from a wire name.
  return path.join(
    path.dirname(hostEntryPath),
    'node_modules',
    ...COMETIX_PIN.name.split('/'),
    'cli.js'
  );
}

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
  /** The vault's `claude.baseUrl` (S0'/D60). Same always-present-even-when-`undefined` rule as the Codex trio above: this is a credential-adjacent key, so a stray inherited value must be overridden, not merely left alone. */
  claudeBaseUrl: string | undefined;
  /** The vault's `claude.authToken` (S0'/D60). `undefined` when managed mode is off, or on but the vault holds no usable Claude credentials yet — the Host then falls back to the user's own `settings.json`, exactly as it did before managed mode existed. */
  claudeAuthToken: string | undefined;
  /** Absolute path to the bundled `codex.js`, or `undefined` to omit the key entirely so a user-set value survives (packaging spec §4.2). Conditionally spread — see the header note on why this is the opposite of the trio above. */
  codexJsPath?: string;
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
    // S0' (D60): the Claude credential reaches the Host as ENV, not as a file
    // in a directory we forced `CLAUDE_CONFIG_DIR` to point at. This is the
    // whole substitution — see `claudeSettings.ts` (agent-host) for the read
    // side and its precedence rule over the user's own settings.json.
    [CLAUDE_MANAGED_BASE_URL_ENV_KEY]: input.claudeBaseUrl,
    [CLAUDE_MANAGED_AUTH_TOKEN_ENV_KEY]: input.claudeAuthToken,
    // Conditional on purpose: an absent key lets a user-set value pass through.
    ...(input.codexJsPath ? { [CODEX_JS_PATH_ENV_KEY]: input.codexJsPath } : {}),
  };
}
