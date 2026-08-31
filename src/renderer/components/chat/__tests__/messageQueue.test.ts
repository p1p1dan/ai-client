import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTACHMENT_LIMITS } from '../attachmentLimits';
import type { AttachmentDraft } from '../attachments';
import {
  clearPause,
  createEmptyState,
  DEFAULT_ENQUEUE_LIMITS,
  enqueue,
  type MessageQueueState,
  moveEntry,
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

  // Stop-hang fix (2026-08-10) — this REPLACES m2's "a non-empty bucket keeps
  // its pause". The queue semantics are now stated as one rule: **Stop
  // freezes the queue; the user's next message thaws it.** m2's version only
  // thawed an EMPTY bucket, which made the interesting case the broken one —
  // Stop with messages already queued left a `'stopped'` pause that only an
  // explicit Resume could clear, so those messages sat frozen while the user
  // kept typing into a composer that showed no sign anything was stuck.
  // Enqueuing IS the user pushing the flow forward again (the same reading of
  // decision 3.4 that `shouldClearPauseOnSend` already applies to a direct
  // Send, which is what the same keystroke does once status has settled).
  it('clears a STOPPED pause when admitting into a NON-EMPTY bucket (Stop freezes, the next message thaws)', () => {
    let state = createEmptyState();
    const first = enqueue(state, message({ sessionId: 's1' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = pauseSession(first.state, 's1');
    expect(selectSessionQueue(state, 's1').paused).toBe('stopped');

    const second = enqueue(state, message({ sessionId: 's1' }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(selectSessionQueue(second.state, 's1').paused).toBeNull();
    expect(selectSessionQueue(second.state, 's1').entries).toHaveLength(2);
  });

  // The counter-example, and the reason this is scoped to `'stopped'` rather
  // than "clear any pause": a `'send-rejected'` pause is the queue layer's own
  // protection against re-releasing a head entry the Host just REFUSED
  // (`shouldPauseQueueOnRejection`). A follow-up message is not evidence the
  // Host changed its mind, so clearing it here would restart exactly the
  // restore→re-release livelock S1 closed. It stays until a direct Send
  // (`shouldClearPauseOnSend`) or an explicit Resume.
  it('preserves a SEND-REJECTED pause when admitting into a NON-EMPTY bucket', () => {
    let state = createEmptyState();
    const first = enqueue(state, message({ sessionId: 's1' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = pauseSession(first.state, 's1', 'send-rejected');

    const second = enqueue(state, message({ sessionId: 's1' }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(selectSessionQueue(second.state, 's1').paused).toBe('send-rejected');
    expect(selectSessionQueue(second.state, 's1').entries).toHaveLength(2);
  });

  // A rejected admission changes nothing — including the pause. The queue
  // must not be thawed by a message it refused to take (decision 7: the text
  // stays in the textarea, so the user has not actually handed anything over).
  it('leaves a stopped pause untouched when the admission is REJECTED', () => {
    let state = createEmptyState();
    const first = enqueue(state, message({ sessionId: 's1' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = pauseSession(first.state, 's1');

    const rejected = enqueue(state, message({ sessionId: 's1', text: '   ', attachments: [] }));
    expect(rejected.ok).toBe(false);
    expect(rejected.state).toBe(state);
    expect(selectSessionQueue(rejected.state, 's1').paused).toBe('stopped');
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

  it('does not recreate a bucket removed by lifecycle pruning', () => {
    const state = createEmptyState();
    const entry = message({ sessionId: 's1' });
    const restored = restoreHead(state, entry);
    expect(restored).toBe(state);
    expect(selectSessionQueue(restored, 's1').entries).toEqual([]);
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

describe('moveEntry', () => {
  function seedState(): { state: MessageQueueState; entries: QueuedMessage[] } {
    let state = createEmptyState();
    const entries = [
      message({ sessionId: 's1', text: 'first' }),
      message({ sessionId: 's1', text: 'second' }),
      message({ sessionId: 's1', text: 'third' }),
    ];
    for (const entry of entries) {
      const result = enqueue(state, entry);
      if (result.ok) state = result.state;
    }
    return { state, entries };
  }

  it('exchanges an entry with its previous neighbour', () => {
    const { state, entries } = seedState();
    const next = moveEntry(state, 's1', entries[1].id, 'up');
    expect(selectSessionQueue(next, 's1').entries).toEqual([entries[1], entries[0], entries[2]]);
  });

  it('exchanges an entry with its next neighbour without changing payload identity', () => {
    const { state, entries } = seedState();
    const next = moveEntry(state, 's1', entries[1].id, 'down');
    expect(selectSessionQueue(next, 's1').entries).toEqual([entries[0], entries[2], entries[1]]);
    expect(selectSessionQueue(next, 's1').entries[2]).toBe(entries[1]);
  });

  it('returns the same state for boundary, unknown entry and unknown session moves', () => {
    const { state, entries } = seedState();
    expect(moveEntry(state, 's1', entries[0].id, 'up')).toBe(state);
    expect(moveEntry(state, 's1', entries[2].id, 'down')).toBe(state);
    expect(moveEntry(state, 's1', 'missing', 'up')).toBe(state);
    expect(moveEntry(state, 'missing', entries[1].id, 'down')).toBe(state);
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
  function queuedState(sessionId = 's1'): MessageQueueState {
    const result = enqueue(createEmptyState(), message({ sessionId }));
    if (!result.ok) throw new Error(result.message);
    return result.state;
  }

  it('sets the pause reason on a session bucket with waiting entries', () => {
    const state = pauseSession(queuedState(), 's1');
    expect(selectSessionQueue(state, 's1').paused).toBe('stopped');
  });

  it('does not create an empty bucket merely to record a pause', () => {
    const state = createEmptyState();
    expect(pauseSession(state, 's1')).toBe(state);
  });

  it('is idempotent: pausing an already-paused session with the same reason returns the same reference', () => {
    const first = pauseSession(queuedState(), 's1');
    const second = pauseSession(first, 's1');
    expect(second).toBe(first);
  });

  it('pauses sessions independently', () => {
    const state = pauseSession(queuedState(), 's1');
    expect(selectSessionQueue(state, 's2').paused).toBeNull();
  });

  it('clears the pause reason', () => {
    const paused = pauseSession(queuedState(), 's1');
    const cleared = clearPause(paused, 's1');
    expect(selectSessionQueue(cleared, 's1').paused).toBeNull();
  });

  // S1 (round-2 iteration-3 review; generalized from R4's `session_busy`-only
  // version): a distinct pause reason for EVERY evidence-free release-origin
  // rejection, so the queue does not hammer the Host in an unbounded loop —
  // see ChatComposer.tsx's `finalizeOutcome` / queueRelease.ts's
  // `shouldPauseQueueOnRejection`.
  it('accepts the "send-rejected" reason and reports it distinctly from "stopped"', () => {
    const state = pauseSession(queuedState(), 's1', 'send-rejected');
    expect(selectSessionQueue(state, 's1').paused).toBe('send-rejected');
  });

  it('pausing with a DIFFERENT reason while already paused still updates (not idempotent across reasons)', () => {
    const stopped = pauseSession(queuedState(), 's1', 'stopped');
    const sendRejected = pauseSession(stopped, 's1', 'send-rejected');
    expect(sendRejected).not.toBe(stopped);
    expect(selectSessionQueue(sendRejected, 's1').paused).toBe('send-rejected');
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

describe('memory-only product contract', () => {
  it('the queue store has no persistence or browser-storage dependency', () => {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.resolve(dirname, '../../../stores/messageQueue.ts'), 'utf8');
    expect(source).not.toContain('persist(');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('electronStorage');
    expect(createEmptyState()).toEqual({ bySession: {} });
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
