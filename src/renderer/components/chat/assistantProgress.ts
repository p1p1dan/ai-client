import { HISTORY_MESSAGE_ID_PREFIX } from '@shared/types/sessionHistory';

export interface ProgressEvent {
  type: string;
  sessionId?: string;
  payload?: unknown;
}

export type AssistantProgressSignal = 'assistant' | 'ignore';

function readStringField(payload: unknown, field: string): string {
  if (payload && typeof payload === 'object' && field in payload) {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * F3 (round-2 review fix): whether a `host.error` event belongs to THIS send
 * attempt. Without this, `runSend`'s runtime listener accepted every
 * `host.error` regardless of session — a background session hitting
 * `session_busy` (e.g. resuming a session the user just switched to) could
 * poison an unrelated, in-flight send's `fatalHostError`, which its bounded
 * busy-retry loop then acted on, or its `decideRunEntryOutcome` classified
 * as a rejection for a turn that was never actually rejected.
 *
 * `sessionId` match wins whenever the event carries one. A SESSION-LESS
 * event (only `claudeRuntime.send`'s `session_not_found` — deliberately
 * emitted before the Host even knows which session, see claudeRuntime.ts) is
 * only accepted when its `requestId` matches the request that is currently
 * outstanding for this attempt — never accepted by guesswork.
 */
export interface HostErrorMatchTarget {
  sessionId: string;
  /** requestId of the IPC call THIS attempt is currently waiting on, if known. */
  requestId: string | null;
}

export function isHostErrorForSend(
  event: { sessionId?: string; requestId?: string },
  target: HostErrorMatchTarget
): boolean {
  if (event.sessionId != null) return event.sessionId === target.sessionId;
  return target.requestId != null && event.requestId === target.requestId;
}

/**
 * R15 (round-2 iteration-2 review, queue verifier finding): whether a
 * `message.started` event is THIS session's user echo — the only admission
 * evidence `decideRunEntryOutcome` trusts (see queueRelease.ts's header).
 * Pulled out of the inline listener in `ChatComposer.tsx` into a pure
 * function so the wiring itself (not just the classification it feeds) is
 * unit-testable — a `.tsx`-only path with zero assertions is not acceptable
 * for this semantics.
 */
export function isUserEchoForSend(event: ProgressEvent, sessionId: string): boolean {
  if (event.sessionId !== sessionId) return false;
  if (event.type !== 'message.started') return false;
  return readStringField(event.payload, 'role') === 'user';
}

/**
 * R3 (round-2 iteration-2 review): whether a `session.failed` event is a
 * fatal-error signal for THIS send attempt. Scoped by `sessionId` only — a
 * `session.failed` event always carries one (unlike `host.error`'s
 * session-less `session_not_found` case handled by `isHostErrorForSend`
 * above), so no `requestId` fallback is needed. Extracted so
 * `sendAndWait`/`waitUntil`'s post-wait classification can stop reading the
 * process-global `useChatSessionsStore.lastError` as a termination signal —
 * `chatSessions.ts`'s `session.failed` case sets that field for ANY
 * session, so a background session's failure could previously short-circuit
 * an unrelated in-flight send.
 */
export function isSessionFailedForSend(event: ProgressEvent, sessionId: string): boolean {
  return event.type === 'session.failed' && event.sessionId === sessionId;
}

/** Best-effort human-readable message off a `session.failed` payload. */
export function readSessionFailedError(payload: unknown): string {
  return readStringField(payload, 'error') || 'Session failed';
}

/**
 * S4 (round-2 iteration-3 review): whether a `session.completed` event is a
 * genuine terminal-completion signal for THIS session. `chatSessions.ts`
 * collapses both `session.completed` and `session.stopped` to the SAME
 * `'idle'` status, so nothing derived from store state alone can tell a real
 * completion apart from a user Stop — this reads the raw wire event
 * directly, mirroring `isSessionFailedForSend`'s scoping.
 */
export function isSessionCompletedForSend(event: ProgressEvent, sessionId: string): boolean {
  return event.type === 'session.completed' && event.sessionId === sessionId;
}

/** Minimal shape `countAssistantMessagesWithBlocks` needs — matches `ChatMessage` structurally without importing it (this module stays decoupled from `chatSessions.ts`). */
export interface AssistantMessageLike {
  id: string;
  role: string;
  blocks: readonly unknown[];
}

/**
 * S4 (round-2 iteration-3 review): count of assistant messages that carry at
 * least one block — the monotonic cursor `ChatComposer`'s abandon-marker
 * effect compares against. A resumed session's REPLAYED history already
 * satisfies "an assistant message with blocks exists"; recording this count
 * at marker-arm time and requiring it to advance (not just be non-zero) is
 * what stops the effect from firing on pre-existing history it never
 * produced.
 *
 * Iteration-4 fix: a session.history hydration (e.g. after a HistoryErrorNotice
 * Retry) prepends the ENTIRE replayed transcript as `h:`-prefixed messages
 * while keeping the runtime ones (`chatSessions.ts`'s own history-reducer),
 * so counting them a second time here would advance the cursor on hydration
 * alone — the exact "replayed history trips it" class this cursor exists to
 * close. Excluded via the store's own idiom for "not a replayed history
 * message" (`chatSessions.ts`'s `!id.startsWith(HISTORY_MESSAGE_ID_PREFIX)`).
 */
export function countAssistantMessagesWithBlocks(
  messages: readonly AssistantMessageLike[]
): number {
  return messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.blocks.length > 0 &&
      !message.id.startsWith(HISTORY_MESSAGE_ID_PREFIX)
  ).length;
}

export function classifyAssistantProgress(
  event: ProgressEvent,
  assistantMessageIds: Set<string>
): AssistantProgressSignal {
  switch (event.type) {
    case 'message.started': {
      const role = readStringField(event.payload, 'role');
      const messageId = readStringField(event.payload, 'messageId');
      if (role === 'assistant' && messageId) {
        assistantMessageIds.add(messageId);
        return 'assistant';
      }
      return 'ignore';
    }
    case 'message.delta':
    case 'message.completed': {
      const messageId = readStringField(event.payload, 'messageId');
      if (messageId && assistantMessageIds.has(messageId)) {
        return 'assistant';
      }
      return 'ignore';
    }
    case 'thinking.started':
    case 'thinking.delta':
    case 'thinking.completed':
    case 'tool.started':
    case 'tool.updated':
    case 'tool.completed':
    case 'permission.requested':
    case 'question.requested':
      return 'assistant';
    default:
      return 'ignore';
  }
}
