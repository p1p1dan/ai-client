/** Pi-only defaults for new chat sessions. */
export interface ChatAgentPreference {
  model?: string;
  effort?: string;
}

export type ChatAgentDefaults = ChatAgentPreference;

export const EMPTY_CHAT_AGENT_DEFAULTS: ChatAgentDefaults = {};

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Read the Pi-only shape and migrate one legacy per-agent record without
 * rewriting storage during the read. The next settings write persists the
 * scalar shape.
 */
export function sanitizeChatAgentDefaults(value: unknown): ChatAgentDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const direct: ChatAgentDefaults = {
    ...(stringValue(raw.model) ? { model: stringValue(raw.model) } : {}),
    ...(stringValue(raw.effort) ? { effort: stringValue(raw.effort) } : {}),
  };
  if (direct.model || direct.effort) return direct;

  const byAgent = raw.byAgent;
  if (!byAgent || typeof byAgent !== 'object' || Array.isArray(byAgent)) return {};
  const rows = byAgent as Record<string, unknown>;
  const candidate = rows.pi ?? rows['claude-code'] ?? rows.codex;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
  const row = candidate as Record<string, unknown>;
  const model = stringValue(row.model);
  const effort = stringValue(row.effort);
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function agentDefaultModel(defaults: ChatAgentDefaults | undefined): string | undefined {
  return defaults?.model;
}

export function agentDefaultEffort(defaults: ChatAgentDefaults | undefined): string | undefined {
  return defaults?.effort;
}

/** Immutable Pi-default update; undefined clears a field. */
export function withAgentPreference(
  defaults: ChatAgentDefaults | undefined,
  patch: ChatAgentPreference
): ChatAgentDefaults {
  const next: ChatAgentDefaults = { ...(defaults ?? {}) };
  if ('model' in patch) {
    if (patch.model === undefined) delete next.model;
    else next.model = patch.model;
  }
  if ('effort' in patch) {
    if (patch.effort === undefined) delete next.effort;
    else next.effort = patch.effort;
  }
  return next;
}
