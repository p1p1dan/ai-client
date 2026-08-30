import { create } from 'zustand';
import type { ChatMessage, ChatMessageAttachment } from './chatSessions';

/**
 * A user turn that has passed ChatComposer's synchronous send guards but has
 * not yet received the Host's authoritative `message.started{role:'user'}`.
 *
 * This is display-only, in-memory state. It never enters session history and
 * is removed as soon as the authoritative echo appears. `attemptId`, not text,
 * owns reconciliation so two identical prompts remain two distinct sends.
 */
export interface PendingUserMessage {
  attemptId: string;
  sessionId: string;
  text: string;
  attachments: ChatMessageAttachment[];
  /** Last authoritative message id present when this attempt committed. */
  baselineMessageId: string | null;
  startedAt: number;
}

interface PendingUserMessagesStore {
  bySession: Record<string, PendingUserMessage[]>;
  publish: (message: PendingUserMessage) => void;
  clear: (attemptId: string) => void;
  pruneSessions: (sessionIds: readonly string[]) => void;
}

export const usePendingUserMessagesStore = create<PendingUserMessagesStore>()((set) => ({
  bySession: {},
  publish: (message) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [message.sessionId]: [
          ...(state.bySession[message.sessionId] ?? []).filter(
            (item) => item.attemptId !== message.attemptId
          ),
          message,
        ],
      },
    })),
  clear: (attemptId) =>
    set((state) => {
      let changed = false;
      const bySession: Record<string, PendingUserMessage[]> = {};
      for (const [sessionId, messages] of Object.entries(state.bySession)) {
        const next = messages.filter((message) => message.attemptId !== attemptId);
        if (next.length !== messages.length) changed = true;
        if (next.length > 0) bySession[sessionId] = next;
      }
      return changed ? { bySession } : state;
    }),
  pruneSessions: (sessionIds) =>
    set((state) => {
      const live = new Set(sessionIds);
      const bySession = Object.fromEntries(
        Object.entries(state.bySession).filter(([sessionId]) => live.has(sessionId))
      );
      return Object.keys(bySession).length === Object.keys(state.bySession).length
        ? state
        : { bySession };
    }),
}));

/**
 * Whether the Host echo belonging after this attempt's commit baseline has
 * reached the authoritative chat bucket.
 */
export function hasAuthoritativeUserEcho(
  messages: readonly ChatMessage[],
  pending: PendingUserMessage
): boolean {
  const baselineIndex =
    pending.baselineMessageId == null
      ? -1
      : messages.findIndex((message) => message.id === pending.baselineMessageId);
  if (pending.baselineMessageId != null && baselineIndex < 0) return false;
  return messages.slice(baselineIndex + 1).some((message) => message.role === 'user');
}

/** Render-only ChatMessage shape consumed by the existing turn pipeline. */
export function pendingUserToChatMessage(pending: PendingUserMessage): ChatMessage {
  return {
    id: `pending-user:${pending.attemptId}`,
    sessionId: pending.sessionId,
    role: 'user',
    blocks: pending.text
      ? [{ id: `pending-user-block:${pending.attemptId}`, type: 'text', text: pending.text }]
      : [],
    ...(pending.attachments.length > 0 ? { attachments: pending.attachments } : {}),
  };
}

export function isPendingUserMessage(message: ChatMessage): boolean {
  return message.id.startsWith('pending-user:');
}
