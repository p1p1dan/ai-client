import type { ExtensionUiCancelReason, RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  currentExtensionUiDialog,
  type ExtensionUiState,
  initialExtensionUi,
  reduceExtensionUi,
  removeExtensionUiDialog,
} from '../extensionUiModel';

/**
 * T08 — the pending-dialog fold.
 *
 * The extension on the other end is BLOCKED on each of these. The two failures
 * that matter: a dialog that never appears (its turn hangs with nothing on
 * screen) and one that stays up after the Host settled it (the user answers into
 * the void). Everything below is one of those two.
 */

let seq = 0;

function requestEvent(
  overrides: {
    uiRequestId?: string;
    runtimeId?: string;
    sessionId?: string;
    method?: string;
    args?: unknown;
  } = {}
): RuntimeEvent {
  seq += 1;
  return {
    type: 'extensionUi.request',
    seq,
    timestamp: 1_000 + seq,
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    payload: {
      runtimeId: overrides.runtimeId ?? 'rt-1',
      uiRequestId: overrides.uiRequestId ?? `q-${seq}`,
      method: (overrides.method ?? 'select') as 'select',
      // `in` and not `??` — `args: null` is a case under test, not an omission.
      args: 'args' in overrides ? overrides.args : { title: 'Pick', options: ['a', 'b'] },
    },
  } as RuntimeEvent;
}

function cancelEvent(uiRequestIds: string[], reason: ExtensionUiCancelReason): RuntimeEvent {
  seq += 1;
  return {
    type: 'extensionUi.cancelled',
    seq,
    timestamp: 2_000 + seq,
    payload: { runtimeId: 'rt-1', uiRequestIds, reason },
  } as RuntimeEvent;
}

const feed = (events: RuntimeEvent[], from: ExtensionUiState = initialExtensionUi) =>
  events.reduce(reduceExtensionUi, from);

describe('queuing requests', () => {
  it('queues a readable dialog with its routing identity', () => {
    const state = feed([requestEvent({ uiRequestId: 'q1', runtimeId: 'rt-9', sessionId: 's1' })]);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({
      runtimeId: 'rt-9',
      uiRequestId: 'q1',
      sessionId: 's1',
      dialog: { method: 'select', title: 'Pick', options: ['a', 'b'] },
    });
  });

  /**
   * An extension asking during bind has no session yet. The key must be ABSENT
   * rather than undefined-valued, so a consumer filtering by session cannot
   * accidentally match it.
   */
  it('omits sessionId when the extension asked outside a turn', () => {
    const state = feed([requestEvent({ uiRequestId: 'q1' })]);
    expect('sessionId' in (state.pending[0] ?? {})).toBe(false);
  });

  /**
   * Two extensions can ask at once, and one can ask again before the first
   * answer. Dropping the second would hang whoever sent it.
   */
  it('keeps concurrent dialogs in arrival order', () => {
    const state = feed([
      requestEvent({ uiRequestId: 'q1' }),
      requestEvent({
        uiRequestId: 'q2',
        method: 'confirm',
        args: { title: 'Sure?', message: 'y' },
      }),
    ]);
    expect(state.pending.map((p) => p.uiRequestId)).toEqual(['q1', 'q2']);
    expect(currentExtensionUiDialog(state)?.uiRequestId).toBe('q1');
  });

  it('ignores a duplicate request id', () => {
    const once = feed([requestEvent({ uiRequestId: 'q1' })]);
    const twice = reduceExtensionUi(once, requestEvent({ uiRequestId: 'q1' }));
    expect(twice).toBe(once);
  });
});

describe('requests that must not open a dialog', () => {
  /**
   * These are display state (T09), not questions. Nothing is awaiting them, so a
   * modal would never be closed by an answer.
   */
  it('ignores fire-and-forget display methods', () => {
    for (const method of ['notify', 'setStatus', 'setTitle', 'unsupported']) {
      const state = feed([requestEvent({ method, args: { title: 'x', message: 'y' } })]);
      expect(state).toBe(initialExtensionUi);
    }
  });

  /**
   * We cannot draw it, so we show nothing — and we must NOT answer for the user
   * either. The Host's bridge settles it with the fallback that matches the
   * method, which is the only place that knows a dismissed confirm is a refusal.
   */
  it('ignores a dialog whose args cannot be drawn', () => {
    expect(feed([requestEvent({ args: { title: 'Pick', options: [] } })])).toBe(initialExtensionUi);
    expect(feed([requestEvent({ args: { options: ['a'] } })])).toBe(initialExtensionUi);
    expect(feed([requestEvent({ args: null })])).toBe(initialExtensionUi);
  });

  it('returns the same state object for unrelated events', () => {
    const unrelated = {
      type: 'message.delta',
      seq: 99,
      timestamp: 1,
      sessionId: 's1',
      payload: { messageId: 'm1', blockId: 'b1', text: 'hi' },
    } as RuntimeEvent;
    const state = feed([requestEvent({ uiRequestId: 'q1' })]);
    expect(reduceExtensionUi(state, unrelated)).toBe(state);
  });
});

describe('cancellation', () => {
  it('closes the dialogs the bridge settled without us', () => {
    const state = feed([
      requestEvent({ uiRequestId: 'q1' }),
      requestEvent({ uiRequestId: 'q2' }),
      requestEvent({ uiRequestId: 'q3' }),
      cancelEvent(['q1', 'q3'], 'timed_out'),
    ]);
    expect(state.pending.map((p) => p.uiRequestId)).toEqual(['q2']);
  });

  it('handles a session swap that closes everything', () => {
    const state = feed([
      requestEvent({ uiRequestId: 'q1' }),
      requestEvent({ uiRequestId: 'q2' }),
      cancelEvent(['q1', 'q2'], 'session_replaced'),
    ]);
    expect(state.pending).toEqual([]);
  });

  it('is a no-op for ids it is not showing', () => {
    const state = feed([requestEvent({ uiRequestId: 'q1' })]);
    expect(reduceExtensionUi(state, cancelEvent(['other'], 'host_shutdown'))).toBe(state);
  });
});

describe('removeExtensionUiDialog', () => {
  it('drops the answered dialog and promotes the next', () => {
    const state = feed([requestEvent({ uiRequestId: 'q1' }), requestEvent({ uiRequestId: 'q2' })]);
    const next = removeExtensionUiDialog(state, 'q1');
    expect(next.pending.map((p) => p.uiRequestId)).toEqual(['q2']);
    expect(currentExtensionUiDialog(next)?.uiRequestId).toBe('q2');
  });

  it('returns the same state when the id is not queued', () => {
    const state = feed([requestEvent({ uiRequestId: 'q1' })]);
    expect(removeExtensionUiDialog(state, 'gone')).toBe(state);
  });

  it('reports no current dialog when the queue empties', () => {
    const state = feed([requestEvent({ uiRequestId: 'q1' })]);
    expect(currentExtensionUiDialog(removeExtensionUiDialog(state, 'q1'))).toBeUndefined();
  });
});
