import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { QueuedMessage } from '../messageQueue';
import {
  type ActionButtonKind,
  type CanStartTurnInput,
  canStartTurn,
  type DecideRunEntryOutcomeInput,
  type DecideSendActionInput,
  decideAdmittedTimeoutOutcome,
  decideFailureAffordance,
  decidePendingResolution,
  decideQueueRelease,
  decideRunEntryOutcome,
  decideSendAction,
  deriveActionButtons,
  deriveQueueStripModel,
  type FailureAffordance,
  isAdmittedOutcome,
  isRunningStatus,
  QUEUE_PERMISSION_HINT,
  type RestoredDraftMarker,
  type RunEntryOutcome,
  type RunSendOrigin,
  shouldArmRetryable,
  shouldClearPauseOnSend,
  shouldClearRetryableOnOutcome,
  shouldPauseQueueOnRejection,
  shouldRetryBusySend,
  shouldRevokeRestoredDraft,
} from '../queueRelease';

/** `[P-7]` reads `useQueueRelease.ts`'s source — a hook this node suite cannot render. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    hasQueuedEntries: false,
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

  it('enqueues behind an existing queue even after Stop has settled the runtime idle', () => {
    expect(decideSendAction(baseSendAction({ hasQueuedEntries: true }))).toBe('enqueue');
  });

  it('sends directly when idle with a target, content and no existing queue', () => {
    expect(decideSendAction(baseSendAction())).toBe('send');
  });

  it('consistency: decideSendAction === "send" iff canStartTurn and queue ownership both allow it', () => {
    const bools = [true, false];
    for (const hasTarget of bools) {
      for (const disabled of bools) {
        for (const busy of bools) {
          for (const sending of bools) {
            for (const inFlight of bools) {
              for (const hasQueuedEntries of bools) {
                const shared = { hasTarget, disabled, busy, sending, inFlight };
                const action = decideSendAction({
                  ...shared,
                  hasContent: true,
                  reading: 0,
                  hasQueuedEntries,
                });
                const canStart = canStartTurn(shared) && !hasQueuedEntries;
                expect(action === 'send').toBe(canStart);
              }
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
        hasQueuedEntries: false,
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
        hasQueuedEntries: false,
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
        hasQueuedEntries: false,
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
        hasQueuedEntries: false,
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
        hasQueuedEntries: false,
      })
    ).toEqual([
      { kind: 'stop', disabled: false },
      { kind: 'enqueue', disabled: false },
    ]);
  });

  it('idle with queued predecessors keeps the next draft in enqueue mode', () => {
    expect(
      deriveActionButtons({
        status: 'idle',
        sending: false,
        hasFailed: false,
        hasDraftContent: true,
        hasQueuedEntries: true,
      })
    ).toEqual([{ kind: 'enqueue', disabled: false }]);
  });

  it('property: retry and stop never appear together, across every status x failure combo', () => {
    for (const status of ALL_STATUSES) {
      for (const hasFailed of [true, false]) {
        const buttons = deriveActionButtons({
          status,
          sending: false,
          hasFailed,
          hasDraftContent: true,
          hasQueuedEntries: false,
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

  it('numbers entries from 1 and derives adjacent-move boundaries', () => {
    const model = deriveQueueStripModel({
      entries: [entry({ id: 'q-1' }), entry({ id: 'q-2' }), entry({ id: 'q-3' })],
      paused: null,
      hasPendingPermissionHere: false,
    });
    expect(model.entries.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(model.entries.map(({ canMoveUp, canMoveDown }) => [canMoveUp, canMoveDown])).toEqual([
      [false, true],
      [true, true],
      [true, false],
    ]);
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
  const OUTCOMES: readonly RunEntryOutcome[] = ['committed', 'skipped', 'rejected', 'pending'];

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

  it('full matrix over every outcome/origin pair', () => {
    const expected: Record<RunEntryOutcome, Record<RunSendOrigin, FailureAffordance>> = {
      committed: { direct: 'restore-draft', retry: 'restore-draft', release: 'restore-draft' },
      skipped: { direct: 'resend', retry: 'resend', release: 'resend' },
      rejected: { direct: 'resend', retry: 'resend', release: 'none' },
      // F2 §4.3 point 2: a guess never replays input. See `[P-2]`.
      pending: { direct: 'none', retry: 'none', release: 'none' },
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
      // F2 §4.3 point 3: the entry was spent at the commit point.
      pending: { direct: false, retry: false, release: false },
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
      // F2 §4.3 point 5: admitted, therefore never requeued.
      pending: false,
    };
    expect(requeued[decideRunEntryOutcome(echoedStop)]).toBe(false);
    expect(requeued[decideRunEntryOutcome(unadmittedStop)]).toBe(true);
  });
});

/**
 * F2 S3 §4.3 — the `'pending'` outcome, asserted at all six consumption points.
 *
 * WHY THIS GROUP IS P0. Adding a member to `RunEntryOutcome` produces ZERO
 * compile errors: not one of the six consumers is an exhaustive `switch`, they
 * are all `if (x === 'committed')` / `if (a || b)` shapes. So a new member
 * silently inherits whatever the existing default branch does — and for two of
 * the six that default is `'resend'` / `true`, i.e. a one-click Retry armed on
 * a turn the Host ALREADY admitted. That is the double-send this repo's A1
 * round removed; it would come straight back, with no red test and no red
 * compiler, from an edit that merely widened a union.
 *
 * Hence: every one of the six is pinned here explicitly, by hardcoded value —
 * never by calling another production function to produce the expectation
 * (see the tautology note on `shouldPauseQueueOnRejection` above).
 *
 * Consumption points (spec §4.3 table):
 *   1 `shouldArmRetryable`            -> `[P-3]`
 *   2 `decideFailureAffordance`       -> `[P-2]` (load-bearing: the user's ruling)
 *   3 `shouldPauseQueueOnRejection`   -> `[P-4]`
 *   4 `shouldClearRetryableOnOutcome` -> `[P-4b]`
 *   5 `useQueueRelease`'s requeue gate-> `[P-5]` + `[P-7]` (source guard)
 *   6 `maybeApplyFirstMessageTitle`   -> `[P-5]` + `composerStopStatic.test.ts`
 */
describe("RunEntryOutcome 'pending' — six consumption points (F2 S3 §4.3, P0)", () => {
  const ORIGINS: readonly RunSendOrigin[] = ['direct', 'retry', 'release'];
  const ALL_OUTCOMES: readonly RunEntryOutcome[] = ['committed', 'skipped', 'rejected', 'pending'];

  /**
   * The classifier itself. NOT a failure classifier — there is no error on
   * this path at all: the renderer's silence ceiling elapsed, which says
   * nothing about whether the turn is alive (the Host owns that verdict, and
   * its own stall watchdog fires first). All this decides is whether the Host
   * ever took the turn.
   */
  it('[P-1] decideAdmittedTimeoutOutcome: admission evidence, four-row truth table', () => {
    expect(decideAdmittedTimeoutOutcome({ sawUserEcho: false, sawAssistantProgress: false })).toBe(
      'rejected'
    );
    expect(decideAdmittedTimeoutOutcome({ sawUserEcho: true, sawAssistantProgress: false })).toBe(
      'pending'
    );
    expect(decideAdmittedTimeoutOutcome({ sawUserEcho: false, sawAssistantProgress: true })).toBe(
      'pending'
    );
    expect(decideAdmittedTimeoutOutcome({ sawUserEcho: true, sawAssistantProgress: true })).toBe(
      'pending'
    );
  });

  /**
   * LOAD-BEARING (spec §12.2 assertion 4, and the executable form of the
   * user's own ruling: "only a CONFIRMED dead turn may replay the input"). A
   * silence ceiling is a guess, not evidence — so it restores nothing and
   * offers nothing. The silent default here would have been `'resend'`.
   */
  it("[P-2] consumption point 2 — decideFailureAffordance('pending', *) is 'none' for every origin", () => {
    for (const origin of ORIGINS) {
      expect(decideFailureAffordance('pending', origin)).toBe('none');
    }
  });

  /**
   * `[P-2b]` — the STRUCTURAL half, and the one that actually bites.
   *
   * As-built finding (mutation M6): deleting `decideFailureAffordance`'s
   * `'pending'` branch does NOT change its answer today, so no behavioural
   * assertion can go red on it. The spec's §4.3 table predicted a silent
   * default of `'resend'` there; the real default is `'none'`, because this
   * function delegates its non-`'committed'` half to `shouldArmRetryable`,
   * which has a `'pending'` branch of its own returning `false`.
   *
   * The two branches MASK each other, which is worse than either being wrong
   * alone: each looks redundant in isolation, so either could be "simplified
   * away" by a reviewer who checked that the tests still pass — and deleting
   * BOTH restores `'resend'`, i.e. the double-send. (The joint deletion is
   * covered behaviourally by `[P-2]`; that mutation was run and is red.)
   *
   * So the explicit branch is pinned over the source. It is not decoration:
   * it is what makes this function's answer independent of a decision that
   * lives in another function and could change for its own reasons.
   */
  it('[P-2b] decideFailureAffordance answers for `pending` explicitly, not by delegation', () => {
    const moduleSource = readFileSync(path.resolve(__dirname, '../queueRelease.ts'), 'utf8');
    const body = moduleSource.slice(
      moduleSource.indexOf('export function decideFailureAffordance('),
      moduleSource.indexOf('export function shouldPauseQueueOnRejection(')
    );
    expect(body).toContain("if (outcome === 'pending') return 'none';");
    // ...and it is decided BEFORE the delegation, so the delegation can never
    // be what produces the answer.
    expect(body.indexOf("if (outcome === 'pending') return 'none';")).toBeLessThan(
      body.indexOf('shouldArmRetryable(outcome, origin)')
    );
  });

  /**
   * The turn is already in the timeline and quite possibly in the CLI's own
   * transcript; a one-click resend would be a second `chat.send`, a second
   * `beginTurn`, a second echo. The silent default here would have been
   * `true` — the exact defect A1 removed for `'committed'`.
   */
  it("[P-3] consumption point 1 — shouldArmRetryable('pending', *) is false for every origin", () => {
    for (const origin of ORIGINS) {
      expect(shouldArmRetryable('pending', origin)).toBe(false);
    }
  });

  /**
   * The silent default (`false`) happens to be correct here, which is exactly
   * why it is written out explicitly in the implementation and pinned here:
   * "correct by accident" is not a contract. The queue entry was spent at the
   * commit point, so there is no restore->re-release loop to protect against.
   */
  it("[P-4] consumption point 3 — shouldPauseQueueOnRejection('pending', *) is false for every origin", () => {
    for (const origin of ORIGINS) {
      expect(shouldPauseQueueOnRejection('pending', origin)).toBe(false);
    }
  });

  /**
   * `'pending'` proves nothing, so it clears nothing. (`runSend`'s entry
   * already cleared `retryable` at its commit point; this is about the
   * `handleRetry` result gate.)
   */
  it("[P-4b] consumption point 4 — shouldClearRetryableOnOutcome('pending') is false", () => {
    expect(shouldClearRetryableOnOutcome('pending')).toBe(false);
  });

  /**
   * The shared predicate consumption points 5 and 6 are rewritten in terms of.
   * "Admitted" is the honest question both of them were really asking:
   *  - point 5 (`useQueueRelease`): may this entry go back on the queue?
   *    Admitted means NO — the Host has it, a requeue would double-send.
   *  - point 6 (`maybeApplyFirstMessageTitle`): did this turn's text reach the
   *    CLI transcript? Admitted means YES — so a first message that timed out
   *    still names the chat. (This is the one row of the §4.3 table where the
   *    silent default was WRONG in the other direction: it would have skipped
   *    the title.)
   */
  it('[P-5] consumption points 5 & 6 — isAdmittedOutcome over the complete four-value vocabulary', () => {
    const expected: Record<RunEntryOutcome, boolean> = {
      committed: true,
      pending: true,
      skipped: false,
      rejected: false,
    };
    for (const outcome of ALL_OUTCOMES) {
      expect(isAdmittedOutcome(outcome)).toBe(expected[outcome]);
    }
    // Point 5 restated as the requeue gate itself reads it, so the direction
    // cannot be inverted without a red test.
    expect(ALL_OUTCOMES.filter((outcome) => !isAdmittedOutcome(outcome))).toEqual([
      'skipped',
      'rejected',
    ]);
  });

  /**
   * Regression protection for the three PRE-EXISTING members: adding a fourth
   * must not perturb any of them. Hardcoded, and deliberately restating rows
   * the groups above already cover — a widening edit that "simplifies" one of
   * these four functions is exactly what this is here to catch.
   */
  it('[P-6] the three pre-existing outcomes keep their complete tables, unchanged', () => {
    const affordance: Record<RunEntryOutcome, Record<RunSendOrigin, FailureAffordance>> = {
      committed: { direct: 'restore-draft', retry: 'restore-draft', release: 'restore-draft' },
      skipped: { direct: 'resend', retry: 'resend', release: 'resend' },
      rejected: { direct: 'resend', retry: 'resend', release: 'none' },
      pending: { direct: 'none', retry: 'none', release: 'none' },
    };
    const arm: Record<RunEntryOutcome, Record<RunSendOrigin, boolean>> = {
      committed: { direct: false, retry: false, release: false },
      skipped: { direct: true, retry: true, release: true },
      rejected: { direct: true, retry: true, release: false },
      pending: { direct: false, retry: false, release: false },
    };
    const pause: Record<RunEntryOutcome, Record<RunSendOrigin, boolean>> = {
      committed: { direct: false, retry: false, release: false },
      skipped: { direct: false, retry: false, release: false },
      rejected: { direct: false, retry: false, release: true },
      pending: { direct: false, retry: false, release: false },
    };
    const clearRetryable: Record<RunEntryOutcome, boolean> = {
      committed: true,
      skipped: false,
      rejected: false,
      pending: false,
    };
    for (const outcome of ALL_OUTCOMES) {
      expect(shouldClearRetryableOnOutcome(outcome)).toBe(clearRetryable[outcome]);
      for (const origin of ORIGINS) {
        expect(decideFailureAffordance(outcome, origin)).toBe(affordance[outcome][origin]);
        expect(shouldArmRetryable(outcome, origin)).toBe(arm[outcome][origin]);
        expect(shouldPauseQueueOnRejection(outcome, origin)).toBe(pause[outcome][origin]);
      }
    }
  });

  /**
   * §4.4's invariant, in place of the fifth send gate B asked for. A
   * `'pending'` turn is one the Host admitted and has NOT ended — no terminal
   * event has been emitted, so the session status is still one of the running
   * four. Over that whole set the queue holds and `canStartTurn` is false, so
   * nothing can start a second turn while a reply is still owed.
   *
   * The complementary half is that the two RELEASING statuses are disjoint
   * from the running set: "pendingReply armed AND the queue released" is not a
   * state this machine can be in, which is why no new latch is needed.
   */
  it('[Q-1] a pending reply cannot coexist with a queue release or a new turn', () => {
    const runningStatuses = ALL_STATUSES.filter(isRunningStatus);
    expect(runningStatuses).toEqual([
      'starting',
      'running',
      'waiting_permission',
      'waiting_question',
    ]);
    for (const status of runningStatuses) {
      const decision = decideQueueRelease({
        sessionId: 's1',
        entries: [{ id: 'q1' }],
        paused: null,
        hasTarget: true,
        disabled: false,
        sending: false,
        inFlight: false,
        status,
      });
      expect(decision).toEqual({ type: 'hold', reason: 'not-idle' });
      // `busy` is `isStoppable(status)` in the composer, which delegates to
      // `isRunningStatus` — the same predicate, so the two gates cannot drift.
      expect(canStartTurn(baseCanStartTurn({ busy: isRunningStatus(status) }))).toBe(false);
    }
    // Disjoint by construction: the release set and the running set share no
    // member, so the "pending + released" combination is unconstructible.
    expect(RELEASING_STATUSES.filter(isRunningStatus)).toEqual([]);
  });

  /**
   * Consumption point 5 lives in a React hook (`useQueueRelease.ts`), which
   * this node-environment suite cannot render — so its rewrite is pinned over
   * the SOURCE, the same posture `composerStopStatic.test.ts` takes for
   * `runSend`'s own closure-local facts.
   *
   * The old form enumerated the two non-admitted members by name. That is
   * precisely the shape that silently does the right thing today and the wrong
   * thing the moment a fifth member appears; `!isAdmittedOutcome(result)` is
   * structurally correct for any future vocabulary.
   */
  it('[P-7] consumption point 5 — the release transaction asks isAdmittedOutcome, not a name list', () => {
    const transactionSource = readFileSync(
      path.resolve(__dirname, '../queueReleaseTransaction.ts'),
      'utf8'
    );
    expect(transactionSource).toContain('if (isAdmittedOutcome(outcome))');
    expect(transactionSource).not.toContain("outcome === 'skipped' || outcome === 'rejected'");
    expect(transactionSource).toContain('import { isAdmittedOutcome');
  });
});

/**
 * F2 S3 §5.3 / §12.1 — `[D-2]` and `[D-3]`: provenance for an automatically
 * restored draft.
 *
 * D1 kept automatic restore for a CONFIRMED dead turn, so the residual half
 * needs a way to be taken back: a `session.failed` synthesised by the Host-exit
 * broadcast and the real end of the turn are separated by a window, and a reply
 * landing inside it must be able to undo the restore.
 *
 * The whole point is asymmetry. Revoking wrongly destroys text that exists
 * nowhere else; NOT revoking leaves a duplicate the user can see and delete.
 * So every clause is a veto and the default is "leave it alone".
 */
describe('shouldRevokeRestoredDraft (F2 S3 §5.3, D1 provenance)', () => {
  const marker: RestoredDraftMarker = {
    sessionId: 's1',
    text: 'give me the whole function',
    draftIds: ['att-a', 'att-b'],
    valueRevision: 7,
    attachmentRevision: 3,
  };
  const untouched = {
    sessionId: 's1',
    text: 'give me the whole function',
    draftIds: ['att-a', 'att-b'] as readonly string[],
    valueRevision: 7,
  };

  it('[D-2] revokes only while text AND attachments are provably untouched', () => {
    expect(shouldRevokeRestoredDraft(marker, untouched)).toBe(true);
  });

  it('[D-2] a moved text revision vetoes it', () => {
    expect(shouldRevokeRestoredDraft(marker, { ...untouched, valueRevision: 8 })).toBe(false);
  });

  it('[D-2] any change to the attachment list vetoes it — added, removed or swapped', () => {
    expect(
      shouldRevokeRestoredDraft(marker, { ...untouched, draftIds: ['att-a', 'att-b', 'att-c'] })
    ).toBe(false);
    expect(shouldRevokeRestoredDraft(marker, { ...untouched, draftIds: ['att-a'] })).toBe(false);
    // The case a count cannot see: one removed, one added, same length.
    expect(shouldRevokeRestoredDraft(marker, { ...untouched, draftIds: ['att-a', 'att-c'] })).toBe(
      false
    );
    // Order is part of identity too.
    expect(shouldRevokeRestoredDraft(marker, { ...untouched, draftIds: ['att-b', 'att-a'] })).toBe(
      false
    );
  });

  /**
   * `[D-3]` — THE discipline. The user retypes, character for character, the
   * same sentence the app had put there. Value equality holds; the revision
   * does not. A value-equality implementation would delete what the user just
   * typed, which is the defect this marker exists to make impossible.
   */
  it('[D-3] never revokes by value equality: an identical retype belongs to the user', () => {
    // The sharpest form, and the one a value-equality implementation gets
    // wrong: a TEXT-ONLY restore, which the user clears and then retypes
    // character for character. Every value in sight matches — same text, same
    // (empty) attachment list, same session. The ONLY thing that differs is the
    // revision, because the user's own keystrokes moved it.
    //
    // Deliberately not carrying an attachment difference: that would let the
    // draft-id clause carry the assertion and leave the revision clause
    // untested, which is exactly the shape a mutation of that clause would
    // survive.
    const textOnly: RestoredDraftMarker = { ...marker, draftIds: [] };
    const retyped = {
      ...untouched,
      text: marker.text,
      draftIds: [] as readonly string[],
      valueRevision: marker.valueRevision + 5,
    };
    expect(retyped.text).toBe(textOnly.text);
    expect(retyped.draftIds).toEqual(textOnly.draftIds);
    expect(shouldRevokeRestoredDraft(textOnly, retyped)).toBe(false);

    // The same discipline with attachments in play: re-pasted images get fresh
    // ids from the monotonic sequence, so identity separates them too.
    expect(
      shouldRevokeRestoredDraft(marker, {
        ...untouched,
        text: marker.text,
        valueRevision: 12,
        draftIds: ['att-c', 'att-d'],
      })
    ).toBe(false);
  });

  it('[D-3] a matching revision with mismatched text is still a veto — an unknown writer means stop', () => {
    expect(shouldRevokeRestoredDraft(marker, { ...untouched, text: 'something else' })).toBe(false);
  });

  it('[D-2] never reaches across sessions', () => {
    expect(shouldRevokeRestoredDraft(marker, { ...untouched, sessionId: 's2' })).toBe(false);
  });

  it('[D-2] a text-only restore (no attachments) is handled by the same rule', () => {
    const textOnly: RestoredDraftMarker = { ...marker, draftIds: [] };
    expect(shouldRevokeRestoredDraft(textOnly, { ...untouched, draftIds: [] })).toBe(true);
    // The user attached something afterwards — no longer purely ours.
    expect(shouldRevokeRestoredDraft(textOnly, { ...untouched, draftIds: ['att-z'] })).toBe(false);
  });
});
