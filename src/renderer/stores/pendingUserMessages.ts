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
  startedAt: number;
  /** Set from the matching wire `message.started`; cleared after that id reaches chatSessions. */
  authoritativeMessageId?: string;
  /**
   * dsh-rebase decision 093: a Ctrl+Enter message the running turn has been
   * handed but has not taken in yet — it goes in at the turn's next step
   * boundary, or, after a Stop, with the next turn (decision 094). Shown as
   * awaiting delivery rather than sending; retired by the same echo.
   */
  awaitingDelivery?: true;
}

interface PendingUserMessagesStore {
  bySession: Record<string, PendingUserMessage[]>;
  publish: (message: PendingUserMessage) => void;
  /** Pair one renderer attempt with its exact authoritative Pi user echo. */
  acknowledgeAttempt: (sessionId: string, attemptId: string, messageId: string) => void;
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
  acknowledgeAttempt: (sessionId, attemptId, messageId) =>
    set((state) => {
      const messages = state.bySession[sessionId];
      if (!messages || messages.length === 0) return state;
      const index = messages.findIndex((message) => message.attemptId === attemptId);
      if (index < 0) return state;
      const current = messages[index];
      if (!current || current.authoritativeMessageId === messageId) return state;
      if (
        current.authoritativeMessageId != null ||
        messages.some(
          (message, messageIndex) =>
            messageIndex !== index && message.authoritativeMessageId === messageId
        )
      ) {
        return state;
      }
      const next = [...messages];
      next[index] = { ...current, authoritativeMessageId: messageId };
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),
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

/** Id prefix of a pending row awaiting delivery (decision 093); still a `pending-user:` row. */
const AWAITING_DELIVERY_PREFIX = 'pending-user:steer:';

/** Render-only ChatMessage shape consumed by the existing turn pipeline. */
export function pendingUserToChatMessage(pending: PendingUserMessage): ChatMessage {
  const id = pending.awaitingDelivery
    ? `${AWAITING_DELIVERY_PREFIX}${pending.attemptId}`
    : `pending-user:${pending.attemptId}`;
  return {
    id,
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

/** A pending row the running turn has not taken in yet (decision 093). */
export function isAwaitingDeliveryMessage(message: ChatMessage): boolean {
  return message.id.startsWith(AWAITING_DELIVERY_PREFIX);
}
