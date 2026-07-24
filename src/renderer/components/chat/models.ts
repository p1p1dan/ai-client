/**
 * Chat model catalog for the Composer model selector (T-08).
 *
 * Sources per execution plan §3 T-08: a fixed short-name list (settings source
 * not yet wired for chat sessions) plus the Host-reported default from
 * `host.ready.payload.settings.model`, prepended when it is not in the catalog.
 *
 * Host `session.create` accepts a `model` field (claudeRuntime createSession);
 * Cometix/CLI honor short names like `sonnet`/`haiku`/`opus`.
 */

export interface ChatModel {
  id: string;
  label: string;
}

export const CHAT_MODELS: ChatModel[] = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opus', label: 'Opus' },
];

export const DEFAULT_CHAT_MODEL_ID = 'sonnet';

/**
 * Pick the default model id, preferring the Host-reported default when it is
 * a known short name; otherwise fall back to the catalog default.
 */
export function defaultModelId(hostDefault?: string | null): string {
  if (hostDefault && CHAT_MODELS.some((model) => model.id === hostDefault)) {
    return hostDefault;
  }
  return DEFAULT_CHAT_MODEL_ID;
}

/**
 * Build the option list shown by the selector. A Host-reported default not in
 * the catalog is prepended so it remains selectable without losing it.
 */
export function ensureModelOptions(hostDefault?: string | null): ChatModel[] {
  if (hostDefault && !CHAT_MODELS.some((model) => model.id === hostDefault)) {
    return [{ id: hostDefault, label: hostDefault }, ...CHAT_MODELS];
  }
  return CHAT_MODELS;
}
