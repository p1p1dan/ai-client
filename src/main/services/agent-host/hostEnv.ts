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
 */
export interface AgentHostEnvInput {
  driver: AgentHostDriver;
  cometixVersion: string;
  nodeExecPath: string;
  appVersion: string;
  codexHomeDir: string;
}

export function buildAgentHostEnv(input: AgentHostEnvInput): NodeJS.ProcessEnv {
  return {
    AICLIENT_AGENT_HOST_DRIVER: input.driver,
    AICLIENT_COMETIX_VERSION: input.cometixVersion,
    AICLIENT_NODE_EXEC_PATH: input.nodeExecPath,
    AICLIENT_APP_VERSION: input.appVersion,
    AICLIENT_CODEX_HOME: input.codexHomeDir,
  };
}
