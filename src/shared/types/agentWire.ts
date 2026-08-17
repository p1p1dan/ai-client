/**
 * Which runtime a CHAT SESSION is bound to — the wire names, and the only
 * place in the tree a default agent literal is allowed to exist.
 *
 * ## Three axes, and they never convert into one another
 *
 * | axis | question it answers | where |
 * |---|---|---|
 * | `AgentWireName` (here) | which runtime runs THIS chat session, and which reader replays its history | persisted + Host protocol |
 * | `BuiltinAgentId` | which CLI the TERMINAL can spawn | `shared/types/cli.ts` |
 * | `AIProvider` | which provider runs a ONE-SHOT assistant (commit message, code review, todo polish) | `shared/types/ai.ts` |
 *
 * The values deliberately do not line up across the three tables
 * (`'claude-code'` here vs `'claude'` in `BuiltinAgentId` vs `'claude-code'`
 * meaning a provider in `AIProvider`), because the questions do not either. No
 * value from one table may be handed to, or `as`-cast into, another —
 * `agentWireStatic.test.ts` asserts all three directions.
 *
 * ## The values are an ABI, not a label
 *
 * `AgentWireName` is written to `session-index.json` (`SessionIndexEntry.agent`)
 * and travels the renderer ↔ main ↔ agent-host NDJSON protocol. A row on disk
 * outlives any build, so renaming a value orphans every session already written
 * with the old one — the table is append-only, and the exact list is pinned by a
 * test. It never leaves this machine: the `claude-cli/x.y.z (external, cli)`
 * user-agent Anthropic's own `cli.js` sends upstream is a different thing
 * entirely, which this app neither sets nor sees.
 *
 * ## Zero imports on purpose
 *
 * Shared types, main, agent-host and the renderer store all read this module,
 * so it stays a leaf — that is also what keeps the three axes from acquiring an
 * import edge to each other.
 */

/**
 * Every agent a chat session may be bound to. Order and values are both pinned
 * (`agentWireStatic.test.ts`): this list is persisted, so it is an ABI.
 *
 * `'claude'` is deliberately unused — it is reserved for a future agent that
 * talks to the Anthropic API directly instead of driving the Claude Code CLI.
 */
export const AGENT_WIRE_NAMES = ['claude-code', 'codex'] as const;

export type AgentWireName = (typeof AGENT_WIRE_NAMES)[number];

/** Human-facing product names — UI copy only, never compared against. */
export const AGENT_DISPLAY_NAMES: Record<AgentWireName, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/**
 * The sole default in the tree: a session recorded before the field existed is
 * a Claude Code session. Module-private so that "what does a missing binding
 * mean" has exactly one answer — every other site asks `resolveAgentWireName`
 * or `sessionAgent` instead of writing the literal again.
 */
const LEGACY_AGENT: AgentWireName = 'claude-code';

/**
 * Claude Code's own name, for the runtime that reports which agent it is.
 *
 * Exported, unlike `LEGACY_AGENT`, because it answers a different question:
 * "who am I" (asked once, by `claudeRuntime`, when it stamps `session.created`)
 * versus "what does a missing binding mean". They share an answer today and
 * would not if the legacy default ever moved, so they stay two names — and
 * neither is worth re-typing as a literal at the call site, which is what the
 * value-position scan in `agentWireStatic.test.ts` bans.
 */
export const CLAUDE_CODE_AGENT: AgentWireName = 'claude-code';

/**
 * The same name again, typed as the LITERAL rather than as the wide union.
 *
 * `SessionPermissionPolicy` (`runtimeEvents.ts`) is a union discriminated by
 * literal `agent` fields, and a value typed `AgentWireName` cannot narrow it —
 * so a Host building the claude arm of that union would otherwise have to write
 * `'claude-code'` at the call site, which is precisely what the value-position
 * scan bans. (`CODEX_PERMISSION_DEFAULT` writes its own literal for this exact
 * reason; the scan cannot cover `'codex'`, so nothing stopped it.)
 *
 * Read off the ABI list rather than spelled a third time in this file: the
 * order of `AGENT_WIRE_NAMES` is itself pinned, so this cannot silently become
 * some other agent.
 */
export const CLAUDE_CODE_AGENT_ARM = AGENT_WIRE_NAMES[0];

/**
 * Codex's own name, same "who am I" role as {@link CLAUDE_CODE_AGENT}.
 *
 * Note what does NOT protect this one: the value-position scan in
 * `agentWireStatic.test.ts` bans stray `'claude-code'` literals, but the same
 * rule cannot be pointed at `'codex'` — `BuiltinAgentId` (`shared/types/cli.ts`,
 * the terminal axis) carries that exact value, so a naive scan would light up
 * an unrelated axis. That is the failure mode which sank the original scan
 * design, so the gap is left open deliberately and recorded rather than papered
 * over: `'codex'` in value position stays covered only by the inline-default
 * rule (no `.agent ?? '<literal>'`) and the axis-cast rule (no cross-axis `as`).
 */
export const CODEX_AGENT: AgentWireName = 'codex';

export function isAgentWireName(value: unknown): value is AgentWireName {
  return typeof value === 'string' && (AGENT_WIRE_NAMES as readonly string[]).includes(value);
}

/**
 * Disk/wire value → binding, the single fallback point.
 *
 * - missing/empty → `LEGACY_AGENT`: old rows predate the field.
 * - known slug → itself.
 * - unknown non-empty slug → `null`, NOT a guess. It was written by a newer
 *   build than this one (user downgraded), and picking a runtime for it would
 *   run the session against the wrong agent; callers hide the row instead. The
 *   entry stays on disk, so upgrading brings it back.
 */
export function resolveAgentWireName(raw: string | null | undefined): AgentWireName | null {
  if (raw === undefined || raw === null || raw === '') {
    return LEGACY_AGENT;
  }
  return isAgentWireName(raw) ? raw : null;
}

/**
 * Read the binding off a session, materialized or not.
 *
 * `mergeSessionIndex` materializes every row it builds from the index, but a
 * live-only session (created this run, never sent, so it has no index entry at
 * all) passes through its safety net with the field still unset — so "already
 * materialized" is not something a reader can assume. Every consumer calls
 * this instead of writing `session.agent ?? '…'`, which would quietly create a
 * second default.
 */
export function sessionAgent(session: { agent?: AgentWireName | null }): AgentWireName {
  return session.agent ?? LEGACY_AGENT;
}
