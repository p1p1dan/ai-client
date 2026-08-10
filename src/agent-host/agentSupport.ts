/**
 * Which agents THIS Host build will accept — the flag, and the list it produces.
 *
 * ## Why this is its own module
 *
 * `index.ts` runs `main()` at module scope (it opens stdin and starts reading),
 * so a test that imports it hangs the vitest worker rather than failing. The two
 * pure functions below are what the tests need, so they live outside that file;
 * `index.ts` calls them once at startup and keeps its own module-level constant.
 */

import type { AgentWireName } from '../shared/types/agentWire.ts';
import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '../shared/types/agentWire.ts';

/** S3 slice 2 feature flag (standard #6: ship behind a flag, run both positions). */
export const CODEX_FLAG_ENV = 'AICLIENT_AGENT_CODEX';

/**
 * Is the Codex runtime switched on?
 *
 * ONLY `'1'` is on. This reads the opposite way round from the existing
 * kill-switch `AICLIENT_HOST_SUBAGENT_ACTIVITY` (`claudeRuntime.ts`), which
 * defaults ON and treats anything but `'0'` as on — that one guards a shipped
 * fix, this one guards an unfinished runtime, so absent/misspelled/`'true'`
 * must all mean off. A permissive reader here would turn Codex on for a user
 * who wrote `AICLIENT_AGENT_CODEX=false`.
 *
 * The env is read per call, not captured at module load, so a test can flip
 * positions between assertions without re-importing (same convention as
 * `resolveSubagentActivityEnabled`). Main passes the normalized `'1'`/`'0'`;
 * the strictness here is what makes any other value harmless.
 */
export function resolveCodexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CODEX_FLAG_ENV] === '1';
}

/**
 * The agents this build advertises on `host.ready` AND accepts on
 * `session.create` — one array, so the advertised list and the enforced list
 * cannot drift into two facts.
 *
 * Order is part of the value: `claude-code` is first because it is the legacy
 * default every build can run, and a consumer that takes the head as "the
 * default agent" must keep getting Claude Code when Codex is on.
 */
export function supportedAgents(input: { codexEnabled: boolean }): readonly AgentWireName[] {
  return input.codexEnabled ? [CLAUDE_CODE_AGENT, CODEX_AGENT] : [CLAUDE_CODE_AGENT];
}
