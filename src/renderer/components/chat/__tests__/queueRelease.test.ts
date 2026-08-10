import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { QueuedMessage } from '../messageQueue';
import {
  type ActionButtonKind,
  type CanStartTurnInput,
  canStartTurn,
  type DecideRunEntryOutcomeInput,
  type DecideSendActionInput,
  decideFailureAffordance,
  decidePendingResolution,
  decideQueueRelease,
  decideRunEntryOutcome,
  decideSendAction,
  deriveActionButtons,
  deriveQueueStripModel,
  type FailureAffordance,
  isRunningStatus,
  QUEUE_PERMISSION_HINT,
  type RunEntryOutcome,
  type RunSendOrigin,
  shouldArmRetryable,
  shouldClearPauseOnSend,
  shouldClearRetryableOnOutcome,
  shouldPauseQueueOnRejection,
  shouldRetryBusySend,
} from '../queueRelease';

const ALL_STATUSES: readonly SessionRuntimeStatus[] = [
  'idle',
  'starting',
  'running',
  'waiting_permission',
  'waiting_question',
  'stopping',
  'completed',
  'failed',
  'disconnected',
];

const RELEASING_STATUSES: readonly SessionRuntimeStatus[] = ['idle', 'completed'];

function baseCanStartTurn(overrides: Partial<CanStartTurnInput> = {}): CanStartTurnInput {
  return {
    hasTarget: true,
    disabled: false,
    busy: false,
    sending: false,
    inFlight: false,
    ...overrides,
  };
}

describe('canStartTurn', () => {
  it('is true when the target is resolved and nothing is running/in flight', () => {
    expect(canStartTurn(baseCanStartTurn())).toBe(true);
  });

  it('is false without a resolved target', () => {
    expect(canStartTurn(baseCanStartTurn({ hasTarget: false }))).toBe(false);
  });

  it('is false when explicitly disabled', () => {
    expect(canStartTurn(baseCanStartTurn({ disabled: true }))).toBe(false);
  });

  it('is false while the session is busy', () => {
    expect(canStartTurn(baseCanStartTurn({ busy: true }))).toBe(false);
  });

  it('is false while a send is pre-first-token (sending)', () => {
    expect(canStartTurn(baseCanStartTurn({ sending: true }))).toBe(false);
  });

  it('is false while the synchronous in-flight latch is closed', () => {
    expect(canStartTurn(baseCanStartTurn({ inFlight: true }))).toBe(false);
  });
});

function baseSendAction(overrides: Partial<DecideSendActionInput> = {}): DecideSendActionInput {
  return {
    hasTarget: true,
    disabled: false,
    busy: false,
    sending: false,
    inFlight: false,
    hasContent: true,
    reading: 0,
    ...overrides,
  };
}

describe('decideSendAction', () => {
  it('blocks when there is no resolved session target', () => {
    expect(decideSendAction(baseSendAction({ hasTarget: false }))).toBe('blocked');
  });

  it('blocks when explicitly disabled even with a target', () => {
    expect(decideSendAction(baseSendAction({ disabled: true }))).toBe('blocked');
  });

  it('blocks when there is no content (empty text, no attachments)', () => {
    expect(decideSendAction(baseSendAction({ hasContent: false }))).toBe('blocked');
  });

  it('blocks while an attachment is still being read/encoded', () => {
    expect(decideSendAction(baseSendAction({ reading: 1 }))).toBe('blocked');
  });

  it('enqueues while the session is busy', () => {
    expect(decideSendAction(baseSendAction({ busy: true }))).toBe('enqueue');
  });

  it('enqueues while a send is pre-first-token (sending)', () => {
    expect(decideSendAction(baseSendAction({ sending: true }))).toBe('enqueue');
  });

  it('enqueues while the synchronous in-flight latch is closed', () => {
    expect(decideSendAction(baseSendAction({ inFlight: true }))).toBe('enqueue');
  });

  it('sends directly when idle with a target and content', () => {
    expect(decideSendAction(baseSendAction())).toBe('send');
  });

  it('consistency: decideSendAction === "send" iff canStartTurn === true (content/reading fixed satisfied)', () => {
    const bools = [true, false];
    for (const hasTarget of bools) {
      for (const disabled of bools) {
        for (const busy of bools) {
          for (const sending of bools) {
            for (const inFlight of bools) {
              const shared = { hasTarget, disabled, busy, sending, inFlight };
              const action = decideSendAction({ ...shared, hasContent: true, reading: 0 });
              const canStart = canStartTurn(shared);
              expect(action === 'send').toBe(canStart);
            }
          }
        }
      }
    }
  });
});

function baseRelease(overrides: Partial<Parameters<typeof decideQueueRelease>[0]> = {}) {
  return {
    sessionId: 's1',
    entries: [{ id: 'q-1' }],
    paused: null,
    hasTarget: true,
    disabled: false,
    sending: false,
    inFlight: false,
    status: 'idle' as SessionRuntimeStatus,
    ...overrides,
  };
}

describe('decideQueueRelease', () => {
  it('holds no-session when there is no active session', () => {
    expect(decideQueueRelease(baseRelease({ sessionId: null }))).toEqual({
      type: 'hold',
      reason: 'no-session',
    });
  });

  it('holds empty when the queue has no entries', () => {
    expect(decideQueueRelease(baseRelease({ entries: [] }))).toEqual({
      type: 'hold',
      reason: 'empty',
    });
  });

  it('holds paused when the session queue is paused', () => {
    expect(decideQueueRelease(baseRelease({ paused: 'stopped' }))).toEqual({
      type: 'hold',
      reason: 'paused',
    });
  });

  it('holds head-failed when the head entry carries a failure, even though every other gate passes', () => {
    expect(
      decideQueueRelease(baseRelease({ entries: [{ id: 'q-1', failure: { message: 'boom' } }] }))
    ).toEqual({ type: 'hold', reason: 'head-failed' });
  });

  it('head-failed holds regardless of status, including idle (the stalled-stream edge case)', () => {
    for (const status of ALL_STATUSES) {
      expect(
        decideQueueRelease(
          baseRelease({ entries: [{ id: 'q-1', failure: { message: 'boom' } }], status })
        )
      ).toEqual({ type: 'hold', reason: 'head-failed' });
    }
  });

  // T-19 fix review (M1/m13): the pure `head-failed` check now scans the
  // WHOLE queue, not just index 0. This whole check is dormant in production
  // today (the T-19 fix review reverted the mechanism that ever wrote
  // `.failure` onto a live queue entry — see `queueRelease.ts`'s header), but
  // the OLD "only the head entry's failure matters" version of this test
  // locked in a behavior that would have been wrong the moment that
  // mechanism came back (or any future caller starts constructing entries
  // with `failure` directly): a non-head failure must still block release,
  // not be silently skipped over.
  it('holds when a failed entry sits anywhere in the queue, not just at the head', () => {
    expect(
      decideQueueRelease(
        baseRelease({
          entries: [{ id: 'q-1' }, { id: 'q-2', failure: { message: 'boom' } }],
        })
      )
    ).toEqual({ type: 'hold', reason: 'head-failed' });
  });

  it('holds when multiple entries are failed at once', () => {
    expect(
      decideQueueRelease(
        baseRelease({
          entries: [
            { id: 'q-1', failure: { message: 'first' } },
            { id: 'q-2', failure: { message: 'second' } },
          ],
        })
      )
    ).toEqual({ type: 'hold', reason: 'head-failed' });
  });

  it('holds no-target when the target is not resolved', () => {
    expect(decideQueueRelease(baseRelease({ hasTarget: false }))).toEqual({
      type: 'hold',
      reason: 'no-target',
    });
  });

  it('holds no-target when explicitly disabled', () => {
    expect(decideQueueRelease(baseRelease({ disabled: true }))).toEqual({
      type: 'hold',
      reason: 'no-target',
    });
  });

  it('holds in-flight while a send is pre-first-token (sending)', () => {
    expect(decideQueueRelease(baseRelease({ sending: true }))).toEqual({
      type: 'hold',
      reason: 'in-flight',
    });
  });

  it('holds in-flight while the synchronous in-flight latch is closed', () => {
    expect(decideQueueRelease(baseRelease({ inFlight: true }))).toEqual({
      type: 'hold',
      reason: 'in-flight',
    });
  });

  it('holds not-idle when the status is neither idle nor completed', () => {
    expect(decideQueueRelease(baseRelease({ status: 'running' }))).toEqual({
      type: 'hold',
      reason: 'not-idle',
    });
  });

  it('releases the head entry id when every gate passes', () => {
    expect(decideQueueRelease(baseRelease({ entries: [{ id: 'q-1' }, { id: 'q-2' }] }))).toEqual({
      type: 'release',
      entryId: 'q-1',
    });
  });

  it('short-circuit: paused takes priority over not-idle', () => {
    expect(decideQueueRelease(baseRelease({ paused: 'stopped', status: 'failed' }))).toEqual({
      type: 'hold',
      reason: 'paused',
    });
  });

  it('short-circuit: paused takes priority over head-failed', () => {
    expect(
      decideQueueRelease(
        baseRelease({
          paused: 'stopped',
          entries: [{ id: 'q-1', failure: { message: 'boom' } }],
        })
      )
    ).toEqual({ type: 'hold', reason: 'paused' });
  });

  it('short-circuit: empty takes priority over paused', () => {
    expect(decideQueueRelease(baseRelease({ entries: [], paused: 'stopped' }))).toEqual({
      type: 'hold',
      reason: 'empty',
    });
  });

  describe('nine-state enumeration', () => {
    for (const status of ALL_STATUSES) {
      const expectRelease = RELEASING_STATUSES.includes(status);
      it(`${status} -> ${expectRelease ? 'release' : 'hold not-idle'}`, () => {
        const decision = decideQueueRelease(baseRelease({ status }));
        if (expectRelease) {
          expect(decision).toEqual({ type: 'release', entryId: 'q-1' });
        } else {
          expect(decision).toEqual({ type: 'hold', reason: 'not-idle' });
        }
      });
    }
  });

  // M6 fix: the file header claims `decideQueueRelease` and `canStartTurn`
  // agree on when a turn may start — this is the assertion that actually
  // makes that claim true (previously only `decideSendAction`'s consistency
  // with `canStartTurn` was checked; `decideQueueRelease` had none at all).
  // `busy` is derived via the now-exported `isRunningStatus`, the same
  // mapping `ChatComposer.tsx`'s `isStoppable` delegates to.
  it('consistency: whenever decideQueueRelease releases, canStartTurn agrees for the matching runSend guard fields', () => {
    const bools = [true, false];
    for (const hasTarget of bools) {
      for (const disabled of bools) {
        for (const sending of bools) {
          for (const inFlight of bools) {
            for (const status of ALL_STATUSES) {
              const decision = decideQueueRelease(
                baseRelease({ hasTarget, disabled, sending, inFlight, status })
              );
              if (decision.type !== 'release') continue;
              const busy = isRunningStatus(status);
              expect(canStartTurn({ hasTarget, disabled, busy, sending, inFlight })).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe('decidePendingResolution', () => {
  it('auto-cancels a pending question on this session', () => {
    expect(
      decidePendingResolution({
        status: 'waiting_question',
        hasPendingQuestionHere: true,
        hasPendingPermissionHere: false,
      })
    ).toEqual({ cancelQuestion: true });
  });

  it('never auto-answers a pending permission on this session', () => {
    expect(
      decidePendingResolution({
        status: 'waiting_permission',
        hasPendingQuestionHere: false,
        hasPendingPermissionHere: true,
      })
    ).toEqual({ cancelQuestion: false });
  });

  it('does neither when nothing is pending', () => {
    expect(
      decidePendingResolution({
        status: 'running',
        hasPendingQuestionHere: false,
        hasPendingPermissionHere: false,
      })
    ).toEqual({ cancelQuestion: false });
  });

  it('does not trigger for a pending question/permission that belongs to another session', () => {
    expect(
      decidePendingResolution({
        status: 'waiting_question',
        hasPendingQuestionHere: false,
        hasPendingPermissionHere: false,
      })
    ).toEqual({ cancelQuestion: false });
  });
});

describe('deriveActionButtons', () => {
  it('idle, no failure -> [send]', () => {
    expect(
      deriveActionButtons({
        status: 'idle',
        sending: false,
        hasFailed: false,
        hasDraftContent: true,
      })
    ).toEqual([{ kind: 'send', disabled: false }]);
  });

  it('idle, last turn failed -> [retry, send]', () => {
    expect(
      deriveActionButtons({
        status: 'idle',
        sending: false,
        hasFailed: true,
        hasDraftContent: true,
      })
    ).toEqual([
      { kind: 'retry', disabled: false },
      { kind: 'send', disabled: false },
    ]);
  });

  it('running with draft content -> [stop, enqueue]', () => {
    expect(
      deriveActionButtons({
        status: 'running',
        sending: false,
        hasFailed: false,
        hasDraftContent: true,
      })
    ).toEqual([
      { kind: 'stop', disabled: false },
      { kind: 'enqueue', disabled: false },
    ]);
  });

  it('running with an empty draft -> [stop, enqueue(disabled)]', () => {
    expect(
      deriveActionButtons({
        status: 'running',
        sending: false,
        hasFailed: false,
        hasDraftContent: false,
      })
    ).toEqual([
      { kind: 'stop', disabled: false },
      { kind: 'enqueue', disabled: true },
    ]);
  });

  it('sending (pre-first-token) also counts as stoppable, independent of status', () => {
    expect(
      deriveActionButtons({
        status: 'idle',
        sending: true,
        hasFailed: false,
        hasDraftContent: true,
      })
    ).toEqual([
      { kind: 'stop', disabled: false },
      { kind: 'enqueue', disabled: false },
    ]);
  });

  it('property: retry and stop never appear together, across every status x failure combo', () => {
    for (const status of ALL_STATUSES) {
      for (const hasFailed of [true, false]) {
        const buttons = deriveActionButtons({
          status,
          sending: false,
          hasFailed,
          hasDraftContent: true,
        });
        const kinds = buttons.map((b) => b.kind) as ActionButtonKind[];
        const hasBoth = kinds.includes('retry') && kinds.includes('stop');
        expect(hasBoth).toBe(false);
      }
    }
  });
});

function entry(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: 'q-1',
    sessionId: 's1',
    text: 'hello',
    attachments: [],
    queuedAt: 1,
    ...overrides,
  };
}

describe('deriveQueueStripModel', () => {
  it('is not visible when there are no entries', () => {
    expect(
      deriveQueueStripModel({ entries: [], paused: null, hasPendingPermissionHere: false })
    ).toEqual({ visible: false, entries: [], pausedLabel: null, permissionHint: null });
  });

  it('numbers entries from 1', () => {
    const model = deriveQueueStripModel({
      entries: [entry({ id: 'q-1' }), entry({ id: 'q-2' }), entry({ id: 'q-3' })],
      paused: null,
      hasPendingPermissionHere: false,
    });
    expect(model.entries.map((e) => e.index)).toEqual([1, 2, 3]);
  });

  it('shows the paused caption with the waiting count when paused by the user (Stop)', () => {
    const model = deriveQueueStripModel({
      entries: [entry({ id: 'q-1' }), entry({ id: 'q-2' })],
      paused: 'stopped',
      hasPendingPermissionHere: false,
    });
    expect(model.pausedLabel).toBe('Queue paused — 2 waiting');
  });

  // S2 (round-2 iteration-3 review): a distinct, factual label for an AUTO
  // pause (the Host is not accepting this turn) vs a user-initiated Stop —
  // same `pausedLabel` field, using the existing `QueuePauseReason`.
  it('shows a distinct caption for an auto pause ("send-rejected") — not the Stop copy', () => {
    const model = deriveQueueStripModel({
      entries: [entry({ id: 'q-1' })],
      paused: 'send-rejected',
      hasPendingPermissionHere: false,
    });
    expect(model.pausedLabel).toBe("Queue paused — Host isn't accepting this turn (1 waiting)");
    expect(model.pausedLabel).not.toBe('Queue paused — 1 waiting');
  });

  it('surfaces the failed variant with its message', () => {
    const model = deriveQueueStripModel({
      entries: [entry({ failure: { message: 'network error' } })],
      paused: null,
      hasPendingPermissionHere: false,
    });
    expect(model.entries[0]).toMatchObject({ failed: true, failureMessage: 'network error' });
  });

  it('surfaces the permission hint row when a permission is pending on this session', () => {
    const model = deriveQueueStripModel({
      entries: [entry()],
      paused: null,
      hasPendingPermissionHere: true,
    });
    expect(model.permissionHint).toBe(QUEUE_PERMISSION_HINT);
  });
});

function baseRunEntryOutcome(
  overrides: Partial<DecideRunEntryOutcomeInput> = {}
): DecideRunEntryOutcomeInput {
  return {
    fatalHostError: false,
    sawAssistantProgress: false,
    sawUserEcho: false,
    ...overrides,
  };
}

describe('decideRunEntryOutcome (round-2 P0 queue-loss hardening)', () => {
  it('is "committed" when no fatal host.error landed', () => {
    expect(decideRunEntryOutcome(baseRunEntryOutcome())).toBe('committed');
  });

  it('is "rejected" when a fatal host.error fired and nothing else happened (session_busy)', () => {
    expect(decideRunEntryOutcome(baseRunEntryOutcome({ fatalHostError: true }))).toBe('rejected');
  });

  it('is "committed" when a fatal host.error fired but assistant progress was already observed', () => {
    expect(
      decideRunEntryOutcome(
        baseRunEntryOutcome({ fatalHostError: true, sawAssistantProgress: true })
      )
    ).toBe('committed');
  });

  it('is "committed" when the user echo landed before the fatal host.error (the turn WAS admitted)', () => {
    expect(
      decideRunEntryOutcome(baseRunEntryOutcome({ fatalHostError: true, sawUserEcho: true }))
    ).toBe('committed');
  });

  it('is "committed" when BOTH the user echo and assistant progress landed before the fatal host.error', () => {
    expect(
      decideRunEntryOutcome(
        baseRunEntryOutcome({ fatalHostError: true, sawAssistantProgress: true, sawUserEcho: true })
      )
    ).toBe('committed');
  });

  // R15 (round-2 iteration-2 review, queue verifier finding): the two tests
  // this replaced ("...after session.created..." / "...after
  // session.resumed...") asserted the EXACT SAME input as the base
  // 'rejected' case above (`{fatalHostError:true, sawAssistantProgress:
  // false, sawUserEcho:false}`) — none of the three could fail independently
  // of the others, so together they carried zero more signal than one test.
  // `decideRunEntryOutcome` has no `sawSessionCreated`/`sawSessionResumed`
  // fields at all (F4 removed them — create/resume success happens entirely
  // before the admission gate, see the doc comment above), so "after
  // session.created" vs "after session.resumed" cannot be distinguished at
  // this pure layer. The full truth table below is what actually pins the
  // function's behavior per distinct input combination, so a mutation to
  // any one branch fails only the row(s) it affects.
  it('full truth table: "rejected" iff fatalHostError && !sawAssistantProgress && !sawUserEcho', () => {
    for (const fatalHostError of [true, false]) {
      for (const sawAssistantProgress of [true, false]) {
        for (const sawUserEcho of [true, false]) {
          const outcome = decideRunEntryOutcome({
            fatalHostError,
            sawAssistantProgress,
            sawUserEcho,
          });
          const expected =
            fatalHostError && !sawAssistantProgress && !sawUserEcho ? 'rejected' : 'committed';
          expect(outcome).toBe(expected);
        }
      }
    }
  });

  // F4: explicit regression pin for the review's queue-loss scenario — a
  // create/resume handshake succeeds, then 8 bounded session_busy retries
  // (ChatComposer.tsx's runSend) all fail with zero user echo. This MUST
  // requeue the message, never drop it.
  it('is "rejected" for the session_busy-after-create/resume queue-loss scenario (create → 8× session_busy → no echo)', () => {
    expect(
      decideRunEntryOutcome(
        baseRunEntryOutcome({
          fatalHostError: true,
          sawAssistantProgress: false,
          sawUserEcho: false,
        })
      )
    ).toBe('rejected');
  });
});

describe('shouldArmRetryable (R1, round-2 iteration-2 review; A1 round-4 point-check fix)', () => {
  const ORIGINS: readonly RunSendOrigin[] = ['direct', 'retry', 'release'];

  it('is false ONLY for rejected + release — the queue itself is the recovery path there', () => {
    expect(shouldArmRetryable('rejected', 'release')).toBe(false);
  });

  it('is true for rejected + direct — no queue entry exists to fall back on', () => {
    expect(shouldArmRetryable('rejected', 'direct')).toBe(true);
  });

  it('is true for rejected + retry — no queue entry exists to fall back on', () => {
    expect(shouldArmRetryable('rejected', 'retry')).toBe(true);
  });

  // A1 (round-4 point-check fix, retry-doublesend diagnosis): replaces the
  // OLD "is true for 'committed' regardless of origin" assertion — arming a
  // one-click Retry for an already-admitted turn silently resent the
  // IDENTICAL text as a second turn (the double-send incident's primary
  // root cause). 'committed' must NEVER arm the resend affordance now,
  // regardless of origin; see `decideFailureAffordance` for what it gets
  // instead ('restore-draft').
  it("round-4 fix (A1): is false for 'committed' regardless of origin — an already-admitted turn must never be silently resent", () => {
    for (const origin of ORIGINS) {
      expect(shouldArmRetryable('committed', origin)).toBe(false);
    }
  });

  it('is true for "skipped" regardless of origin', () => {
    for (const origin of ORIGINS) {
      expect(shouldArmRetryable('skipped', origin)).toBe(true);
    }
  });
});

describe('decideFailureAffordance (A1, round-4 point-check fix)', () => {
  const ORIGINS: readonly RunSendOrigin[] = ['direct', 'retry', 'release'];
  const OUTCOMES: readonly RunEntryOutcome[] = ['committed', 'skipped', 'rejected'];

  it("is 'restore-draft' for 'committed', regardless of origin", () => {
    for (const origin of ORIGINS) {
      expect(decideFailureAffordance('committed', origin)).toBe('restore-draft');
    }
  });

  it("is 'resend' for 'skipped', regardless of origin — nothing was ever sent", () => {
    for (const origin of ORIGINS) {
      expect(decideFailureAffordance('skipped', origin)).toBe('resend');
    }
  });

  it("is 'none' for 'rejected' + 'release' — the queue owns recovery there", () => {
    expect(decideFailureAffordance('rejected', 'release')).toBe('none');
  });

  it("is 'resend' for 'rejected' + 'direct'/'retry' — no queue entry to fall back on", () => {
    expect(decideFailureAffordance('rejected', 'direct')).toBe('resend');
    expect(decideFailureAffordance('rejected', 'retry')).toBe('resend');
  });

  it('full 3x3 matrix over every outcome/origin pair', () => {
    const expected: Record<RunEntryOutcome, Record<RunSendOrigin, FailureAffordance>> = {
      committed: { direct: 'restore-draft', retry: 'restore-draft', release: 'restore-draft' },
      skipped: { direct: 'resend', retry: 'resend', release: 'resend' },
      rejected: { direct: 'resend', retry: 'resend', release: 'none' },
    };
    for (const outcome of OUTCOMES) {
      for (const origin of ORIGINS) {
        expect(decideFailureAffordance(outcome, origin)).toBe(expected[outcome][origin]);
      }
    }
  });
});

describe('shouldPauseQueueOnRejection (S1, round-2 iteration-3 review; generalized from R4)', () => {
  const ORIGINS: readonly RunSendOrigin[] = ['direct', 'retry', 'release'];

  it('is true for EVERY "rejected" outcome on the release path — not just session_busy exhaustion', () => {
    // No error-code parameter anymore: every evidence-free release-origin
    // rejection (create timeout, ensureHost() rejection, non-busy
    // pre-admission host.error, session.failed mid busy-loop, busy-retry
    // exhaustion itself) must pause, since `finalizeOutcome` funnels ALL of
    // them through the exact same `decideRunEntryOutcome` -> 'rejected' path
    // with no way to distinguish the failure class from the outcome alone.
    expect(shouldPauseQueueOnRejection('rejected', 'release')).toBe(true);
  });

  it('is false for a "committed" outcome — the entry has already been spent, nothing to pause for', () => {
    expect(shouldPauseQueueOnRejection('committed', 'release')).toBe(false);
  });

  it('is false for "direct"/"retry" origins — no queue entry exists to loop against', () => {
    expect(shouldPauseQueueOnRejection('rejected', 'direct')).toBe(false);
    expect(shouldPauseQueueOnRejection('rejected', 'retry')).toBe(false);
  });

  // Iteration-4 fix: the previous version of this test asserted
  // `shouldPauseQueueOnRejection(outcome, origin) === !shouldArmRetryable(outcome, origin)`
  // — since the implementation IS `!shouldArmRetryable(...)`, that is
  // tautological (a mutation to `shouldArmRetryable` moves both sides of the
  // assertion together and the test still passes). This hardcodes the
  // expected boolean for all 9 outcome/origin pairs independently of
  // `shouldArmRetryable`, so it actually pins the function's own behavior:
  // true ONLY for rejected+release, false everywhere else.
  it('matches a hardcoded truth table over all 9 outcome/origin pairs — independent of shouldArmRetryable', () => {
    const expected: Record<RunEntryOutcome, Record<RunSendOrigin, boolean>> = {
      committed: { direct: false, retry: false, release: false },
      skipped: { direct: false, retry: false, release: false },
      rejected: { direct: false, retry: false, release: true },
    };
    for (const outcome of Object.keys(expected) as RunEntryOutcome[]) {
      for (const origin of ORIGINS) {
        expect(shouldPauseQueueOnRejection(outcome, origin)).toBe(expected[outcome][origin]);
      }
    }
  });

  // A1 (round-4 point-check fix) regression pin: this function is now
  // DELIBERATELY no longer the literal complement of `shouldArmRetryable` —
  // `shouldArmRetryable('committed', …)` became `false` for every origin
  // (A1), but a 'committed' outcome must still NEVER pause the queue (its
  // entry, if any, has already been spent — see `decideFailureAffordance`
  // for what 'committed' gets instead). If a future edit "simplifies" this
  // back to `!shouldArmRetryable(...)`, this is the test that catches it.
  it('round-4 fix (A1): stays false for "committed" even though shouldArmRetryable now also returns false for it — no longer a literal complement', () => {
    for (const origin of ORIGINS) {
      expect(shouldArmRetryable('committed', origin)).toBe(false);
      expect(shouldPauseQueueOnRejection('committed', origin)).toBe(false);
    }
  });
});

describe('shouldRetryBusySend (A3, round-4 point-check fix)', () => {
  it('retries while busy, no echo yet, and under the attempt cap', () => {
    expect(
      shouldRetryBusySend({ fatalHostErrorCode: 'session_busy', sawUserEcho: false, attempts: 0 })
    ).toBe(true);
  });

  it('does not retry once the Host has echoed this turn — the double-send hole this fix closes', () => {
    expect(
      shouldRetryBusySend({ fatalHostErrorCode: 'session_busy', sawUserEcho: true, attempts: 0 })
    ).toBe(false);
  });

  it('does not retry for a non-session_busy error code', () => {
    expect(
      shouldRetryBusySend({
        fatalHostErrorCode: 'session_not_found',
        sawUserEcho: false,
        attempts: 0,
      })
    ).toBe(false);
  });

  it('does not retry once the attempt cap (8) is reached', () => {
    expect(
      shouldRetryBusySend({ fatalHostErrorCode: 'session_busy', sawUserEcho: false, attempts: 8 })
    ).toBe(false);
  });

  it('does not retry with no error code at all', () => {
    expect(shouldRetryBusySend({ fatalHostErrorCode: null, sawUserEcho: false, attempts: 0 })).toBe(
      false
    );
  });
});

// F1 (round-4 Codex NEEDS-FIX #1): `runSend`'s busy-retry loop now calls
// `shouldRetryBusySend` TWICE per iteration — once as the while-condition
// (before the 250ms sleep) and once again right after the sleep, before
// firing another `sendAndWait` — closing the residual window where an echo
// arriving DURING the backoff would otherwise still trigger a resend. The
// function itself is unchanged/stateless (same truth table as above); these
// tests pin the CALLING PROTOCOL by exercising it with inputs shaped exactly
// like the two call sites use them within one loop iteration.
describe('shouldRetryBusySend post-sleep gate calling protocol (F1, round-4 Codex NEEDS-FIX #1)', () => {
  it('pre-sleep gate (while-condition) and post-sleep gate agree when nothing changed during the sleep', () => {
    const preSleep = { fatalHostErrorCode: 'session_busy', sawUserEcho: false, attempts: 3 };
    // The loop body increments `attempts` once at entry, then re-checks with
    // `attempts - 1` so both calls describe the SAME iteration.
    const postSleep = { ...preSleep, attempts: preSleep.attempts };
    expect(shouldRetryBusySend(preSleep)).toBe(true);
    expect(shouldRetryBusySend(postSleep)).toBe(true);
  });

  it('post-sleep gate flips to false the instant sawUserEcho becomes true during the sleep, even though the pre-sleep gate was true', () => {
    const preSleep = { fatalHostErrorCode: 'session_busy', sawUserEcho: false, attempts: 0 };
    expect(shouldRetryBusySend(preSleep)).toBe(true);
    // An echo landing asynchronously mid-sleep flips ONLY sawUserEcho —
    // fatalHostErrorCode/attempts are unchanged (the reset that used to
    // precede the sleep now happens AFTER this gate, specifically so this
    // re-check still has meaningful evidence to compare against).
    const postSleep = { ...preSleep, sawUserEcho: true };
    expect(shouldRetryBusySend(postSleep)).toBe(false);
  });

  it('post-sleep gate stays true across every attempt count under the cap when sawUserEcho never changes', () => {
    for (let attempts = 0; attempts < 8; attempts += 1) {
      const input = { fatalHostErrorCode: 'session_busy', sawUserEcho: false, attempts };
      expect(shouldRetryBusySend(input)).toBe(true);
    }
  });

  it('both gates agree false once the attempt cap is reached, independent of sawUserEcho', () => {
    for (const sawUserEcho of [true, false]) {
      const input = { fatalHostErrorCode: 'session_busy', sawUserEcho, attempts: 8 };
      expect(shouldRetryBusySend(input)).toBe(false);
    }
  });
});

describe('shouldClearRetryableOnOutcome (F3, round-4 Codex NEEDS-FIX #2)', () => {
  it('is true only for "committed" — a genuine delivery is the only outcome that should clear the snapshot', () => {
    expect(shouldClearRetryableOnOutcome('committed')).toBe(true);
  });

  it('is false for "skipped" — the original snapshot must survive an early guard-fail with nothing sent', () => {
    expect(shouldClearRetryableOnOutcome('skipped')).toBe(false);
  });

  it('is false for "rejected" — finalizeOutcome already re-arms its OWN snapshot for this case', () => {
    expect(shouldClearRetryableOnOutcome('rejected')).toBe(false);
  });
});

describe('shouldClearPauseOnSend (A4, round-4 point-check fix)', () => {
  it('is false for "retry" — a Retry must not clear the queue\'s own "send-rejected" protection', () => {
    expect(shouldClearPauseOnSend('retry')).toBe(false);
  });

  it('is true for "direct" — an ordinary new send still means the user pushed the flow forward', () => {
    expect(shouldClearPauseOnSend('direct')).toBe(true);
  });

  it('is true for "release" — a no-op in practice (the queue is never paused when release fires), but harmless', () => {
    expect(shouldClearPauseOnSend('release')).toBe(true);
  });
});

/**
 * Stop-hang fix (2026-08-10): the COMPOSITION `runSend`'s Stop exit relies on.
 * The exit itself lives in `ChatComposer.tsx` (unrenderable here — see
 * `composerStopStatic.test.ts` for its structural guards), but every decision
 * it makes is taken by the pure functions below, called with exactly the
 * argument shapes it passes. Asserting the composition is what makes "a user
 * Stop is a clean end, not a failure, and never swallows a message" a
 * property of this module rather than a claim in a comment.
 */
describe('Stop exit composition (2026-08-10 stop-hang fix)', () => {
  const echoedStop: DecideRunEntryOutcomeInput = {
    // The Stop exit passes `fatalHostError: true` in the same sense every
    // other early exit does — "this attempt is ending without a normal
    // completion" — so the evidence gate below is what actually decides.
    fatalHostError: true,
    sawAssistantProgress: false,
    sawUserEcho: true,
  };
  const unadmittedStop: DecideRunEntryOutcomeInput = {
    fatalHostError: true,
    sawAssistantProgress: false,
    sawUserEcho: false,
  };

  it("a Stop the Host had already echoed is 'committed' — the text is in the timeline, resending would duplicate it", () => {
    expect(decideRunEntryOutcome(echoedStop)).toBe('committed');
    // Consequences the exit depends on: no Retry armed anywhere, and the
    // queue is never paused for it (`handleStop` owns that pause).
    for (const origin of ['direct', 'retry', 'release'] satisfies RunSendOrigin[]) {
      expect(shouldArmRetryable('committed', origin)).toBe(false);
      expect(shouldPauseQueueOnRejection('committed', origin)).toBe(false);
    }
  });

  it('a Stop after real assistant progress is committed too — progress is admission evidence on its own', () => {
    expect(decideRunEntryOutcome({ ...unadmittedStop, sawAssistantProgress: true })).toBe(
      'committed'
    );
  });

  it("a Stop the Host never admitted is 'rejected' — nothing was spent, so nothing may be swallowed", () => {
    expect(decideRunEntryOutcome(unadmittedStop)).toBe('rejected');
    // 'release': useQueueRelease restores the entry to the head, and the
    // queue pauses so it cannot immediately re-release.
    expect(decideFailureAffordance('rejected', 'release')).toBe('none');
    expect(shouldPauseQueueOnRejection('rejected', 'release')).toBe(true);
    // 'direct'/'retry': no queue entry exists, so the payload comes back as
    // the one-click Retry snapshot — safe precisely because the Host never
    // saw this text.
    expect(decideFailureAffordance('rejected', 'direct')).toBe('resend');
    expect(decideFailureAffordance('rejected', 'retry')).toBe('resend');
  });

  it("'committed' carries no queue-swallowing risk in either direction: it never pauses, and never requeues", () => {
    // The half of the contract `useQueueRelease` implements: only
    // 'skipped'/'rejected' are restored to the head. Stated here so a future
    // change to the outcome vocabulary has to confront it.
    const requeued: Record<RunEntryOutcome, boolean> = {
      committed: false,
      skipped: true,
      rejected: true,
    };
    expect(requeued[decideRunEntryOutcome(echoedStop)]).toBe(false);
    expect(requeued[decideRunEntryOutcome(unadmittedStop)]).toBe(true);
  });
});
