import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTACHMENT_LIMITS } from '../attachmentLimits';
import type { AttachmentDraft } from '../attachments';
import {
  clearPause,
  createEmptyState,
  DEFAULT_ENQUEUE_LIMITS,
  enqueue,
  type MessageQueueState,
  pauseSession,
  pruneSessions,
  type QueuedMessage,
  removeEntry,
  restoreHead,
  selectSessionQueue,
  takeEntryIntoDraft,
  takeHead,
} from '../messageQueue';

let seq = 0;
function draft(overrides: Partial<AttachmentDraft> = {}): AttachmentDraft {
  seq += 1;
  return {
    id: `att-${seq}`,
    kind: 'text',
    mediaType: 'text/plain',
    name: `file-${seq}.txt`,
    byteLength: 10,
    data: 'hello',
    ...overrides,
  };
}

function message(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  seq += 1;
  return {
    id: `q-${seq}`,
    sessionId: 's1',
    text: `message ${seq}`,
    attachments: [],
    queuedAt: seq,
    ...overrides,
  };
}

describe('enqueue', () => {
  it('admits the first message into an empty session bucket', () => {
    const state = createEmptyState();
    const m = message();
    const result = enqueue(state, m);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(selectSessionQueue(result.state, 's1').entries).toEqual([m]);
  });

  it('keeps FIFO order across multiple admissions', () => {
    let state = createEmptyState();
    const a = message({ sessionId: 's1' });
    const b = message({ sessionId: 's1' });
    const c = message({ sessionId: 's1' });
    for (const m of [a, b, c]) {
      const result = enqueue(state, m);
      expect(result.ok).toBe(true);
      if (result.ok) state = result.state;
    }
    expect(selectSessionQueue(state, 's1').entries.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it('keeps two sessions independent', () => {
    let state = createEmptyState();
    const a = message({ sessionId: 's1' });
    const b = message({ sessionId: 's2' });
    for (const m of [a, b]) {
      const result = enqueue(state, m);
      if (result.ok) state = result.state;
    }
    expect(selectSessionQueue(state, 's1').entries).toEqual([a]);
    expect(selectSessionQueue(state, 's2').entries).toEqual([b]);
  });

  it('returns a new top-level state reference on success', () => {
    const state = createEmptyState();
    const result = enqueue(state, message());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).not.toBe(state);
  });

  it('rejects a 21st entry once the per-session cap of 20 is reached, state unchanged', () => {
    let state = createEmptyState();
    for (let i = 0; i < 20; i += 1) {
      const result = enqueue(state, message({ sessionId: 's1' }));
      if (result.ok) state = result.state;
    }
    const before = state;
    const result = enqueue(state, message({ sessionId: 's1' }));
    expect(result).toMatchObject({ ok: false, reason: 'too-many' });
    if (result.ok) return;
    expect(result.message).toMatch(/20/);
    expect(result.state).toBe(before);
  });

  it('rejects an entry that would push the queue past the total attachment byte budget, state unchanged', () => {
    const state = createEmptyState();
    const big = draft({ byteLength: DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes + 1 });
    const result = enqueue(state, message({ attachments: [big] }));
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
    if (result.ok) return;
    expect(result.state).toBe(state);
  });

  it('accumulates attachment bytes across entries already in the queue when checking the budget', () => {
    let state = createEmptyState();
    const half = DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes / 2 + 1;
    const first = enqueue(state, message({ attachments: [draft({ byteLength: half })] }));
    expect(first.ok).toBe(true);
    if (first.ok) state = first.state;
    const before = state;
    const second = enqueue(state, message({ attachments: [draft({ byteLength: half })] }));
    expect(second).toMatchObject({ ok: false, reason: 'too-large' });
    if (second.ok) return;
    expect(second.state).toBe(before);
  });

  it('rejects a message with empty text and no attachments, state unchanged', () => {
    const state = createEmptyState();
    const result = enqueue(state, message({ text: '   ', attachments: [] }));
    expect(result).toMatchObject({ ok: false, reason: 'empty' });
    if (result.ok) return;
    expect(result.state).toBe(state);
  });

  it('clears an active pause on a successful admission into an EMPTY bucket', () => {
    let state = createEmptyState();
    state = pauseSession(state, 's1');
    expect(selectSessionQueue(state, 's1').paused).toBe('stopped');
    const result = enqueue(state, message({ sessionId: 's1' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(selectSessionQueue(result.state, 's1').paused).toBeNull();
  });

  // m2 fix: enqueuing a follow-up while paused is not "a new turn starting"
  // (decision 3.4 reserves pause-clearing for Send/Retry/explicit Resume) —
  // only an EMPTY, invisible-in-the-strip paused bucket needed the auto-clear
  // above. A non-empty bucket must keep its pause, or Stop-ing a queue and
  // then typing one more follow-up before status settles would silently
  // release the WHOLE stopped queue the instant it does.
  it('preserves an active pause when admitting into a NON-EMPTY bucket', () => {
    let state = createEmptyState();
    const first = enqueue(state, message({ sessionId: 's1' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = pauseSession(first.state, 's1');
    expect(selectSessionQueue(state, 's1').paused).toBe('stopped');

    const second = enqueue(state, message({ sessionId: 's1' }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(selectSessionQueue(second.state, 's1').paused).toBe('stopped');
    expect(selectSessionQueue(second.state, 's1').entries).toHaveLength(2);
  });

  it('exposes the default limits used when none are passed explicitly', () => {
    expect(DEFAULT_ENQUEUE_LIMITS.maxEntries).toBe(20);
    expect(DEFAULT_ENQUEUE_LIMITS.maxTotalBytes).toBe(DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes);
  });
});

describe('takeHead', () => {
  it('returns the head entry and removes it from the bucket', () => {
    let state = createEmptyState();
    const a = message({ sessionId: 's1' });
    const b = message({ sessionId: 's1' });
    for (const m of [a, b]) {
      const result = enqueue(state, m);
      if (result.ok) state = result.state;
    }
    const { state: next, entry } = takeHead(state, 's1');
    expect(entry).toEqual(a);
    expect(selectSessionQueue(next, 's1').entries).toEqual([b]);
  });

  it('returns null and the same state reference for an empty queue', () => {
    const state = createEmptyState();
    const result = takeHead(state, 's1');
    expect(result.entry).toBeNull();
    expect(result.state).toBe(state);
  });

  it('returns null and the same state reference for an unknown session', () => {
    const state = createEmptyState();
    const result = takeHead(state, 'unknown');
    expect(result.entry).toBeNull();
    expect(result.state).toBe(state);
  });

  it('only ever takes one entry per call', () => {
    let state = createEmptyState();
    for (let i = 0; i < 3; i += 1) {
      const result = enqueue(state, message({ sessionId: 's1' }));
      if (result.ok) state = result.state;
    }
    const { state: next } = takeHead(state, 's1');
    expect(selectSessionQueue(next, 's1').entries).toHaveLength(2);
  });
});

describe('restoreHead', () => {
  it('puts the entry back at the front of its own session bucket', () => {
    let state = createEmptyState();
    const a = message({ sessionId: 's1' });
    const b = message({ sessionId: 's1' });
    for (const m of [a, b]) {
      const result = enqueue(state, m);
      if (result.ok) state = result.state;
    }
    const { state: afterTake, entry } = takeHead(state, 's1');
    expect(entry).not.toBeNull();
    const restored = restoreHead(afterTake, entry as QueuedMessage);
    expect(selectSessionQueue(restored, 's1').entries.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('preserves the order of the remaining entries', () => {
    let state = createEmptyState();
    const a = message({ sessionId: 's1' });
    const b = message({ sessionId: 's1' });
    const c = message({ sessionId: 's1' });
    for (const m of [a, b, c]) {
      const result = enqueue(state, m);
      if (result.ok) state = result.state;
    }
    const { state: afterTake, entry } = takeHead(state, 's1');
    const restored = restoreHead(afterTake, entry as QueuedMessage);
    expect(selectSessionQueue(restored, 's1').entries.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it('works even when the target bucket does not exist yet', () => {
    const state = createEmptyState();
    const entry = message({ sessionId: 's1' });
    const restored = restoreHead(state, entry);
    expect(selectSessionQueue(restored, 's1').entries).toEqual([entry]);
  });
});

describe('removeEntry', () => {
  it('removes the matching entry', () => {
    let state = createEmptyState();
    const a = message({ sessionId: 's1' });
    const b = message({ sessionId: 's1' });
    for (const m of [a, b]) {
      const result = enqueue(state, m);
      if (result.ok) state = result.state;
    }
    const next = removeEntry(state, 's1', a.id);
    expect(selectSessionQueue(next, 's1').entries).toEqual([b]);
  });

  it('returns the same state reference when the id is not found', () => {
    let state = createEmptyState();
    const result = enqueue(state, message({ sessionId: 's1' }));
    if (result.ok) state = result.state;
    const next = removeEntry(state, 's1', 'missing-id');
    expect(next).toBe(state);
  });

  it('returns the same state reference for an unknown session', () => {
    const state = createEmptyState();
    const next = removeEntry(state, 'unknown', 'missing-id');
    expect(next).toBe(state);
  });
});

describe('takeEntryIntoDraft', () => {
  function seedState(): { state: MessageQueueState; a: QueuedMessage; b: QueuedMessage } {
    let state = createEmptyState();
    const a = message({ sessionId: 's1', text: 'first' });
    const b = message({ sessionId: 's1', text: 'second' });
    for (const m of [a, b]) {
      const result = enqueue(state, m);
      if (result.ok) state = result.state;
    }
    return { state, a, b };
  }

  it('moves the entry out of the queue when the current draft is empty', () => {
    const { state, a, b } = seedState();
    const { state: next, result } = takeEntryIntoDraft(state, 's1', a.id, {
      text: '',
      attachments: [],
    });
    expect(result).toEqual({ type: 'moved', payload: { text: 'first', attachments: [] } });
    expect(selectSessionQueue(next, 's1').entries).toEqual([b]);
  });

  it('swaps in place when the current draft is non-empty, index unchanged', () => {
    const { state, a, b } = seedState();
    const { state: next, result } = takeEntryIntoDraft(state, 's1', a.id, {
      text: 'draft text',
      attachments: [],
    });
    expect(result).toEqual({ type: 'swapped', payload: { text: 'first', attachments: [] } });
    const entries = selectSessionQueue(next, 's1').entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: a.id, text: 'draft text' });
    expect(entries[1]).toEqual(b);
  });

  it('swaps attachments along with the text', () => {
    const { state, a } = seedState();
    const incoming = [draft()];
    const { state: next, result } = takeEntryIntoDraft(state, 's1', a.id, {
      text: 'draft text',
      attachments: incoming,
    });
    if (result?.type !== 'swapped') throw new Error('expected swapped result');
    expect(result.payload.attachments).toEqual([]);
    const entries = selectSessionQueue(next, 's1').entries;
    expect(entries[0].attachments).toBe(incoming);
  });

  // T-19 fix review (m12 — B1's root cause had zero coverage): the swap
  // branch clears any prior `failure` on the entry ("the swapped-in content
  // has never been sent" — see this function's own doc comment). This
  // behavior is dormant in production today (nothing writes `.failure` onto
  // a live entry anymore, see `queueRelease.ts`'s header), but it is exactly
  // the mechanic B1 exploited when it was live, so it must stay covered for
  // whichever future change (T-19b) re-introduces queue-based failures.
  it('clears a prior failure on swap — the swapped-in content has never been sent', () => {
    let state = createEmptyState();
    const failed = message({ sessionId: 's1', text: 'first', failure: { message: 'boom' } });
    const admitted = enqueue(state, failed);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    state = admitted.state;

    const { state: next, result } = takeEntryIntoDraft(state, 's1', failed.id, {
      text: 'draft text',
      attachments: [],
    });
    expect(result).toEqual({ type: 'swapped', payload: { text: 'first', attachments: [] } });
    const entries = selectSessionQueue(next, 's1').entries;
    expect(entries[0]).toMatchObject({ id: failed.id, text: 'draft text', failure: undefined });
  });

  // m6 fix: swap used to write `currentDraft.text` verbatim while `enqueue`'s
  // caller (`handleSend`) always trims — a swapped-in entry could carry
  // leading/trailing whitespace that later shipped verbatim via
  // `runSend(entry.text, …)`, the only queue text that skipped trimming.
  it('trims the incoming draft text on swap', () => {
    const { state, a } = seedState();
    const { state: next } = takeEntryIntoDraft(state, 's1', a.id, {
      text: '  draft text with padding  ',
      attachments: [],
    });
    const entries = selectSessionQueue(next, 's1').entries;
    expect(entries[0].text).toBe('draft text with padding');
  });

  it('returns null and the same state reference for an unknown id', () => {
    const { state } = seedState();
    const outcome = takeEntryIntoDraft(state, 's1', 'missing-id', { text: '', attachments: [] });
    expect(outcome.result).toBeNull();
    expect(outcome.state).toBe(state);
  });

  it('returns null and the same state reference for an unknown session', () => {
    const state = createEmptyState();
    const outcome = takeEntryIntoDraft(state, 'unknown', 'missing-id', {
      text: '',
      attachments: [],
    });
    expect(outcome.result).toBeNull();
    expect(outcome.state).toBe(state);
  });
});

describe('pauseSession / clearPause', () => {
  it('sets the pause reason on the session bucket', () => {
    const state = pauseSession(createEmptyState(), 's1');
    expect(selectSessionQueue(state, 's1').paused).toBe('stopped');
  });

  it('is idempotent: pausing an already-paused session with the same reason returns the same reference', () => {
    const first = pauseSession(createEmptyState(), 's1');
    const second = pauseSession(first, 's1');
    expect(second).toBe(first);
  });

  it('pauses sessions independently', () => {
    let state = createEmptyState();
    state = pauseSession(state, 's1');
    expect(selectSessionQueue(state, 's2').paused).toBeNull();
  });

  it('clears the pause reason', () => {
    const paused = pauseSession(createEmptyState(), 's1');
    const cleared = clearPause(paused, 's1');
    expect(selectSessionQueue(cleared, 's1').paused).toBeNull();
  });

  it('clearPause is a no-op (same reference) when already unpaused', () => {
    const state = createEmptyState();
    expect(clearPause(state, 's1')).toBe(state);
  });

  it('clearPause is a no-op for an unknown session', () => {
    const state = createEmptyState();
    expect(clearPause(state, 'unknown')).toBe(state);
  });
});

describe('pruneSessions', () => {
  it('drops buckets for sessions that no longer exist', () => {
    let state = createEmptyState();
    const a = message({ sessionId: 's1' });
    const b = message({ sessionId: 's2' });
    for (const m of [a, b]) {
      const result = enqueue(state, m);
      if (result.ok) state = result.state;
    }
    const pruned = pruneSessions(state, ['s1']);
    expect(selectSessionQueue(pruned, 's1').entries).toEqual([a]);
    expect(selectSessionQueue(pruned, 's2').entries).toEqual([]);
  });

  it('returns the same state reference when every bucket is still live', () => {
    let state = createEmptyState();
    const result = enqueue(state, message({ sessionId: 's1' }));
    if (result.ok) state = result.state;
    expect(pruneSessions(state, ['s1', 's2'])).toBe(state);
  });
});

describe('selectSessionQueue', () => {
  it('returns a stable empty-array reference for an unknown session', () => {
    const state = createEmptyState();
    const first = selectSessionQueue(state, 'unknown');
    const second = selectSessionQueue(state, 'also-unknown');
    expect(first.entries).toEqual([]);
    expect(first.entries).toBe(second.entries);
  });

  it('returns a stable empty-array reference for a null session id', () => {
    const state = createEmptyState();
    expect(selectSessionQueue(state, null).entries).toEqual([]);
  });
});
