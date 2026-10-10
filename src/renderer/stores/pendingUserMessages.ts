import { create } from 'zustand';
import type { AttachmentDraft } from '@/components/chat/attachments';
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
   * awaiting delivery rather than sending; retired by the same echo. It opens
   * no turn while it waits (`mergePendingUserRows`, decision 172).
   */
  awaitingDelivery?: true;
  /**
   * GitHub issue #8 (decision 172 §4): the composer drafts an awaiting
   * message carried, bytes and all, so a withdrawal can hand them back to the
   * message box. Never set on a send's row.
   */
  drafts?: readonly AttachmentDraft[];
  /**
   * Where a withdrawal of an awaiting message stands: `pending` while the
   * engine is asked; `delivered` when a turn took it in first (its echo
   * retires the row); `unavailable` when the engine connection it was handed
   * to is gone, so nothing can name it any more. Absent: it can be withdrawn.
   */
  withdrawal?: InterjectionWithdrawal;
}

export type InterjectionWithdrawal = 'pending' | 'delivered' | 'unavailable';

interface PendingUserMessagesStore {
  bySession: Record<string, PendingUserMessage[]>;
  publish: (message: PendingUserMessage) => void;
  /** Pair one renderer attempt with its exact authoritative Pi user echo. */
  acknowledgeAttempt: (sessionId: string, attemptId: string, messageId: string) => void;
  clear: (attemptId: string) => void;
  /** Issue #8: move an awaiting row's withdrawal on; `null` makes it withdrawable again. */
  setWithdrawal: (attemptId: string, withdrawal: InterjectionWithdrawal | null) => void;
  /**
   * Issue #8: the session's engine connection went away (`disconnected`), and
   * with it the table that names its awaiting messages: none of them can be
   * withdrawn from here on.
   */
  markWithdrawalsUnavailable: (sessionId: string) => void;
  pruneSessions: (sessionIds: readonly string[]) => void;
}

/** An awaiting row a withdrawal could still reach, or one being withdrawn now. */
function stillWithdrawable(message: PendingUserMessage): boolean {
  return (
    message.awaitingDelivery === true &&
    (message.withdrawal === undefined || message.withdrawal === 'pending')
  );
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
  setWithdrawal: (attemptId, withdrawal) =>
    set((state) => {
      for (const [sessionId, messages] of Object.entries(state.bySession)) {
        const index = messages.findIndex((message) => message.attemptId === attemptId);
        const current = messages[index];
        if (!current) continue;
        if (!current.awaitingDelivery || (current.withdrawal ?? null) === withdrawal) return state;
        const { withdrawal: _previous, ...rest } = current;
        const next = [...messages];
        next[index] = withdrawal === null ? rest : { ...rest, withdrawal };
        return { bySession: { ...state.bySession, [sessionId]: next } };
      }
      return state;
    }),
  markWithdrawalsUnavailable: (sessionId) =>
    set((state) => {
      const messages = state.bySession[sessionId];
      if (!messages?.some(stillWithdrawable)) return state;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: messages.map((message) =>
            stillWithdrawable(message)
              ? { ...message, withdrawal: 'unavailable' as const }
              : message
          ),
        },
      };
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

/** Issue #8: the attempt an awaiting row draws, or `null` for any other row. */
export function awaitingDeliveryAttemptId(message: ChatMessage): string | null {
  return isAwaitingDeliveryMessage(message)
    ? message.id.slice(AWAITING_DELIVERY_PREFIX.length)
    : null;
}

const NO_ROWS: readonly ChatMessage[] = [];

/**
 * The timeline's rows: a session's messages plus its pending ones that have
 * not reached the store yet. A pending row stays until the exact message its
 * echo named is in the store (`authoritativeMessageId`).
 *
 * `rows` is what turns are cut from, and a pending send is one of them: the
 * turn it opens is the turn its echo will open. `awaitingDelivery` is not
 * (GitHub issue #8, dsh-rebase decision 172). DSH takes a Ctrl+Enter message
 * in at the running turn's next step boundary, after the step that is running
 * now has finished, and the echo opens the turn where it lands. Cut at the
 * bubble, the running turn stopped being the last one the moment Ctrl+Enter
 * was pressed, and read as finished — folded under "Worked", its clocks stopped —
 * while its last call or thought was still running.
 */
export function mergePendingUserRows(
  authoritative: readonly ChatMessage[],
  pending: readonly PendingUserMessage[]
): { rows: readonly ChatMessage[]; awaitingDelivery: readonly ChatMessage[] } {
  if (pending.length === 0) return { rows: authoritative, awaitingDelivery: NO_ROWS };
  const authoritativeIds = new Set(authoritative.map((message) => message.id));
  const sends: ChatMessage[] = [];
  const awaitingDelivery: ChatMessage[] = [];
  for (const item of pending) {
    if (item.authoritativeMessageId != null && authoritativeIds.has(item.authoritativeMessageId)) {
      continue;
    }
    (item.awaitingDelivery ? awaitingDelivery : sends).push(pendingUserToChatMessage(item));
  }
  return {
    rows: sends.length > 0 ? [...authoritative, ...sends] : authoritative,
    awaitingDelivery: awaitingDelivery.length > 0 ? awaitingDelivery : NO_ROWS,
  };
}
