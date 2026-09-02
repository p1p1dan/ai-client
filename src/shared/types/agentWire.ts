/**
 * The runtime binding for a chat session and its persisted history reader.
 *
 * Chat execution is Pi-only. Terminal CLI ids and one-shot provider ids remain
 * separate axes in their own modules and must not be cast into this type.
 *
 * The value is persisted in `session-index.json` and crosses the renderer,
 * Main, and agent-host protocol, so it is an ABI. Keep the list append-only
 * when a future chat runtime is intentionally added.
 */

/** Persisted and wire names for chat runtimes. */
export const AGENT_WIRE_NAMES = ['pi'] as const;

export type AgentWireName = (typeof AGENT_WIRE_NAMES)[number];

/** Human-facing product names, for UI copy only. */
export const AGENT_DISPLAY_NAMES: Record<AgentWireName, string> = {
  pi: 'Pi',
};

/** The only chat runtime currently supported by this application. */
export const PI_AGENT: AgentWireName = 'pi';

export function isAgentWireName(value: unknown): value is AgentWireName {
  return typeof value === 'string' && (AGENT_WIRE_NAMES as readonly string[]).includes(value);
}

/**
 * Read a disk/wire binding without guessing unknown values.
 *
 * Missing and unknown bindings are kept hidden by callers and remain on disk
 * for migration/import tooling or a newer build to understand. Only an
 * explicit `pi` value authorizes a persisted row for live execution.
 */
export function resolveAgentWireName(raw: string | null | undefined): AgentWireName | null {
  return isAgentWireName(raw) ? raw : null;
}

/** Read a binding from a materialized or newly-created session. */
export function sessionAgent(session: { agent?: AgentWireName | null }): AgentWireName {
  return session.agent ?? PI_AGENT;
}
