/**
 * The runtime binding for a chat session and its persisted history reader.
 *
 * Chat execution is DSH-only (dsh-rebase decision 004): every new, resumed and
 * forked session is `dsh`. `pi` names sessions the retired native engine wrote;
 * they stay readable, and their first continue migrates them to `dsh`
 * (P1-9d, decision 050); imports and the embedded Pi TUI still produce them.
 * Terminal CLI ids and one-shot provider ids remain separate axes in their own
 * modules and must not be cast into this type.
 *
 * The value is persisted in `session-index.json` and crosses the renderer,
 * Main, and agent-host protocol, so it is an ABI. Keep the list append-only
 * when a future chat runtime is intentionally added.
 */

/** Persisted and wire names for chat runtimes. */
export const AGENT_WIRE_NAMES = ['pi', 'dsh'] as const;

export type AgentWireName = (typeof AGENT_WIRE_NAMES)[number];

/** Human-facing product names, for UI copy only. */
export const AGENT_DISPLAY_NAMES: Record<AgentWireName, string> = {
  pi: 'Pi',
  dsh: 'DSH',
};

/**
 * Sessions written by the retired native engine, plus imports and TUI-created
 * chats. Migrated to DSH on their first continue (P1-9d, decision 050); the
 * row a migrated chat came from stays `pi`, kept for a rollback (decision 051).
 */
export const PI_AGENT: AgentWireName = 'pi';

/** The chat engine every live session runs on (decisions 004 and 006). */
export const DSH_AGENT: AgentWireName = 'dsh';

export function isAgentWireName(value: unknown): value is AgentWireName {
  return typeof value === 'string' && (AGENT_WIRE_NAMES as readonly string[]).includes(value);
}

/**
 * Read a disk/wire binding without guessing unknown values.
 *
 * Missing and unknown bindings are kept hidden by callers and remain on disk
 * for migration/import tooling or a newer build to understand. Only an
 * explicit known value authorizes a persisted row at all; which of those may
 * still run is the caller's rule (`pi` rows are read-only).
 */
export function resolveAgentWireName(raw: string | null | undefined): AgentWireName | null {
  return isAgentWireName(raw) ? raw : null;
}

/**
 * Read a binding from a materialized or newly-created session. An unset
 * binding is a session this build created and has not run yet, so it is DSH.
 */
export function sessionAgent(session: { agent?: AgentWireName | null }): AgentWireName {
  return session.agent ?? DSH_AGENT;
}
