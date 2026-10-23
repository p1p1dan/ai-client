import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIDE_QUESTION_FAILED,
  SIDE_QUESTION_UNAVAILABLE,
  type SideChatTransport,
  type SideQuestionRequest,
  setSideChatTransport,
  useSideChatStore,
} from '@/stores/sideChat';
import { INITIAL_SIDE_CHAT, type SideQuestionOutcome } from '../sideChat/sideChatModel';

/**
 * Layout 5f (ui-cohesion ruling L6): the side chat store asks one question at
 * a time through its transport, drops answers that arrive after a close, and
 * tells the engine to stop a question that was discarded.
 */

interface Deferred {
  request: SideQuestionRequest;
  resolve: (outcome: SideQuestionOutcome) => void;
  reject: (error: unknown) => void;
}

let asked: Deferred[] = [];
let cancelled: Array<[string, string]> = [];

beforeEach(() => {
  asked = [];
  cancelled = [];
  const transport: SideChatTransport = {
    ask: (request) =>
      new Promise((resolve, reject) => {
        asked.push({ request, resolve, reject });
      }),
    cancel: (sessionId, questionId) => cancelled.push([sessionId, questionId]),
  };
  setSideChatTransport(transport);
  useSideChatStore.setState({ ...INITIAL_SIDE_CHAT });
});

afterEach(() => {
  setSideChatTransport(null);
  vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('side chat store', () => {
  it('asks on the conversation, then shows the answer; a follow-up carries it', async () => {
    const store = useSideChatStore.getState();
    expect(store.ask('s1', 'one?')).toBe(true);
    expect(useSideChatStore.getState()).toMatchObject({ open: true, sessionId: 's1' });
    expect(asked[0]?.request).toMatchObject({ sessionId: 's1', question: 'one?', history: [] });
    // One at a time.
    expect(useSideChatStore.getState().ask('s1', 'two?')).toBe(false);
    asked[0]?.resolve({ kind: 'answer', text: 'A' });
    await flush();
    expect(useSideChatStore.getState().entries[0]).toMatchObject({
      status: 'answered',
      answer: 'A',
    });
    expect(useSideChatStore.getState().ask('s1', 'two?')).toBe(true);
    expect(asked[1]?.request.history).toEqual([{ question: 'one?', answer: 'A' }]);
  });

  it('a bare question opens it empty and asks nothing', () => {
    expect(useSideChatStore.getState().ask('s1', '   ')).toBe(true);
    expect(useSideChatStore.getState()).toMatchObject({ open: true, entries: [] });
    expect(asked).toHaveLength(0);
  });

  it('closing discards it: the engine is told, and the late answer is dropped', async () => {
    useSideChatStore.getState().ask('s1', 'why?');
    const questionId = asked[0]?.request.questionId ?? '';
    useSideChatStore.getState().close();
    expect(cancelled).toEqual([['s1', questionId]]);
    expect(useSideChatStore.getState()).toMatchObject({ open: false, entries: [] });
    asked[0]?.resolve({ kind: 'answer', text: 'late' });
    await flush();
    expect(useSideChatStore.getState().entries).toEqual([]);
  });

  it('switching conversations discards it too', () => {
    useSideChatStore.getState().ask('s1', 'why?');
    useSideChatStore.getState().followSession('s2');
    expect(useSideChatStore.getState().open).toBe(false);
    expect(cancelled).toHaveLength(1);
  });

  it('a failure is said in words, the engine’s refusal apart', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useSideChatStore.getState().ask('s1', 'one?');
    asked[0]?.reject(new Error('boom'));
    await flush();
    expect(useSideChatStore.getState().entries[0]).toMatchObject({
      status: 'failed',
      errorKey: SIDE_QUESTION_FAILED,
    });
    useSideChatStore.getState().ask('s1', 'two?');
    asked[1]?.reject(new Error('WORKER_SIDE_QUESTION_UNAVAILABLE: no'));
    await flush();
    expect(useSideChatStore.getState().entries[1]).toMatchObject({
      errorKey: SIDE_QUESTION_UNAVAILABLE,
    });
  });
});
