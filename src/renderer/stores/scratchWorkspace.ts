import { create } from 'zustand';

/**
 * U05-a (renderer half) — which isolated directory Main handed each unbound
 * chat this app run.
 *
 * A chat is "unbound" when the user never picked a project folder for it, so
 * `resolveActiveTarget().cwd` is null. It still needs a working directory
 * before anything can run in it; Main allocates one on demand
 * (`chat:ensureScratchWorkspace`) and this store remembers the answer so the
 * send path, the Pi TUI and the session badge all read the same value.
 *
 * Deliberately NOT part of `chatSessions.workspaces`: a scratch directory is
 * not a project. Putting it there would list a throwaway directory in the
 * sidebar tree and the folder dropdown, and would flip the app-wide
 * `hasWorkingDirectory` flag for every OTHER chat as a side effect.
 *
 * Run-scoped, like the directories themselves — Main wipes them at app exit,
 * so there is nothing here worth persisting.
 */
interface ScratchWorkspaceState {
  /** sessionId -> allocated absolute path. */
  pathsBySession: Record<string, string>;
  /** Allocate on first call, reuse afterwards. Concurrent calls share one IPC. */
  ensure: (sessionId: string) => Promise<string>;
  pathFor: (sessionId: string | null | undefined) => string | null;
  forget: (sessionId: string) => void;
}

/**
 * In-flight allocations, keyed by session.
 *
 * Module-level rather than store state: the first send and an `openTui` in the
 * same tick would otherwise each start their own IPC call, and a session with
 * two directories is exactly the state `ensure` exists to prevent. Main is
 * idempotent too, so this is the second of two guards, not the only one.
 */
const inFlight = new Map<string, Promise<string>>();

export const useScratchWorkspaceStore = create<ScratchWorkspaceState>((set, get) => ({
  pathsBySession: {},
  pathFor: (sessionId) => (sessionId ? (get().pathsBySession[sessionId] ?? null) : null),
  ensure: async (sessionId) => {
    const known = get().pathsBySession[sessionId];
    if (known) return known;
    const pending = inFlight.get(sessionId);
    if (pending) return pending;

    const request = window.electronAPI.chat
      .ensureScratchWorkspace({ sessionId })
      .then((result) => {
        const path = result?.path?.trim() ?? '';
        if (!path) {
          throw new Error('chat:ensureScratchWorkspace returned no path');
        }
        set((state) => ({ pathsBySession: { ...state.pathsBySession, [sessionId]: path } }));
        return path;
      })
      .finally(() => {
        if (inFlight.get(sessionId) === request) inFlight.delete(sessionId);
      });
    inFlight.set(sessionId, request);
    return request;
  },
  forget: (sessionId) => {
    inFlight.delete(sessionId);
    set((state) => {
      if (!(sessionId in state.pathsBySession)) return state;
      const next = { ...state.pathsBySession };
      delete next[sessionId];
      return { pathsBySession: next };
    });
  },
}));
