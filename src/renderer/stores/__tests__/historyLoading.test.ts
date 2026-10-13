import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORY_LOAD_DEADLINE_MS,
  selectIsHistoryLoading,
  useHistoryLoadingStore,
} from '../historyLoading';

/**
 * The marker behind "this transcript is on its way".
 *
 * The bug it exists for is a timeline that said 「还没有消息，发一条消息开始对话。」
 * while a stored chat's history was still loading — because an empty bucket is
 * also what a brand-new chat has. These tests hold the two properties that
 * make the marker usable: it is per-session, and it cannot outlive its load.
 */

const T0 = 1_000_000;

beforeEach(() => {
  useHistoryLoadingStore.setState({ loading: {} });
});

describe('historyLoading store', () => {
  it('[HL-01] marks one session loading without touching another', () => {
    // A background activation of session B must not put a spinner on A.
    useHistoryLoadingStore.getState().begin('s1');
    const state = useHistoryLoadingStore.getState();
    expect(selectIsHistoryLoading(state, 's1')).toBe(true);
    expect(selectIsHistoryLoading(state, 's2')).toBe(false);
    expect(selectIsHistoryLoading(state, null)).toBe(false);
  });

  it('[HL-02] expires at its deadline rather than living until it is cleared', () => {
    // The backstop for a load that never answers: a refused preview that fell
    // back to a resume that then hung would otherwise spin forever.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      useHistoryLoadingStore.getState().begin('s1');
      expect(selectIsHistoryLoading(useHistoryLoadingStore.getState(), 's1')).toBe(true);
      vi.setSystemTime(T0 + HISTORY_LOAD_DEADLINE_MS - 1);
      expect(selectIsHistoryLoading(useHistoryLoadingStore.getState(), 's1')).toBe(true);
      vi.setSystemTime(T0 + HISTORY_LOAD_DEADLINE_MS);
      expect(selectIsHistoryLoading(useHistoryLoadingStore.getState(), 's1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('[HL-03] clear is idempotent and leaves other sessions alone', () => {
    useHistoryLoadingStore.getState().begin('s1');
    useHistoryLoadingStore.getState().begin('s2');
    useHistoryLoadingStore.getState().clear('s1');
    useHistoryLoadingStore.getState().clear('s1');
    const state = useHistoryLoadingStore.getState();
    expect(selectIsHistoryLoading(state, 's1')).toBe(false);
    expect(selectIsHistoryLoading(state, 's2')).toBe(true);
  });

  it('[HL-04] a cleared session leaves no key behind', () => {
    // `Object.keys` is read by `reap` to decide whether anything
    // changed; a tombstone would make every sweep look like a write and
    // re-render the timeline for nothing.
    useHistoryLoadingStore.getState().begin('s1');
    useHistoryLoadingStore.getState().clear('s1');
    expect(useHistoryLoadingStore.getState().loading).toEqual({});
  });

  it('[HL-06] reap drops expired entries and keeps live ones', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      useHistoryLoadingStore.getState().begin('stale');
      useHistoryLoadingStore.getState().begin('live');
      // Rewind the one entry rather than advancing the clock, so "expired"
      // and "still waiting" are both on screen for the same sweep.
      useHistoryLoadingStore.setState((state) => ({
        loading: { ...state.loading, stale: T0 - 1 },
      }));
      useHistoryLoadingStore.getState().reap();
      const state = useHistoryLoadingStore.getState();
      expect(selectIsHistoryLoading(state, 'stale')).toBe(false);
      expect(selectIsHistoryLoading(state, 'live')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('[HL-07] a second activation of the same session restarts its deadline', () => {
    // Clicking the row again (or a Retry) asks again; the new request, not the
    // first one's clock, is what its answer belongs to.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      useHistoryLoadingStore.getState().begin('s1');
      const first = useHistoryLoadingStore.getState().loading.s1;
      vi.setSystemTime(T0 + 5_000);
      useHistoryLoadingStore.getState().begin('s1');
      expect(useHistoryLoadingStore.getState().loading.s1).toBe(first + 5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('[HL-08] selecting no session is never loading', () => {
    expect(selectIsHistoryLoading({ loading: { s1: Number.MAX_SAFE_INTEGER } }, null)).toBe(false);
  });
});
