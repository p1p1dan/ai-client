import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { create } from 'zustand';
import {
  initialSessionRuntimeFacts,
  reduceSessionRuntimeFacts,
  type SessionRuntimeFactsState,
} from '@/components/workspace-shell/surfaces/contextSurfaceModel';

/**
 * T-14: adjacent store for facts the red-line `chatSessions.ts` does not
 * carry — `permissionMode` (echoed on `session.created`/`session.resumed`)
 * and, since T-35, the forwarded `session.stderr` ring. All folding logic lives in
 * `contextSurfaceModel.ts`'s `reduceSessionRuntimeFacts` (pure, unit tested
 * under the node-env vitest); this file is only the zustand shell plus the
 * subscription lifecycle.
 *
 * Piggybacks the SAME renderer-side dispatch point chatSessions.ts's own
 * `initRuntime` subscribes to (`window.electronAPI.chat.onRuntimeEvent`,
 * multi-subscriber — see `useHostStatus`/`useMessageMetadata` for the same
 * pattern) rather than touching that red-line file.
 *
 * `init()` is a single-listener latch, same shape as
 * `chatSessions.ts`'s `initRuntime`: calling it while already subscribed is a
 * no-op. Only ONE call site should own it (today: `ChatWorkspace.tsx`, which
 * is mounted for the whole app run — same reasoning as its `useHostStatus()`
 * call) so a second consumer's unmount can never tear down the one shared
 * listener out from under the first.
 */
interface SessionRuntimeFactsStoreState {
  factsBySession: SessionRuntimeFactsState;
  /** Latch: true once the single `onRuntimeEvent` listener is installed. */
  listening: boolean;
  /** Subscribe (no-op if already subscribed) and return the unsubscribe. */
  init: () => () => void;
}

export const useSessionRuntimeFactsStore = create<SessionRuntimeFactsStoreState>()((set, get) => ({
  factsBySession: initialSessionRuntimeFacts,
  listening: false,

  init: () => {
    if (get().listening) {
      return () => {};
    }
    set({ listening: true });

    const unsubscribe = window.electronAPI.chat.onRuntimeEvent((event: RuntimeEvent) => {
      // Return `state` itself (not a new object) when the reducer produced no
      // change so zustand's `Object.is` check short-circuits `setState` and
      // skips notifying subscribers.
      set((state) => {
        const next = reduceSessionRuntimeFacts(state.factsBySession, event);
        return next === state.factsBySession ? state : { factsBySession: next };
      });
    });

    return () => {
      set({ listening: false });
      unsubscribe();
    };
  },
}));
