/**
 * Which agents THIS Host build will accept — the current-computed capabilities
 * registry and the initialize orchestration that builds it.
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

/**
 * ## Why there is no `AICLIENT_AGENT_CODEX` flag any more (2026-08-26, 用户拍板)
 *
 * There used to be one: `'1'` to turn Codex on, absent/anything-else to keep
 * it off, guarding what was then an unfinished runtime (S3 slice 2, standard
 * #6). The runtime finished — S3's six slices, D48's four, and the 2b
 * packaging chain all landed, and codex now ships INSIDE the app — so the
 * flag's stated job was done.
 *
 * It was also unreachable, which is the half that decided this. The flag's
 * only path into the Host was `AgentHostProcess.start()` spreading
 * `process.env`, i.e. it could only ever be set by whoever launched Electron.
 * A user who double-clicks a desktop icon or a Dock entry gets the desktop
 * session's environment — `~/.bashrc` and `~/.zshrc` are never read — so on
 * Linux and macOS there was no way for a packaged user to switch Codex on at
 * all: no settings toggle (deliberately: `hostEnv.ts` refuses to inject this
 * key, to avoid a second place deciding what it means), no menu, and exporting
 * it in a terminal does nothing unless the app is launched from that terminal.
 * A switch the product's actual users cannot reach is not a rollout control;
 * it is an off switch welded shut.
 *
 * So availability is now decided ONLY by things that are true or false about
 * the machine — credentials, a resolvable entry, a preparable home — and every
 * one of those already has its own reason code below.
 *
 * **Consequence worth knowing**: `prepareHome()` used to be short-circuited by
 * the off position (the flag arm was deliberately side-effect-free). It now
 * runs on every Host start, for every user, including ones who never open
 * Codex. In the fallback branch that means creating `<userData>/codex-home/`,
 * projecting the user's `~/.codex/config.toml` into it, and copying their
 * `auth.json` if it is newer. It only ever READS `~/.codex` — never writes
 * there — and it is idempotent, but it is no longer free.
 */

/**
 * D47 S4 §1 (rev.2) — the explicit managed-mode marker. `'1'` ONLY: this is
 * NOT reused from the presence of a base URL or any other side-channel
 * (rev.1's "a" was independently struck down by both review tracks), and no
 * other spelling counts as on. (That strictness used to be stated by
 * reference to the retired `AICLIENT_AGENT_CODEX` flag; it stands on its own
 * — a permissive reader here would put a user who wrote
 * `AICLIENT_CODEX_MANAGED=false` into managed mode.)
 *
 * The literal string appears EXACTLY ONCE in `src/agent-host` — right here —
 * and every one of the resolver's readers (the registry below, `codexHome.ts`,
 * `codexRuntime.ts`'s home call and its spawn-env build) goes through
 * {@link resolveCodexCredentialMode} instead of re-testing this env var
 * itself; `agentSupport.test.ts` statically scans the directory for the
 * literal to keep that true. Main's own half of this contract
 * (`hostEnv.ts`) asserts its own side independently — see that file's
 * docstring for the split ("each half asserted on its own").
 */
export const CODEX_MANAGED_ENV = 'AICLIENT_CODEX_MANAGED';

/**
 * The one credential a managed session's spawn env carries (`codexRuntime.ts`)
 * and the same name `config.toml`'s `env_key` points codex at (S3b,
 * `codexManagedConfig.ts`) — the indirection E4 measured live.
 */
export const CODEX_MANAGED_API_KEY_ENV = 'AICLIENT_CODEX_API_KEY';

/**
 * The three-state resolver (§1, rev.2 architecture pick). `'fallback'` is
 * TODAY'S behaviour, byte for byte — the marker is off (or anything other
 * than the exact string `'1'`), so nothing downstream may branch on it.
 */
export type CodexCredentialMode =
  | { mode: 'fallback' }
  | { mode: 'managed'; apiKey: string }
  | { mode: 'managed_missing_credentials' };

/**
 * THE single resolver every Host-side reader of managed-mode state must call
 * — never re-test {@link CODEX_MANAGED_ENV} / {@link CODEX_MANAGED_API_KEY_ENV}
 * directly. Four call sites (§1): this file's own registry gate below,
 * `codexHome.ts`'s managed/fallback branch, and `codexRuntime.ts` twice (the
 * `ensureCodexHome` call and the spawn-env build) — all four must agree on the
 * SAME three-way read of the SAME env object, or the registry could advertise
 * `codex` as unavailable while a session already in flight spawns it anyway
 * (or the reverse).
 *
 * `apiKey` is trimmed before the presence check AND before being returned —
 * an env var padded with whitespace by whatever set it must not count as
 * "present" and must not carry the padding onto the wire.
 */
export function resolveCodexCredentialMode(
  env: NodeJS.ProcessEnv = process.env
): CodexCredentialMode {
  if (env[CODEX_MANAGED_ENV] !== '1') return { mode: 'fallback' };
  const apiKey = env[CODEX_MANAGED_API_KEY_ENV]?.trim();
  if (apiKey) return { mode: 'managed', apiKey };
  return { mode: 'managed_missing_credentials' };
}

/**
 * Why `codex` is (or is not) in `HostAgentRegistry.agents` this run — carried
 * alongside the boolean so a refusal message (and a support log) can say WHICH
 * of the three gates stopped it, without inventing a new wire error code
 * (S3 slice 6 spec §2 point 7; `credentials_missing` added D47 S4a;
 * `flag_off` retired 2026-08-26 with the flag itself). Only set when
 * `available` is false.
 */
export type HostAgentAvailabilityReason =
  | 'credentials_missing'
  | 'entry_missing'
  | 'home_prepare_failed';

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
 * A2/A3 (arbitration doc §2.1): codex availability = credential mode × entry
 * resolution × isolated-home preparation, computed fresh from the three gates
 * every run. (It was four gates until 2026-08-26; the flag is gone — see the
 * module header for why.)
 *
 * Short-circuits deliberately, in gate ORDER (§1): `credentials_missing`
 * (marker on, key absent/blank) never calls `probeEntry`/`prepareHome` — there
 * is no point resolving an entry or preparing a home for a session that cannot
 * authenticate; `entry_missing` never calls `prepareHome`.
 *
 * Negative control (§1): marker ABSENT (not `'1'`) resolves to
 * `{mode:'fallback'}`, which is NOT `credentials_missing` — it falls straight
 * through to the entry/home checks exactly as before D47 S4.
 */
export function buildHostAgentRegistry(input: BuildHostAgentRegistryInput): HostAgentRegistry {
  const detail: HostAgentDetail[] = [{ agent: CLAUDE_CODE_AGENT, available: true }];

  if (resolveCodexCredentialMode(input.env).mode === 'managed_missing_credentials') {
    detail.push({ agent: CODEX_AGENT, available: false, reason: 'credentials_missing' });
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
 * says WHICH of the three gates stopped Codex — managed credentials are
 * missing, this machine has no resolvable entry, or the isolated home could
 * not be prepared — without adding a new error code.
 *
 * Three distinct substrings on purpose, and — discipline as of D47 S4a —
 * pairwise NON-CONTAINING: no one clue may be a substring of another. A plain
 * `Set.size` check (this file's test used to stop there) only proves the
 * strings are not equal; it does not catch one clue merely EXTENDING another,
 * which would still confuse a caller that does `message.includes(clue)`.
 */
export function describeHostAgentReason(reason: HostAgentAvailabilityReason): string {
  switch (reason) {
    case 'credentials_missing':
      return `the ${CODEX_MANAGED_API_KEY_ENV} environment variable is required for managed Codex credentials but is missing or empty`;
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
