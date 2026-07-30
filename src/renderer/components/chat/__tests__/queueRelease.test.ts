import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { QueuedMessage } from '../messageQueue';
import {
  type ActionButtonKind,
  type CanStartTurnInput,
  canStartTurn,
  type DecideRunEntryOutcomeInput,
  type DecideSendActionInput,
  decidePendingResolution,
  decideQueueRelease,
  decideRunEntryOutcome,
  decideSendAction,
  deriveActionButtons,
  deriveQueueStripModel,
  isRunningStatus,
  QUEUE_PERMISSION_HINT,
  type RunEntryOutcome,
  type RunSendOrigin,
  shouldArmRetryable,
  shouldPauseQueueOnRejection,
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

describe('shouldArmRetryable (R1, round-2 iteration-2 review)', () => {
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

  it('is true for "committed" regardless of origin — the entry (if any) has already been spent', () => {
    for (const origin of ORIGINS) {
      expect(shouldArmRetryable('committed', origin)).toBe(true);
    }
  });

  it('is true for "skipped" regardless of origin', () => {
    for (const origin of ORIGINS) {
      expect(shouldArmRetryable('skipped', origin)).toBe(true);
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
});
