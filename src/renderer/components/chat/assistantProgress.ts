import { HISTORY_MESSAGE_ID_PREFIX } from '@shared/types/sessionHistory';

export interface ProgressEvent {
  type: string;
  sessionId?: string;
  payload?: unknown;
}

export type AssistantProgressSignal = 'assistant' | 'ignore';

export type TurnLivenessSignal = 'liveness' | 'ignore';

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

/**
 * A3 (round-4 point-check fix, retry-doublesend diagnosis): `strict` closes
 * a cross-request hole the plain `sessionId`-only match left open. Without
 * it, a `host.error` for THIS session but a DIFFERENT, no-longer-current
 * request (e.g. a background `session_busy` from the user resuming this
 * same session from the left nav while THIS attempt's own busy-backoff loop
 * is still running) could poison `fatalHostErrorCode` after the real turn
 * had already been admitted, re-triggering a resend. `strict` requires the
 * event's `requestId` to match `target.requestId` too, but only once
 * `target.requestId` is actually known (falls back to the existing
 * sessionId-only match while an attempt has no outstanding request yet —
 * same "don't guess" posture the session-less branch below already takes).
 * Defaults to off so every existing non-strict call site is unaffected.
 */
export function isHostErrorForSend(
  event: { sessionId?: string; requestId?: string },
  target: HostErrorMatchTarget,
  options?: { strict?: boolean }
): boolean {
  if (event.sessionId != null) {
    if (event.sessionId !== target.sessionId) return false;
    if (options?.strict && target.requestId != null) {
      return event.requestId === target.requestId;
    }
    return true;
  }
  return target.requestId != null && event.requestId === target.requestId;
}

/**
 * F2 (round-4 Codex NEEDS-FIX #1): whether a STASHED `host.error` (one that
 * arrived while THIS attempt's own `requestId` was still unknown — the
 * narrow window between an IPC call firing and its `requestId` resolving,
 * e.g. `chat.send()`'s own immediate failure racing the promise that
 * reports its `requestId` back) should now be admitted, now that a
 * `requestId` IS known. Strict mode's `target.requestId == null` fallback
 * (see `isHostErrorForSend` above) used to accept such an event on sessionId
 * alone the INSTANT it arrived — reopening the exact cross-request hole
 * `strict` exists to close. The fix is to cache it instead and re-evaluate
 * HERE the moment a `requestId` becomes known, so the decision is always
 * made with full information: `target.requestId` must be known AND the
 * stashed event must strictly match it.
 */
export function shouldAdmitPendingHostError(
  pending: { sessionId?: string; requestId?: string },
  target: HostErrorMatchTarget
): boolean {
  return target.requestId != null && isHostErrorForSend(pending, target, { strict: true });
}

/**
 * F2b (round-4 Codex re-review, second pass): bounded FIFO admission into
 * the pending-host-error candidate LIST — oldest evicted first once the cap
 * is exceeded. Replaces the original single-slot stash: `currentRequestId`
 * being reset to `null` before EVERY new create/resume/send dispatch (the
 * F2b fix in `ChatComposer.tsx`) means more than one session-scoped
 * host.error can legitimately land during that null window in the SAME
 * `runSend` call — a genuine fast failure for the JUST-dispatched request,
 * and/or a late straggler from an EARLIER request still winding down — and
 * a single slot let the second one silently evict the first with no
 * re-evaluation, permanently losing whichever one didn't happen to be last.
 * Pure so the eviction rule itself is assertable without a live listener.
 */
export const MAX_PENDING_HOST_ERRORS = 4;

export function pushPendingHostError<E>(pending: readonly E[], event: E): readonly E[] {
  const next = [...pending, event];
  return next.length > MAX_PENDING_HOST_ERRORS
    ? next.slice(next.length - MAX_PENDING_HOST_ERRORS)
    : next;
}

/**
 * F2b (round-4 Codex re-review, second pass): given the bounded candidate
 * list stashed while `target.requestId` was unknown, finds the one (if any)
 * that now strictly matches the just-resolved target — `null` if none do
 * (every candidate was for some OTHER, already-superseded request, or a
 * different session entirely). The whole list is meant to be discarded by
 * the caller after this call, matched or not: once a target requestId is
 * known, every candidate has had its one chance to be evaluated against it.
 */
export function resolvePendingHostError<E extends { sessionId?: string; requestId?: string }>(
  pending: readonly E[],
  target: HostErrorMatchTarget
): E | null {
  return pending.find((candidate) => shouldAdmitPendingHostError(candidate, target)) ?? null;
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

/**
 * Stop-hang fix (2026-08-10): the mirror of `isSessionCompletedForSend` for a
 * user Stop. Same reason it has to read the raw wire event — `chatSessions.ts`
 * collapses `session.stopped` into the same `'idle'` status a real completion
 * produces, so nothing derived from the store can tell the two apart.
 *
 * `runSend`'s wait predicate had no member of its release set that a stopped
 * turn ever satisfies (no assistant progress, no `failed`/`waiting_*` status,
 * no new assistant message), so pressing Stop left it polling every 50ms until
 * the 45s abandon budget expired — the "Stop does nothing" report. This is the
 * signal that ends that wait honestly, in the same tick the Host reports it.
 */
export function isSessionStoppedForSend(event: ProgressEvent, sessionId: string): boolean {
  return event.type === 'session.stopped' && event.sessionId === sessionId;
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
  return messages.filter(isRuntimeAssistantWithBlocks).length;
}

function isRuntimeAssistantWithBlocks(message: AssistantMessageLike): boolean {
  return (
    message.role === 'assistant' &&
    message.blocks.length > 0 &&
    !message.id.startsWith(HISTORY_MESSAGE_ID_PREFIX)
  );
}

/**
 * Send-time baseline for `hasNewAssistantMessage` (round-6 verify major):
 * `sendAndWait`'s store fallback used an absolute "any runtime assistant
 * exists" check, which the PREVIOUS turn's reply satisfies the instant a
 * second send starts — the wait released with zero evidence from this send,
 * unsubscribed its listeners, and a late failure could no longer restore
 * the payload. Only an assistant id that was not present at dispatch time
 * counts as this send's progress.
 */
export function collectAssistantMessageIds(messages: readonly AssistantMessageLike[]): Set<string> {
  return new Set(messages.filter(isRuntimeAssistantWithBlocks).map((message) => message.id));
}

export function hasNewAssistantMessage(
  messages: readonly AssistantMessageLike[],
  baselineIds: ReadonlySet<string>
): boolean {
  return messages.some(
    (message) => isRuntimeAssistantWithBlocks(message) && !baselineIds.has(message.id)
  );
}

/**
 * One step of the abandon-marker state machine (round-6 B2), pure so the
 * mutable-marker effect in ChatComposer stays testable:
 *
 * - The replay-coverage merge can FOLD runtime assistant messages into their
 *   `h:*` copies, shrinking the cursor below the armed baseline — without
 *   the downward re-baseline, `count > armed` stays false forever and the
 *   stale banner + Retry never clear.
 * - A replay can only shrink or hold the runtime count (`h:*` rows are
 *   excluded from it), so hydration alone never sets `landed` — the
 *   iteration-4 "replayed history must not clear the marker" rule holds.
 * - One genuinely new runtime reply pushes the count past the re-based
 *   baseline and clears.
 */
export function resolveAbandonProgress(input: {
  armedCursor: number;
  currentCursor: number;
  waitingInteraction: boolean;
}): { nextArmedCursor: number; landed: boolean } {
  const nextArmedCursor = Math.min(input.armedCursor, input.currentCursor);
  return {
    nextArmedCursor,
    landed: input.currentCursor > nextArmedCursor || input.waitingInteraction,
  };
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

/**
 * F2 (2026-08-18): the renderer's liveness word list — the `transport` layer
 * of the three-layer contract (`productive` / `interactive` / `transport`)
 * that the Host and the renderer share as DOCUMENTATION, not as a runtime
 * module (the two axes' event vocabularies do not intersect at all).
 *
 * Membership rules, one line each:
 *  - message.* (ANY role): the Host is writing for THIS session. The user-echo
 *    trio is admission evidence, hence liveness — but deliberately NOT
 *    progress (see classifyAssistantProgress).
 *  - thinking.* / tool.* / permission.requested / question.requested: already
 *    progress, so containment forces them in.
 *  - permission.resolved / question.resolved: the user answered, the turn
 *    should continue; without these, "model thinks for a long time after an
 *    answer" reads as silence.
 *  - session.status (ANY status, including `retry` and the F2 `liveness`
 *    note): the Host process is alive and talking about this session. The
 *    retry case is the whole point — "the CLI is retrying" is not "wedged".
 *  - session.stderr: the CLI subprocess is alive and emitting.
 *  - usage.updated: interim token tick, the model is producing.
 *  - subagent.activity: a subagent is running while the main stream can stay
 *    legitimately quiet for a long time.
 *  - session.created / resumed / updated / settingsEcho / permissionUpdated:
 *    handshake and mid-turn setting frames, proof the Host is responding.
 *
 * Deliberately ABSENT: session.history / historyListed (replay, unrelated to
 * this turn), host.error (a verdict with its own channel, not liveness), and
 * the three terminals session.completed / failed / stopped (they END the wait
 * rather than extend it).
 */
const TURN_LIVENESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message.started',
  'message.delta',
  'message.completed',
  'thinking.started',
  'thinking.delta',
  'thinking.completed',
  'tool.started',
  'tool.updated',
  'tool.completed',
  'permission.requested',
  'permission.resolved',
  'question.requested',
  'question.resolved',
  'session.status',
  'session.stderr',
  'usage.updated',
  'subagent.activity',
  'session.created',
  'session.resumed',
  'session.updated',
  'session.settingsEcho',
  'session.permissionUpdated',
]);

/**
 * F2 (2026-08-18): "the Host is still talking ABOUT THIS SESSION" — strictly
 * WIDER than classifyAssistantProgress and deliberately a SEPARATE function.
 * Widening the progress union instead would invite `!== 'ignore'`, i.e. exactly
 * the "let message.delta count as progress" regression the triage forbids.
 * Consumers: the renderer's silence budget ONLY. Never an admission or a
 * Retry-arming signal.
 *
 * Session scope first: an event for another session — or with no session at
 * all (only `host.error`'s `session_not_found`) — is never this turn's
 * liveness.
 */
export function classifyTurnLiveness(event: ProgressEvent, sessionId: string): TurnLivenessSignal {
  if (event.sessionId !== sessionId) return 'ignore';
  return TURN_LIVENESS_EVENT_TYPES.has(event.type) ? 'liveness' : 'ignore';
}
