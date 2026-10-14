import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '../chatSessions';
import {
  HISTORY_LOAD_DEADLINE_MS,
  resetHistoryLoadingForTests,
  selectIsHistoryLoading,
  useHistoryLoadingStore,
} from '../historyLoading';
import { pruneSessionScopedRendererState } from '../sessionLifecycle';

/**
 * The marker behind "this transcript is on its way".
 *
 * The bug it exists for is a timeline that said 「还没有消息，发一条消息开始对话。」
 * while a stored chat's history was still loading — because an empty bucket is
 * also what a brand-new chat has. These tests hold what makes the marker
 * usable: it is per-session, it ends when THIS load is answered (not when some
 * earlier read left its trace), and it cannot outlive its load.
 */

function loading(sessionId: string | null): boolean {
  return selectIsHistoryLoading(useHistoryLoadingStore.getState(), sessionId);
}

const cursor = (nextOffset: number) => ({
  nextOffset,
  hydratedCount: nextOffset,
  totalCount: nextOffset,
  hasMore: false,
});

/** What the `session.history` reducer writes for one answer: a fresh cursor object. */
function answer(sessionId: string, nextOffset = 2): void {
  useChatSessionsStore.setState((state) => ({
    historyPagination: { ...state.historyPagination, [sessionId]: cursor(nextOffset) },
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetHistoryLoadingForTests();
  useChatSessionsStore.setState({ historyErrors: {}, historyPagination: {} });
});

afterEach(() => {
  resetHistoryLoadingForTests();
  vi.useRealTimers();
});

describe('historyLoading store', () => {
  it('[HL-01] marks one session loading without touching another', () => {
    // A background activation of session B must not put a spinner on A.
    useHistoryLoadingStore.getState().begin('s1');
    expect(loading('s1')).toBe(true);
    expect(loading('s2')).toBe(false);
    expect(loading(null)).toBe(false);
  });

  it('[HL-02] ends when the history answers', () => {
    useHistoryLoadingStore.getState().begin('s1');
    answer('s1');
    expect(loading('s1')).toBe(false);
  });

  it('[HL-03] ends when the read fails instead', () => {
    // A failed resume writes its card and no cursor.
    useHistoryLoadingStore.getState().begin('s1');
    useChatSessionsStore.setState({ historyErrors: { s1: 'read_failed: gone' } });
    expect(loading('s1')).toBe(false);
  });

  it('[HL-04] a revisited chat waits for the NEW answer, not the cursor its last read left', () => {
    // The first version read "this session has a cursor" as the answer. A chat
    // opened earlier in the run keeps that cursor, so a second load of it
    // counted as answered before it was sent, and 「还没有消息」 came back for
    // the whole round trip.
    answer('s1');
    useHistoryLoadingStore.getState().begin('s1');
    expect(loading('s1')).toBe(true);
    answer('s1');
    expect(loading('s1')).toBe(false);
  });

  it('[HL-05] ignores answers for other sessions', () => {
    useHistoryLoadingStore.getState().begin('s1');
    useHistoryLoadingStore.getState().begin('s2');
    answer('s2');
    expect(loading('s1')).toBe(true);
    expect(loading('s2')).toBe(false);
  });

  it('[HL-06] expires at its deadline, mounted timeline or not', () => {
    // The backstop for a load that never answers: a refused preview that fell
    // back to a resume that then hung would otherwise spin forever. Armed by
    // the store, so a chat the user clicked away from settles too.
    useHistoryLoadingStore.getState().begin('s1');
    vi.advanceTimersByTime(HISTORY_LOAD_DEADLINE_MS - 1);
    expect(loading('s1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(loading('s1')).toBe(false);
  });

  it('[HL-07] a second activation restarts the deadline and takes a new baseline', () => {
    useHistoryLoadingStore.getState().begin('s1');
    vi.advanceTimersByTime(HISTORY_LOAD_DEADLINE_MS - 1_000);
    useHistoryLoadingStore.getState().begin('s1');
    vi.advanceTimersByTime(1_000);
    expect(loading('s1')).toBe(true);
    vi.advanceTimersByTime(HISTORY_LOAD_DEADLINE_MS);
    expect(loading('s1')).toBe(false);
  });

  it('[HL-08] clear is idempotent, leaves other sessions alone, and leaves no key', () => {
    useHistoryLoadingStore.getState().begin('s1');
    useHistoryLoadingStore.getState().begin('s2');
    useHistoryLoadingStore.getState().clear('s1');
    useHistoryLoadingStore.getState().clear('s1');
    expect(loading('s1')).toBe(false);
    expect(loading('s2')).toBe(true);
    useHistoryLoadingStore.getState().clear('s2');
    expect(useHistoryLoadingStore.getState().loading).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('[HL-09] is pruned with the other session-scoped stores, deadline included', () => {
    useHistoryLoadingStore.getState().begin('gone');
    useHistoryLoadingStore.getState().begin('kept');
    pruneSessionScopedRendererState(['kept']);
    expect(loading('gone')).toBe(false);
    expect(loading('kept')).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('[HL-10] stops watching the chat store once nothing is loading', () => {
    const subscribe = vi.spyOn(useChatSessionsStore, 'subscribe');
    try {
      useHistoryLoadingStore.getState().begin('s1');
      useHistoryLoadingStore.getState().begin('s2');
      expect(subscribe).toHaveBeenCalledTimes(1);
      answer('s1');
      answer('s2');
      useHistoryLoadingStore.getState().begin('s3');
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      subscribe.mockRestore();
    }
  });
});
