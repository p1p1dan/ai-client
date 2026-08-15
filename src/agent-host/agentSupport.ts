/**
 * Which agents THIS Host build will accept — the flag, the current-computed
 * capabilities registry, and the initialize orchestration that builds it.
 *
 * ## Why this is its own module
 *
 * `index.ts` runs `main()` at module scope (it opens stdin and starts reading),
 * so a test that imports it hangs the vitest worker rather than failing. Every
 * function below is what the tests need, so it lives outside that file; `index.ts`
 * calls it and keeps its own module-level wiring (the real fs-touching
 * `probeEntry`/`prepareHome` injected into `buildHostAgentRegistry`).
 *
 * ## Why this module never imports `codexHome.ts` / `codexNodeEntry.ts`
 *
 * Both are real fs-touching modules with no business in a leaf module that
 * tests import directly (F14's whole reason to exist). `buildHostAgentRegistry`
 * takes `probeEntry`/`prepareHome` as injected functions instead: `index.ts`
 * wires the real `resolveCodexLaunch`/`ensureCodexHome` calls, tests wire fakes.
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
 * Why `codex` is (or is not) in `HostAgentRegistry.agents` this run — carried
 * alongside the boolean so a refusal message (and a support log) can say WHICH
 * of the three gates stopped it, without inventing a new wire error code
 * (S3 slice 6 spec §2 point 7). Only set when `available` is false.
 */
export type HostAgentAvailabilityReason = 'flag_off' | 'entry_missing' | 'home_prepare_failed';

export interface HostAgentDetail {
  agent: AgentWireName;
  available: boolean;
  reason?: HostAgentAvailabilityReason;
}

/**
 * One registry build. `agents` is what `host.ready` advertises AND what
 * create/resume enforce — the same "one array, not two facts" invariant
 * `SUPPORTED_AGENTS` used to hold (S2 (b)), now CURRENT-computed availability
 * instead of a flag-only snapshot. `detail` is one row per known agent, in
 * `AGENT_WIRE_NAMES` order, carrying the reason for every unavailable one.
 */
export interface HostAgentRegistry {
  agents: AgentWireName[];
  detail: HostAgentDetail[];
}

/**
 * What `buildHostAgentRegistry` needs from the outside world. `probeEntry` and
 * `prepareHome` are injected rather than imported (see module header) — the
 * real implementations (`index.ts`) are `() => resolveCodexLaunch().ok` and a
 * closure over `ensureCodexHome(...)`.
 */
export interface BuildHostAgentRegistryInput {
  env?: NodeJS.ProcessEnv;
  /** Real impl resolves the codex.js entry (codexNodeEntry.ts). Must not throw. */
  probeEntry: () => boolean;
  /** Real impl prepares the isolated CODEX_HOME (codexHome.ts). Throws on failure. */
  prepareHome: () => void;
}

/**
 * A2/A3 (arbitration doc §2.1): codex availability = flag × entry resolution ×
 * isolated-home preparation, computed fresh from the three gates rather than
 * read off a flag-only snapshot.
 *
 * Short-circuits deliberately: `entry_missing` never calls `prepareHome` (no
 * point preparing a home for an entry that cannot be launched), and `flag_off`
 * never calls either probe (A2's "flag off 时不碰 fs" — the off position must
 * stay side-effect-free).
 */
export function buildHostAgentRegistry(input: BuildHostAgentRegistryInput): HostAgentRegistry {
  const detail: HostAgentDetail[] = [{ agent: CLAUDE_CODE_AGENT, available: true }];

  if (!resolveCodexEnabled(input.env)) {
    detail.push({ agent: CODEX_AGENT, available: false, reason: 'flag_off' });
  } else if (!input.probeEntry()) {
    detail.push({ agent: CODEX_AGENT, available: false, reason: 'entry_missing' });
  } else {
    try {
      input.prepareHome();
      detail.push({ agent: CODEX_AGENT, available: true });
    } catch {
      // Directory creation / config projection / credential copy failed. Codex
      // simply does not broadcast this run — never thrown onward, because a
      // registry build must never take Claude Code down with it (A4).
      detail.push({ agent: CODEX_AGENT, available: false, reason: 'home_prepare_failed' });
    }
  }

  return {
    agents: detail.filter((d) => d.available).map((d) => d.agent),
    detail,
  };
}

let cachedRegistry: HostAgentRegistry | null = null;

/**
 * A3 (O9a): memoized single-flight. The FIRST call — whichever call site wins
 * (the `host.initialize` handler, or an earlier-arriving `session.create` /
 * `session.resume` validation, F15) — builds the registry; every later call,
 * from either call site, returns that exact same object without re-running
 * `probeEntry`/`prepareHome`. Flipping `env` after the first call is a no-op
 * (F1 invariant, asserted by G2): the advertised list and the enforced list
 * must never be able to drift apart because a flag flipped mid-run.
 */
export function ensureHostAgentRegistry(input: BuildHostAgentRegistryInput): HostAgentRegistry {
  if (!cachedRegistry) {
    cachedRegistry = buildHostAgentRegistry(input);
  }
  return cachedRegistry;
}

/** Test-only: reset module state between test cases (mirrors forkDraftCarry.ts). */
export function resetHostAgentRegistryForTests(): void {
  cachedRegistry = null;
}

/**
 * Human-readable clue for `HostAgentDetail.reason`, folded into the
 * `agent_unsupported` wire message (S3 slice 6 spec §2 point 7) so the message
 * says WHICH of the three gates stopped Codex — flag never turned on, this
 * machine has no resolvable entry, or the isolated home could not be prepared —
 * without adding a new error code. Three distinct substrings on purpose.
 */
export function describeHostAgentReason(reason: HostAgentAvailabilityReason): string {
  switch (reason) {
    case 'flag_off':
      return `the ${CODEX_FLAG_ENV} feature flag is off for this Host build`;
    case 'entry_missing':
      return 'no @openai/codex bin/codex.js entry point could be resolved on this machine';
    case 'home_prepare_failed':
      return 'the isolated Codex home could not be prepared';
  }
}

/** Either half of {@link initializeHostAgents}'s Claude outcome. */
export type HostInitializeClaudeOutcome<TClaude> =
  | { ok: true; result: TClaude }
  | { ok: false; error: unknown };

export interface HostInitializeOutcome<TClaude> {
  registry: HostAgentRegistry;
  claude: HostInitializeClaudeOutcome<TClaude>;
}

/**
 * A4 (O9b): runs the registry build and the Claude runtime bootstrap as two
 * operations that cannot affect each other's outcome.
 *
 * Registry FIRST, and unconditional: it is built before Claude is even
 * attempted, so a `session.create`/`session.resume` validation racing in right
 * after (or a `host.initialize` that goes on to fail) still sees it (F15).
 * Claude's bootstrap runs after, in its own try/catch, so a Claude
 * `initialize_failed` can never clear or skip the registry built above — and a
 * registry that left codex unavailable (`home_prepare_failed` etc.) never
 * prevents or influences the Claude attempt that follows it. Neither side
 * swallows the other's error: both are reported back, independently.
 *
 * `buildRegistry` is expected not to throw — `buildHostAgentRegistry` already
 * captures every `prepareHome` failure as data (a `reason`, never an
 * exception) — so a throw here is a bug in the injected probes, not something
 * papered over: it propagates instead of being caught, same as any other
 * programmer error would.
 */
export async function initializeHostAgents<TClaude>(input: {
  buildRegistry: () => HostAgentRegistry;
  ensureClaudeRuntime: () => Promise<TClaude>;
}): Promise<HostInitializeOutcome<TClaude>> {
  const registry = input.buildRegistry();
  try {
    const result = await input.ensureClaudeRuntime();
    return { registry, claude: { ok: true, result } };
  } catch (error) {
    return { registry, claude: { ok: false, error } };
  }
}
