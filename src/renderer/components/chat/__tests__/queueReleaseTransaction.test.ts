import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyState,
  enqueue,
  pauseSession,
  prioritizeEntry,
  pruneSessions,
  type QueuedMessage,
  restoreHead,
  selectSessionQueue,
  takeHead,
} from '../messageQueue';
import { decideQueueRelease, deriveQueueStripModel } from '../queueRelease';
import { releaseQueueHead } from '../queueReleaseTransaction';

function message(id: string, sessionId = 's1'): QueuedMessage {
  return { id, sessionId, text: id, attachments: [], queuedAt: Number(id.slice(1)) || 0 };
}

function seeded(ids: readonly string[]) {
  let state = createEmptyState();
  for (const id of ids) {
    const result = enqueue(state, message(id));
    if (!result.ok) throw new Error(result.message);
    state = result.state;
  }
  return state;
}

describe('releaseQueueHead', () => {
  it('Send now waits through stopping, sends the chosen entry once, and keeps the other entries', async () => {
    let state = seeded(['q1', 'q2', 'q3']);
    const original = selectSessionQueue(state, 's1').entries;
    state = prioritizeEntry(state, 's1', 'q3');
    const queue = selectSessionQueue(state, 's1');
    const gate = {
      sessionId: 's1',
      entries: queue.entries,
      paused: queue.paused,
      hasTarget: true,
      disabled: false,
      sending: false,
      inFlight: false,
    };
    for (const status of ['running', 'stopping'] as const) {
      expect(decideQueueRelease({ ...gate, status }).type).toBe('hold');
    }
    expect(decideQueueRelease({ ...gate, status: 'idle', inFlight: true }).type).toBe('hold');
    expect(decideQueueRelease({ ...gate, status: 'idle' })).toEqual({
      type: 'release',
      entryId: 'q3',
    });
    const runEntry = vi.fn(async (_entry: QueuedMessage) => 'committed' as const);
    await releaseQueueHead('s1', {
      takeHead: (sessionId) => {
        const taken = takeHead(state, sessionId);
        state = taken.state;
        return taken.entry;
      },
      restoreHead: (entry) => {
        state = restoreHead(state, entry);
      },
      pauseRejected: (sessionId) => {
        state = pauseSession(state, sessionId, 'send-rejected');
      },
      runEntry,
    });
    expect(runEntry).toHaveBeenCalledExactlyOnceWith(original[2]);
    expect(selectSessionQueue(state, 's1').entries).toEqual([original[0], original[1]]);
  });

  it('Send now cannot restore deleted sessions or mutate another session', () => {
    const state = seeded(['q1', 'q2']);
    expect(prioritizeEntry(state, 'other', 'q2')).toBe(state);
    expect(prioritizeEntry(state, 's1', 'missing')).toBe(state);
    const pruned = pruneSessions(state, []);
    expect(prioritizeEntry(pruned, 's1', 'q2')).toBe(pruned);
  });

  it('keeps Send now ahead of a release cancelled before admission', async () => {
    let state = seeded(['q1', 'q2', 'q3']);
    await releaseQueueHead('s1', {
      takeHead: (sessionId) => {
        const taken = takeHead(state, sessionId);
        state = taken.state;
        return taken.entry;
      },
      restoreHead: (entry) => {
        state = restoreHead(state, entry);
      },
      pauseRejected: (sessionId) => {
        state = pauseSession(state, sessionId, 'send-rejected');
      },
      runEntry: async () => {
        // The user interrupts q1's handshake to send q3.
        state = prioritizeEntry(state, 's1', 'q3');
        return 'skipped';
      },
    });
    expect(selectSessionQueue(state, 's1').entries.map((entry) => entry.id)).toEqual([
      'q3',
      'q1',
      'q2',
    ]);
    expect(selectSessionQueue(state, 's1').paused).toBeNull();
  });

  it('lets Send now past a Host pause for that entry only', async () => {
    let state = seeded(['q1', 'q2']);
    state = pauseSession(state, 's1', 'send-rejected');
    const gate = (queue: ReturnType<typeof selectSessionQueue>) => ({
      sessionId: 's1',
      entries: queue.entries,
      paused: queue.paused,
      ...(queue.priorityEntryId ? { priorityEntryId: queue.priorityEntryId } : {}),
      hasTarget: true,
      disabled: false,
      sending: false,
      inFlight: false,
      status: 'idle' as const,
    });
    // A Host refusal holds the whole queue.
    expect(decideQueueRelease(gate(selectSessionQueue(state, 's1')))).toEqual({
      type: 'hold',
      reason: 'paused',
    });
    // The pause SURVIVES the promotion — it protects q2 as well.
    state = prioritizeEntry(state, 's1', 'q1');
    expect(selectSessionQueue(state, 's1').paused).toBe('send-rejected');
    expect(decideQueueRelease(gate(selectSessionQueue(state, 's1')))).toEqual({
      type: 'release',
      entryId: 'q1',
    });

    const sent: string[] = [];
    await releaseQueueHead('s1', {
      takeHead: (sessionId) => {
        const taken = takeHead(state, sessionId);
        state = taken.state;
        return taken.entry;
      },
      restoreHead: (entry) => {
        state = restoreHead(state, entry);
      },
      pauseRejected: (sessionId) => {
        state = pauseSession(state, sessionId, 'send-rejected');
      },
      runEntry: async (entry) => {
        sent.push(entry.id);
        return 'committed' as const;
      },
    });

    // Token consumed by `takeHead`: q2 is held by the same pause again, so one
    // click cannot restart the restore->re-release livelock S1 closed.
    expect(sent).toEqual(['q1']);
    const after = selectSessionQueue(state, 's1');
    expect(after.priorityEntryId).toBeUndefined();
    expect(after.paused).toBe('send-rejected');
    expect(decideQueueRelease(gate(after))).toEqual({ type: 'hold', reason: 'paused' });
  });

  it('never lets the Send now token past an unresolved failure', () => {
    let state = seeded(['q1']);
    state = pauseSession(state, 's1', 'send-rejected');
    state = prioritizeEntry(state, 's1', 'q1');
    const queue = selectSessionQueue(state, 's1');
    expect(
      decideQueueRelease({
        sessionId: 's1',
        entries: [{ id: 'q1', failure: { message: 'boom' } }],
        paused: queue.paused,
        priorityEntryId: queue.priorityEntryId,
        hasTarget: true,
        disabled: false,
        sending: false,
        inFlight: false,
        status: 'idle',
      })
    ).toEqual({ type: 'hold', reason: 'head-failed' });
  });

  it('offers Send now on the head entry only', () => {
    const model = deriveQueueStripModel({
      entries: selectSessionQueue(seeded(['q1', 'q2', 'q3']), 's1').entries,
      paused: null,
      hasPendingPermissionHere: false,
    });
    expect(model.entries.map((entry) => entry.canSendNow)).toEqual([true, false, false]);
  });

  it('releases three entries in strict FIFO order, once each', async () => {
    let state = seeded(['q1', 'q2', 'q3']);
    const sent: string[] = [];
    const operations = {
      takeHead: (sessionId: string) => {
        const result = takeHead(state, sessionId);
        state = result.state;
        return result.entry;
      },
      restoreHead: (entry: QueuedMessage) => {
        state = restoreHead(state, entry);
      },
      pauseRejected: (sessionId: string) => {
        state = pauseSession(state, sessionId, 'send-rejected');
      },
      runEntry: async (entry: QueuedMessage) => {
        sent.push(entry.id);
        return 'committed' as const;
      },
    };

    await releaseQueueHead('s1', operations);
    await releaseQueueHead('s1', operations);
    await releaseQueueHead('s1', operations);

    expect(sent).toEqual(['q1', 'q2', 'q3']);
    expect(selectSessionQueue(state, 's1').entries).toEqual([]);
  });

  it('preserves queued attachments through the release transaction', async () => {
    const queued: QueuedMessage = {
      ...message('q1'),
      attachments: [
        {
          id: 'att-1',
          kind: 'text',
          mediaType: 'text/plain',
          name: 'notes.txt',
          byteLength: 5,
          data: 'hello',
        },
      ],
    };
    let state = createEmptyState();
    const result = enqueue(state, queued);
    if (!result.ok) throw new Error(result.message);
    state = result.state;
    const runEntry = vi.fn(async (_entry: QueuedMessage) => 'committed' as const);

    await releaseQueueHead('s1', {
      takeHead: (sessionId) => {
        const taken = takeHead(state, sessionId);
        state = taken.state;
        return taken.entry;
      },
      restoreHead: (entry) => {
        state = restoreHead(state, entry);
      },
      pauseRejected: (sessionId) => {
        state = pauseSession(state, sessionId, 'send-rejected');
      },
      runEntry,
    });

    expect(runEntry).toHaveBeenCalledWith(queued);
    expect(runEntry.mock.calls[0][0].attachments).toBe(queued.attachments);
  });

  it('restores and pauses exactly once after Host rejection', async () => {
    let state = seeded(['q1', 'q2']);
    const pauseRejected = vi.fn((sessionId: string) => {
      state = pauseSession(state, sessionId, 'send-rejected');
    });
    const outcome = await releaseQueueHead('s1', {
      takeHead: (sessionId) => {
        const result = takeHead(state, sessionId);
        state = result.state;
        return result.entry;
      },
      restoreHead: (entry) => {
        state = restoreHead(state, entry);
      },
      pauseRejected,
      runEntry: async () => 'rejected',
    });

    expect(outcome.type).toBe('restored');
    expect(selectSessionQueue(state, 's1').entries.map((entry) => entry.id)).toEqual(['q1', 'q2']);
    expect(selectSessionQueue(state, 's1').paused).toBe('send-rejected');
    expect(pauseRejected).toHaveBeenCalledTimes(1);
  });

  it('restores and pauses after an unexpected runEntry throw', async () => {
    let state = seeded(['q1']);
    const outcome = await releaseQueueHead('s1', {
      takeHead: (sessionId) => {
        const result = takeHead(state, sessionId);
        state = result.state;
        return result.entry;
      },
      restoreHead: (entry) => {
        state = restoreHead(state, entry);
      },
      pauseRejected: (sessionId) => {
        state = pauseSession(state, sessionId, 'send-rejected');
      },
      runEntry: async () => {
        throw new Error('wire conversion failed');
      },
    });

    expect(outcome).toMatchObject({ type: 'restored', outcome: 'thrown' });
    expect(selectSessionQueue(state, 's1').entries.map((entry) => entry.id)).toEqual(['q1']);
    expect(selectSessionQueue(state, 's1').paused).toBe('send-rejected');
  });

  it('cannot resurrect a queue pruned while the release is in flight', async () => {
    let state = seeded(['q1', 'q2']);
    let resolveRun!: (outcome: 'rejected') => void;
    const runEntry = () =>
      new Promise<'rejected'>((resolve) => {
        resolveRun = resolve;
      });
    const pending = releaseQueueHead('s1', {
      takeHead: (sessionId) => {
        const result = takeHead(state, sessionId);
        state = result.state;
        return result.entry;
      },
      restoreHead: (entry) => {
        state = restoreHead(state, entry);
      },
      pauseRejected: (sessionId) => {
        state = pauseSession(state, sessionId, 'send-rejected');
      },
      runEntry,
    });

    state = pruneSessions(state, []);
    resolveRun('rejected');
    await pending;

    expect(Object.keys(state.bySession)).toEqual([]);
    expect(selectSessionQueue(state, 's1').entries).toEqual([]);
  });

  it('prunes only archived or repository-removed sessions while another session remains live', async () => {
    let state = seeded(['q1']);
    const second = enqueue(state, message('q2', 's2'));
    if (!second.ok) throw new Error(second.message);
    state = second.state;

    state = pruneSessions(state, ['s2']);
    expect(Object.keys(state.bySession)).toEqual(['s2']);
    expect(selectSessionQueue(state, 's1').entries).toEqual([]);
    expect(selectSessionQueue(state, 's2').entries.map((entry) => entry.id)).toEqual(['q2']);
  });

  it('returns empty without running when another action already removed the head', async () => {
    const runEntry = vi.fn(async (_entry: QueuedMessage) => 'committed' as const);
    const result = await releaseQueueHead('s1', {
      takeHead: () => null,
      restoreHead: vi.fn(),
      pauseRejected: vi.fn(),
      runEntry,
    });
    expect(result).toEqual({ type: 'empty' });
    expect(runEntry).not.toHaveBeenCalled();
  });
});
