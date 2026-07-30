/**
 * Message metadata registry (T-06): team-side registry that supplements the
 * red-line `chatSessions` store with assistant metadata (model · latency ·
 * completed time · usage) by subscribing to Runtime Events directly.
 *
 * Why a side registry: `chatSessions.ts` only persists message envelopes (no
 * metadata in `message.started`/`completed` payloads, and `usage.updated` has
 * no handler). Rather than touch the red-line store we keep a
 * `messageId -> MessageMetadata` map alongside a `sessionId -> last assistant
 * messageId` index so `usage.updated` (which carries no messageId, only an
 * optional sessionId) can be attributed correctly.
 */

export interface MessageMetadata {
  /** Epoch ms of `message.started`, for latency computation. */
  startedAt?: number | null;
  /** Epoch ms of `message.completed`. */
  completedAt?: number | null;
  latencyMs?: number | null;
  /** Model id bound to the session at the time of the assistant turn. */
  model?: string | null;
  /** Raw usage payload from `usage.updated`. */
  usage?: Record<string, unknown> | null;
}

export interface MetadataRegistry {
  byMessage: Record<string, MessageMetadata>;
  bySessionLastAssistant: Record<string, string>;
}

export const initialMetadataRegistry: MetadataRegistry = {
  byMessage: {},
  bySessionLastAssistant: {},
};

interface MetadataRegistryEvent {
  type: string;
  sessionId?: string;
  payload?: unknown;
}

function readPayload(event: MetadataRegistryEvent): Record<string, unknown> | undefined {
  const payload = event.payload;
  if (payload && typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  return undefined;
}

function readString(
  payload: Record<string, unknown> | undefined,
  field: string
): string | undefined {
  if (payload && typeof payload[field] === 'string') {
    return payload[field] as string;
  }
  return undefined;
}

/**
 * Fold a Runtime Event into the registry. Pure; safe to call for any event.
 * `sessionModel` (preferred over manual per-call) is the model id to stamp on
 * new assistant metadata entries; pass the session-bound model id resolved
 * from the team-side `useSessionModel` so the assistant bubble shows it.
 */
export function reduceMessageMetadata(
  prev: MetadataRegistry,
  event: MetadataRegistryEvent,
  sessionModel?: string | null
): MetadataRegistry {
  const payload = readPayload(event);
  const sessionId = (event as { sessionId?: string }).sessionId;
  const ts = (event as { timestamp?: number }).timestamp;

  switch (event.type) {
    case 'message.started': {
      const messageId = readString(payload, 'messageId');
      const role = readString(payload, 'role');
      if (!messageId || !sessionId) return prev;
      if (role === 'assistant') {
        // Round-2 P0 (event source real model): the event's own model —
        // read off the SDK assistant message by the Host normalizer — wins
        // over the locally-selected `sessionModel` when present. This closes
        // "displayed selection masks the actual model": `sessionModel` here
        // is already `getSessionModel(sessionId) ?? defaultModelId(null)`
        // (useMessageMetadata.ts), so the fallback chain end to end is
        // event's real model > session selection > catalog default.
        const actualModel = readString(payload, 'model');
        const byMessage = {
          ...prev.byMessage,
          [messageId]: { startedAt: ts ?? null, model: actualModel ?? sessionModel ?? null },
        };
        return {
          byMessage,
          bySessionLastAssistant: { ...prev.bySessionLastAssistant, [sessionId]: messageId },
        };
      }
      return prev;
    }
    case 'message.completed': {
      const messageId = readString(payload, 'messageId');
      if (!messageId) return prev;
      const existing = prev.byMessage[messageId] ?? {};
      const startedAt = existing.startedAt ?? null;
      const latencyMs = startedAt != null && ts != null ? ts - startedAt : null;
      const byMessage = {
        ...prev.byMessage,
        [messageId]: {
          ...existing,
          completedAt: ts ?? null,
          latencyMs,
        },
      };
      return { ...prev, byMessage };
    }
    case 'usage.updated': {
      const sid = sessionId ?? '';
      if (!payload) return prev;
      const messageId = sid ? prev.bySessionLastAssistant[sid] : undefined;
      if (!messageId) return prev;
      const existing = prev.byMessage[messageId] ?? {};
      const byMessage = {
        ...prev.byMessage,
        [messageId]: { ...existing, usage: { ...(existing.usage ?? {}), ...payload } },
      };
      return { ...prev, byMessage };
    }
    default:
      return prev;
  }
}

/**
 * Build the display line for an assistant bubble from metadata, e.g.
 * "Sonnet · 1.2s · 10:30" or "Sonnet · 10:30" when latency/usage missing.
 * Returns null when nothing useful is available.
 *
 * `omitLatency` (T-05): the footer line drops its own latency segment once
 * the turn-level "Worked for Ns" row (A07 :2398) takes over that duty —
 * `MessageTimeline` always passes `true` for the new assistant footer, e.g.
 * "claude-opus-5 · 07:41" (A07 :1776-1782).
 */
export function formatMessageMetadata(
  metadata: MessageMetadata | undefined,
  options: { formatTime?: (ms: number) => string; omitLatency?: boolean } = {}
): string | null {
  if (!metadata) return null;
  const parts: string[] = [];
  if (metadata.model) parts.push(metadata.model);
  if (!options.omitLatency && metadata.latencyMs != null && metadata.latencyMs >= 0) {
    parts.push(`${(metadata.latencyMs / 1000).toFixed(1)}s`);
  }
  if (metadata.completedAt != null) {
    const fmt = options.formatTime ?? defaultFormatTime;
    parts.push(fmt(metadata.completedAt));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function defaultFormatTime(ms: number): string {
  const date = new Date(ms);
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${hours}:${minutes}`;
}
