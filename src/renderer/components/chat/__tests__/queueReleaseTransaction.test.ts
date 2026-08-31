import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyState,
  enqueue,
  pauseSession,
  pruneSessions,
  type QueuedMessage,
  restoreHead,
  selectSessionQueue,
  takeHead,
} from '../messageQueue';
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
