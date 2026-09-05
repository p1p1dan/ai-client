/**
 * D08 (U15-c): which sessions are OPEN as center-column tabs.
 *
 * A thin zustand + persist wrapper around `sessionTabsModel.ts`; every decision
 * (append order, close target, pruning) lives in that pure module, so the store
 * can never behave differently from the functions the tests cover.
 *
 * localStorage, same reasoning as `shellLayout`: synchronous, so there is no
 * hydration-flicker frame with an empty tab strip before the persisted one
 * applies.
 *
 * Persisted on purpose — "which chats am I in the middle of" is exactly the
 * kind of state a restart should not throw away. Sessions that no longer exist
 * are pruned by the shell once `chatSessions` has loaded (`pruneClosedSessions`).
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  closeTab,
  ensureOpen,
  pruneClosedSessions,
} from '@/components/workspace-shell/sessionTabsModel';

export interface SessionTabsState {
  /** Open order, left to right. */
  openSessionIds: string[];
  /** Opens `sessionId` if it is not already open; no-op otherwise. */
  openSession: (sessionId: string | null) => void;
  /**
   * Drops the tab from the strip. Does NOT touch the session — detaching its
   * runtime is `closeSessionTab.ts`, which the X calls alongside this, and
   * pruning deliberately does not.
   */
  closeSession: (sessionId: string) => void;
  /** Drops tabs whose session no longer exists. */
  pruneSessions: (knownSessionIds: readonly string[]) => void;
}

function isSameList(a: readonly string[], b: readonly string[]): boolean {
  return a === b;
}

export const useSessionTabsStore = create<SessionTabsState>()(
  persist(
    (set) => ({
      openSessionIds: [],

      openSession: (sessionId) =>
        set((state) => {
          const next = ensureOpen(state.openSessionIds, sessionId);
          // Identity comparison, not length: the model returns the same array
          // when nothing changed, and returning a new object here would make
          // the `activeSessionId → ensureOpen` effect in the shell re-run
          // forever.
          return isSameList(next, state.openSessionIds) ? state : { openSessionIds: [...next] };
        }),

      closeSession: (sessionId) =>
        set((state) => {
          const next = closeTab(state.openSessionIds, sessionId);
          return isSameList(next, state.openSessionIds) ? state : { openSessionIds: [...next] };
        }),

      pruneSessions: (knownSessionIds) =>
        set((state) => {
          const next = pruneClosedSessions(state.openSessionIds, knownSessionIds);
          return isSameList(next, state.openSessionIds) ? state : { openSessionIds: [...next] };
        }),
    }),
    {
      name: 'aiclient-session-tabs',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ openSessionIds: state.openSessionIds }),
      merge: (persisted, current) => {
        const raw = persisted as { openSessionIds?: unknown } | null;
        const ids = Array.isArray(raw?.openSessionIds)
          ? raw.openSessionIds.filter((id): id is string => typeof id === 'string')
          : [];
        // Deduplicate here rather than trusting the file: a duplicate id would
        // render two tabs that both claim to be the same session, and React
        // would warn about the repeated key.
        return { ...current, openSessionIds: [...new Set(ids)] };
      },
    }
  )
);
