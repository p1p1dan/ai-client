import type { ExtensionUiCancelReason, RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  currentExtensionUiDialog,
  currentExtensionUiDialogForSession,
  currentUnscopedExtensionUiDialog,
  type ExtensionUiState,
  extensionUiPendingCountForSession,
  failExtensionUiSend,
  initialExtensionUi,
  markExtensionUiSending,
  reduceExtensionUi,
  removeExtensionUiDialog,
  splitExtensionUiDialogText,
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

function cancelEvent(
  uiRequestIds: string[],
  reason: ExtensionUiCancelReason,
  runtimeId = 'rt-1'
): RuntimeEvent {
  seq += 1;
  return {
    type: 'extensionUi.cancelled',
    seq,
    timestamp: 2_000 + seq,
    payload: { runtimeId, uiRequestIds, reason },
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

  it('selects independent FIFO heads for active and background sessions', () => {
    const state = feed([
      requestEvent({ uiRequestId: 'a1', sessionId: 'a' }),
      requestEvent({ uiRequestId: 'b1', sessionId: 'b' }),
      requestEvent({ uiRequestId: 'a2', sessionId: 'a' }),
    ]);

    expect(currentExtensionUiDialogForSession(state, 'a')?.uiRequestId).toBe('a1');
    expect(currentExtensionUiDialogForSession(state, 'b')?.uiRequestId).toBe('b1');
    expect(extensionUiPendingCountForSession(state.pending, 'a')).toBe(2);
    expect(extensionUiPendingCountForSession(state.pending, 'b')).toBe(1);
    expect(currentExtensionUiDialogForSession(state, 'missing')).toBeUndefined();
  });

  it('keeps session-less bind requests on the exceptional fallback only', () => {
    const state = feed([
      requestEvent({ uiRequestId: 'scoped', sessionId: 'a' }),
      requestEvent({ uiRequestId: 'unscoped' }),
    ]);
    expect(currentUnscopedExtensionUiDialog(state)?.uiRequestId).toBe('unscoped');
    expect(currentExtensionUiDialogForSession(state, 'a')?.uiRequestId).toBe('scoped');
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

  /**
   * Every session has its own bridge, so ids are only unique WITHIN one. A
   * cancellation matched on the id alone would let session A close session B's
   * live dialog — and B's extension would then wait for an answer that can no
   * longer be given.
   */
  it('ignores a cancellation from a different bridge', () => {
    const state = feed([requestEvent({ uiRequestId: 'q1', runtimeId: 'rt-a' })]);
    expect(reduceExtensionUi(state, cancelEvent(['q1'], 'aborted', 'rt-b'))).toBe(state);
  });

  it('closes only the matching bridge’s dialog when both share an id', () => {
    const state = feed([
      requestEvent({ uiRequestId: 'same', runtimeId: 'rt-a' }),
      requestEvent({ uiRequestId: 'same', runtimeId: 'rt-b' }),
    ]);
    // Two entries with the same id but different bridges: the duplicate guard is
    // per id, so only the first survives queueing — which is itself the reason
    // the cancel path must not key on the id alone.
    const next = reduceExtensionUi(state, cancelEvent(['same'], 'aborted', 'rt-b'));
    expect(next).toBe(state);
  });

  it('clears any send state for the dialogs it closes', () => {
    const queued = feed([requestEvent({ uiRequestId: 'q1' })]);
    const sending = markExtensionUiSending(queued, 'q1');
    const failed = failExtensionUiSend(sending, 'q1', 'ipc down');

    const next = reduceExtensionUi(failed, cancelEvent(['q1'], 'host_shutdown'));
    expect(next.pending).toEqual([]);
    expect(next.sending).toEqual([]);
    expect(next.sendErrors).toEqual({});
  });
});

/**
 * The dialog stays on screen until the Host has actually been told. It used to
 * be removed the moment a button was pressed, so a rejected IPC left nothing on
 * screen and an extension parked forever — a turn that never ends, with no way
 * for the user to see it or retry.
 */
describe('send tracking', () => {
  it('marks an answer in flight and clears any earlier error', () => {
    const state = failExtensionUiSend(feed([requestEvent({ uiRequestId: 'q1' })]), 'q1', 'boom');
    const sending = markExtensionUiSending(state, 'q1');
    expect(sending.sending).toEqual(['q1']);
    expect(sending.sendErrors).toEqual({});
    // The dialog is still up — that is the whole point.
    expect(sending.pending.map((p) => p.uiRequestId)).toEqual(['q1']);
  });

  it('refuses to mark the same answer twice', () => {
    const sending = markExtensionUiSending(feed([requestEvent({ uiRequestId: 'q1' })]), 'q1');
    expect(markExtensionUiSending(sending, 'q1')).toBe(sending);
  });

  it('keeps the dialog and records why when the send fails', () => {
    const sending = markExtensionUiSending(feed([requestEvent({ uiRequestId: 'q1' })]), 'q1');
    const failed = failExtensionUiSend(sending, 'q1', 'ipc down');
    expect(failed.pending.map((p) => p.uiRequestId)).toEqual(['q1']);
    expect(failed.sendErrors).toEqual({ q1: 'ipc down' });
    // Released, or the retry would be refused as a double-click.
    expect(failed.sending).toEqual([]);
  });

  it('clears send state when the dialog finally closes', () => {
    const sending = markExtensionUiSending(feed([requestEvent({ uiRequestId: 'q1' })]), 'q1');
    const closed = removeExtensionUiDialog(failExtensionUiSend(sending, 'q1', 'x'), 'q1');
    expect(closed.pending).toEqual([]);
    expect(closed.sending).toEqual([]);
    expect(closed.sendErrors).toEqual({});
  });
});

/**
 * T08-b — `ui.select` has ONE text slot, so an extension with more to say packs
 * it in with newlines. `@gotgenes/pi-permission-system` calls
 * `ui.select(`${title}\n${renderedBody}`, …)`, and that body is the entire basis
 * on which someone approves or denies a tool call.
 */
describe('splitExtensionUiDialogText', () => {
  it('leaves an ordinary single-line title alone', () => {
    expect(splitExtensionUiDialogText('Pick a branch')).toEqual({ heading: 'Pick a branch' });
  });

  it('splits the permission prompt into a heading and its rendered body', () => {
    const parsed = splitExtensionUiDialogText(
      ['Allow bash?', 'Tool: bash', 'Command: rm -rf /tmp/build', 'Paths:', '  /tmp/build'].join(
        '\n'
      )
    );
    expect(parsed.heading).toBe('Allow bash?');
    expect(parsed.body).toBe('Tool: bash\nCommand: rm -rf /tmp/build\nPaths:\n  /tmp/build');
  });

  /** The body is laid out for a terminal: its own blank lines are structure. */
  it('keeps interior blank lines but trims the row-budget padding at the end', () => {
    const parsed = splitExtensionUiDialogText('Heading\nfirst\n\nsecond\n\n   \n');
    expect(parsed.body).toBe('first\n\nsecond');
  });

  it('reports no body when only padding followed the heading', () => {
    expect(splitExtensionUiDialogText('Heading\n\n  \n')).toEqual({ heading: 'Heading' });
  });

  it('tolerates an empty heading rather than losing the body', () => {
    expect(splitExtensionUiDialogText('\nbody text')).toEqual({ heading: '', body: 'body text' });
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
