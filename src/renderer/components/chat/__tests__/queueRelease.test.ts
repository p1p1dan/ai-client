import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { QueuedMessage } from '../messageQueue';
import {
  type ActionButtonKind,
  type CanStartTurnInput,
  canStartTurn,
  type DecideSendActionInput,
  decidePendingResolution,
  decideQueueRelease,
  decideSendAction,
  deriveActionButtons,
  deriveQueueStripModel,
  isRunningStatus,
  QUEUE_PERMISSION_HINT,
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

  it('shows the paused caption with the waiting count when paused', () => {
    const model = deriveQueueStripModel({
      entries: [entry({ id: 'q-1' }), entry({ id: 'q-2' })],
      paused: 'stopped',
      hasPendingPermissionHere: false,
    });
    expect(model.pausedLabel).toBe('Queue paused — 2 waiting');
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
