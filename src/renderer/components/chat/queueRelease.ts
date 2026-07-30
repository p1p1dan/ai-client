/**
 * T-19 message queue — pure RUNTIME-STATE judgment layer.
 *
 * `messageQueue.ts` owns the queue's data; this module owns everything that
 * asks "given the current runtime state, what should happen right now" — can
 * a new turn start, should the queue's head release, what do the send/stop/
 * enqueue/retry buttons look like, what does the strip render. No class
 * strings (that is `middleColumnLayout.ts`'s job) and no store import (this
 * stays a pure function library; `useQueueRelease.ts` is the only place that
 * is allowed to read/write the stores).
 *
 * `canStartTurn` is the single source of truth shared by `decideSendAction`
 * and `decideQueueRelease`, and its input fields correspond 1:1 to
 * `runSend`'s own guard (`ChatComposer.tsx:379-383`) — see the consistency
 * assertion in the test file. That correspondence is what makes "the release
 * judgment says go, but runSend silently returns" structurally impossible.
 *
 * §12 verification first: __tests__/queueRelease.test.ts.
 */
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import type { QueuedMessage, QueuePauseReason } from './messageQueue';

// ---- shared predicate ----

export interface CanStartTurnInput {
  /** sessionId AND cwd are both resolved (`resolveActiveTarget().cwd != null`). */
  hasTarget: boolean;
  disabled: boolean;
  /** `isStoppable(session.status)` — the four Host-side "a turn is running" statuses. */
  busy: boolean;
  /** The Composer's own pre-first-token latch (`sendAndWait`'s `sending` state). */
  sending: boolean;
  /** `inFlightRef.current` — the synchronous latch `runSend` sets before its first `await`. */
  inFlight: boolean;
}

/** Mirrors `runSend`'s combined guard exactly: `!canSend || inFlightRef.current`. */
export function canStartTurn(input: CanStartTurnInput): boolean {
  return input.hasTarget && !input.disabled && !input.busy && !input.sending && !input.inFlight;
}

// ---- decideSendAction (Enter semantics, decision 2.3) ----

export type SendAction = 'blocked' | 'enqueue' | 'send';

export interface DecideSendActionInput extends CanStartTurnInput {
  /** Trimmed text non-empty OR at least one attachment draft present. */
  hasContent: boolean;
  /** Attachments still being read/encoded — `useComposerAttachments().reading`. */
  reading: number;
}

/**
 * What pressing Enter (or clicking Send) should do. Short-circuit order is
 * priority order (decision 2.3): a missing target/content/still-reading state
 * always blocks, even while a turn happens to also be running.
 */
export function decideSendAction(input: DecideSendActionInput): SendAction {
  if (!input.hasTarget || input.disabled) return 'blocked';
  if (!input.hasContent) return 'blocked';
  if (input.reading > 0) return 'blocked';
  if (input.busy || input.sending || input.inFlight) return 'enqueue';
  return 'send';
}

// ---- decideQueueRelease (decision 3.2) ----

export type QueueReleaseHoldReason =
  | 'no-session'
  | 'empty'
  | 'paused'
  | 'head-failed'
  | 'no-target'
  | 'in-flight'
  | 'not-idle';

export type QueueReleaseDecision =
  | { type: 'hold'; reason: QueueReleaseHoldReason }
  | { type: 'release'; entryId: string };

export interface DecideQueueReleaseInput {
  sessionId: string | null;
  entries: readonly Pick<QueuedMessage, 'id' | 'failure'>[];
  paused: QueuePauseReason | null;
  hasTarget: boolean;
  disabled: boolean;
  sending: boolean;
  inFlight: boolean;
  status: SessionRuntimeStatus;
}

/**
 * Whether the active session's queue head may be released right now, and
 * which entry. Short-circuit order is priority order — each hold has a named,
 * assertable reason (decision 3.2 table, plus the dormant `head-failed`
 * check below).
 * `idle`/`completed` are the only two releasing statuses; the other seven all
 * hold as `not-idle`, including `failed` and `disconnected` (retry/reconnect
 * only, never auto-release — decision 3.2's "退避" rule).
 *
 * `head-failed`: DORMANT in the current wiring — the T-19 fix review (R5)
 * reverted batch 3's "released entry's turn fails, requeue at the head with
 * `failure` set" (it let a swap-edit clear `failure` and auto-release a
 * half-typed draft — blocker). No production code path writes `.failure`
 * onto a live queue entry anymore; Retry is a component-local snapshot
 * instead (`ChatComposer`'s `retryable`). This check — and the `failure`
 * field it reads (`messageQueue.ts`) — are kept as a sleeping defense for a
 * future T-19b that re-introduces queue-based failure tracking: if ANY entry
 * anywhere in the queue carries `failure` (not just the head — a prior
 * "only check index 0" version of this let a second failed entry release
 * right past an unresolved first one), the whole queue holds until an
 * explicit user action (Retry/Discard) clears it. Deliberately independent
 * of `status`: a stalled SDK stream can end a turn without ever moving the
 * session to `'failed'` (it can settle back on `'idle'`), so relying on
 * `status !== 'idle'` alone would silently auto-resend the same failure in a
 * tight loop the moment that happens. Checked before `no-target`/`in-flight`/
 * `not-idle` on purpose: none of those transient conditions should ever cause
 * a failed entry to fire again — only an explicit user action can.
 */
export function decideQueueRelease(input: DecideQueueReleaseInput): QueueReleaseDecision {
  if (input.sessionId == null) return { type: 'hold', reason: 'no-session' };
  if (input.entries.length === 0) return { type: 'hold', reason: 'empty' };
  if (input.paused != null) return { type: 'hold', reason: 'paused' };
  if (input.entries.some((entry) => entry.failure != null)) {
    return { type: 'hold', reason: 'head-failed' };
  }
  if (!input.hasTarget || input.disabled) return { type: 'hold', reason: 'no-target' };
  if (input.sending || input.inFlight) return { type: 'hold', reason: 'in-flight' };
  if (input.status !== 'idle' && input.status !== 'completed') {
    return { type: 'hold', reason: 'not-idle' };
  }
  return { type: 'release', entryId: input.entries[0].id };
}

// ---- decideRunEntryOutcome (T-19/round-2 P0 hardening) ----

/**
 * What `runSend`/`useQueueRelease` report for one turn attempt.
 * `'committed'`: the Host admitted the turn (it may still go on to fail
 * mid-stream) — never requeue, the entry has already been spent.
 * `'skipped'`: a pre-commit guard failed before anything was sent — requeue.
 * `'rejected'`: the Host flatly refused to admit the turn (e.g. `session_busy`
 * fired before `normalizer.beginTurn`, so nothing was echoed and no turn
 * started) — requeue, exactly like `'skipped'`.
 */
export type RunEntryOutcome = 'committed' | 'skipped' | 'rejected';

export interface DecideRunEntryOutcomeInput {
  /** A fatal `host.error` landed for this send attempt. */
  fatalHostError: boolean;
  /** Any assistant/tool/permission/terminal progress observed on the wire. */
  sawAssistantProgress: boolean;
  /**
   * F4 (round-2 review fix): `message.started{role:'user'}` observed for
   * THIS session — only `EventNormalizer.beginTurn` (called from inside
   * `claudeRuntime.send`, past the `session.running` admission gate) ever
   * emits this. This is the only admission evidence — see below for why
   * `session.created`/`session.resumed` used to (wrongly) count too.
   */
  sawUserEcho: boolean;
}

/**
 * Classifies a post-commit `runSend` failure as `'committed'` (the Host DID
 * start the turn — a duplicate resend would be wrong) or `'rejected'` (the
 * Host never accepted it — safe, and necessary, to put back on the queue).
 * Pure so the queue-loss root cause (every post-commit failure used to report
 * `'committed'` unconditionally) is assertable without a live Host.
 *
 * F4 (round-2 review fix, M4/B1 queue-loss finding): `sawSessionCreated`/
 * `sawSessionResumed` used to also count as admission evidence — wrong,
 * because create/resume happen entirely BEFORE `claudeRuntime.send`'s own
 * `session.running` busy-gate and `normalizer.beginTurn`. A `session_busy`
 * fatal error landing right after a successful create/resume handshake (the
 * realistic path: 8 bounded busy retries all failing with zero echo) was
 * being reported `'committed'`, silently dropping the queued message — the
 * exact bug class this whole batch exists to fix. The only two signals that
 * actually prove the Host admitted this turn's TEXT are the user echo
 * (`sawUserEcho`) and any subsequent assistant/tool/terminal progress.
 */
export function decideRunEntryOutcome(input: DecideRunEntryOutcomeInput): RunEntryOutcome {
  if (!input.fatalHostError) return 'committed';
  if (input.sawAssistantProgress || input.sawUserEcho) {
    return 'committed';
  }
  return 'rejected';
}

// ---- runSend origin ownership (R1/R2, round-2 iteration-2 review) ----

/**
 * Which of `runSend`'s three call sites started this attempt — a live Send
 * click, the round Retry button, or the queue's own release effect. The
 * ONLY thing this changes is who owns recovering a `'rejected'` outcome:
 * `'release'` has a queue entry to fall back on (`useQueueRelease.ts`
 * restores it to the head); `'direct'`/`'retry'` do not, so THEY must arm
 * the round Retry affordance themselves or the user's text/attachments are
 * gone with no way back.
 */
export type RunSendOrigin = 'direct' | 'retry' | 'release';

/**
 * R1: whether a `runSend` attempt's outcome should arm the round Retry
 * button (`ChatComposer`'s local `retryable` state). `'rejected'` +
 * `origin: 'release'` is the ONLY combination that must NOT — the queue
 * itself is the recovery path there, and arming Retry too would let two
 * independent, unaware-of-each-other live-send paths (queue auto-release
 * AND a user click) send the identical text twice. Every other combination
 * — any `'committed'` failure (regardless of origin — the entry, if any,
 * has already been spent), or `'rejected'` from a direct send / Retry click
 * (no queue entry exists to fall back on) — must arm it.
 */
export function shouldArmRetryable(outcome: RunEntryOutcome, origin: RunSendOrigin): boolean {
  return !(outcome === 'rejected' && origin === 'release');
}

/**
 * S1 (round-2 iteration-3 review): whether a `'rejected'` outcome from the
 * release path must pause the queue. Generalized from the round-2 version
 * (which only fired for `session_busy` retry exhaustion): EVERY evidence-free
 * release-origin rejection — a create timeout, a resume→create fallback
 * timeout, an `ensureHost()` rejection (the "Node 24 missing" catch path), a
 * non-busy pre-admission `host.error` (`not_implemented`, a post-fallback
 * `session_not_found`), or a `session.failed` landing mid busy-retry loop —
 * produces the IDENTICAL restore-then-re-release shape in
 * `useQueueRelease.ts`: the entry goes back on the queue and
 * `decideQueueRelease` has nothing (no pause, no counter) stopping it from
 * releasing the SAME entry again on the very next render — sometimes with no
 * delay at all (an `ensureHost()` rejection fires before any `sleep`).
 * Scoping the round-2 pause to one fatal-error code left every OTHER
 * handshake-failure class free to spin that loop.
 *
 * `origin` alone is sufficient, with no error-code narrowing: exactly
 * `!shouldArmRetryable(outcome, origin)` — the queue pause and the round
 * Retry armament are two mutually exclusive, jointly exhaustive recovery
 * paths for the same non-success outcome, never both, never neither.
 * `'direct'`/`'retry'` have no queue entry to loop against (nothing for
 * `useQueueRelease` to restore), so only `'release'` can ever produce the
 * loop this closes.
 */
export function shouldPauseQueueOnRejection(
  outcome: RunEntryOutcome,
  origin: RunSendOrigin
): boolean {
  return !shouldArmRetryable(outcome, origin);
}

// ---- decidePendingResolution (decision 4) ----

export interface DecidePendingResolutionInput {
  status: SessionRuntimeStatus;
  /** `pendingQuestion?.sessionId === activeSessionId` — already scoped to "this session". */
  hasPendingQuestionHere: boolean;
  /** Same scoping for the permission queue. */
  hasPendingPermissionHere: boolean;
}

export interface PendingResolution {
  /** Fire-and-forget `respondQuestion({cancel:true})` — cancel is `allow` + empty answers, never a real rejection (decision 4). */
  cancelQuestion: boolean;
}

/**
 * What sending should do about a pending question/permission on THIS session
 * (decision 4's asymmetry): a pending question is auto-cancelled (non-
 * destructive on the SDK side) so the queue is never deadlocked on an answer
 * the user chose not to give; a pending permission is never auto-answered
 * (deny is a real, destructive rejection) — the strip's hint for that case
 * comes straight from `deriveQueueStripModel`'s `hasPendingPermissionHere`
 * input below, not from a field here (m3 fix: this used to also return a
 * `hint` field that no caller ever read — two parallel derivations of the
 * same one-bit fact is exactly what "single source of truth" is supposed to
 * prevent).
 */
export function decidePendingResolution(input: DecidePendingResolutionInput): PendingResolution {
  return { cancelQuestion: input.hasPendingQuestionHere };
}

// ---- deriveActionButtons (decision 2.5) ----

export type ActionButtonKind = 'send' | 'retry' | 'stop' | 'enqueue';

export interface ActionButtonSpec {
  kind: ActionButtonKind;
  disabled: boolean;
}

/**
 * Statuses `runSend`'s `sending`/Stop affordance treats as "a turn is
 * running" — exported so `ChatComposer.tsx`'s `isStoppable` can import this
 * directly instead of hand-copying the list (M6 fix: a hand-copy is exactly
 * the "must be kept in sync by inspection" risk the T-19 fix review flagged).
 * Encodes the same Host contract as `runSend`'s own `busy` derivation:
 * `starting`/`running`/`waiting_permission`/`waiting_question` — NOT
 * `stopping` (an existing, separately-tracked gap, out of this batch's scope).
 */
export function isRunningStatus(status: SessionRuntimeStatus): boolean {
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'waiting_permission' ||
    status === 'waiting_question'
  );
}

export interface DeriveActionButtonsInput {
  status: SessionRuntimeStatus;
  /** The Composer's pre-first-token latch — also makes Stop available (`canStop = busy || sending`). */
  sending: boolean;
  /** Last turn on this session ended in failure (explicit `failed` or the Composer's fallback `retryable`). */
  hasFailed: boolean;
  /** Trimmed text non-empty OR at least one attachment draft present. */
  hasDraftContent: boolean;
}

/**
 * Right-to-left round button stack (decision 2.5). Retry and Stop are
 * mutually exclusive by construction here — `canRetry` in `ChatComposer.tsx`
 * already requires `!busy && !sending`, so the two can never occupy the same
 * render, which the test file asserts as a property over all nine statuses.
 */
export function deriveActionButtons(input: DeriveActionButtonsInput): readonly ActionButtonSpec[] {
  const canStop = isRunningStatus(input.status) || input.sending;
  if (canStop) {
    return [
      { kind: 'stop', disabled: false },
      { kind: 'enqueue', disabled: !input.hasDraftContent },
    ];
  }
  if (input.hasFailed) {
    return [
      { kind: 'retry', disabled: false },
      { kind: 'send', disabled: false },
    ];
  }
  return [{ kind: 'send', disabled: false }];
}

// ---- deriveQueueStripModel (decision 5) ----

export const QUEUE_PERMISSION_HINT =
  'Waiting for your approval — queued messages send after you respond.';

export interface QueueStripEntryModel {
  id: string;
  /** 1-based display index ("1", "2", …). */
  index: number;
  preview: string;
  attachmentCount: number;
  failed: boolean;
  failureMessage?: string;
}

export interface QueueStripModel {
  /** False collapses the whole strip — an empty queue renders nothing (decision 5.1). */
  visible: boolean;
  entries: readonly QueueStripEntryModel[];
  pausedLabel: string | null;
  permissionHint: string | null;
}

export interface DeriveQueueStripModelInput {
  entries: readonly QueuedMessage[];
  paused: QueuePauseReason | null;
  hasPendingPermissionHere: boolean;
}

/**
 * S2 (round-2 iteration-3 review): the paused caption, distinguishing an
 * AUTO pause (`'send-rejected'` — the Host is not accepting this turn, or
 * the send failed before admission) from a user-initiated Stop (`'stopped'`)
 * — short and factual, so the user knows whether Resume is "continue where
 * you left off" or "try again, the Host may still be refusing it". Resume
 * itself is unchanged either way (`handleQueueResume`/`clearPause`).
 */
function pausedLabelFor(reason: QueuePauseReason, waitingCount: number): string {
  return reason === 'send-rejected'
    ? `Queue paused — Host isn't accepting this turn (${waitingCount} waiting)`
    : `Queue paused — ${waitingCount} waiting`;
}

/** Pure view model for `QueuedMessageStrip.tsx` (batch 3) — the component renders this and decides nothing itself. */
export function deriveQueueStripModel(input: DeriveQueueStripModelInput): QueueStripModel {
  if (input.entries.length === 0) {
    return { visible: false, entries: [], pausedLabel: null, permissionHint: null };
  }
  return {
    visible: true,
    entries: input.entries.map((entry, index) => ({
      id: entry.id,
      index: index + 1,
      preview: entry.text,
      attachmentCount: entry.attachments.length,
      failed: entry.failure != null,
      ...(entry.failure ? { failureMessage: entry.failure.message } : {}),
    })),
    pausedLabel: input.paused != null ? pausedLabelFor(input.paused, input.entries.length) : null,
    permissionHint: input.hasPendingPermissionHere ? QUEUE_PERMISSION_HINT : null,
  };
}
