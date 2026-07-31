import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { useCallback, useEffect, useState } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { mergeSessionIndex, recentSessionIdsFromIndex } from './sessionIndexMerge';

/**
 * Team-side hydrator wiring the Main-side SessionIndex (C-07) into the live
 * chat session list (T-02). Mount reads `chat.listSessions`, folds entries
 * into the red-line store's `sessions` (preserving live runtime fields),
 * refreshes `recentSessionIds`, and exposes `refresh` for callers to re-run
 * after close / rename / archive mutations.
 *
 * Does NOT touch chatSessions.ts — writes via the store's setState bridge.
 */

export interface UseSessionIndexResult {
  /** Imperatively re-read the index (after a mutation lands). */
  refresh: () => Promise<void>;
  /** True while the initial hydration is in flight. */
  loading: boolean;
  /** Last index error message (null when healthy). */
  error: string | null;
}

export function useSessionIndex(): UseSessionIndexResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entries = await window.electronAPI.chat.listSessions();
      const prev = useChatSessionsStore.getState();
      const { sessions } = mergeSessionIndex(prev.sessions, entries, {
        workspaces: prev.workspaces,
        seedStatus: 'idle',
      });
      const recentSessionIds = recentSessionIdsFromIndex(sessions, 20);
      useChatSessionsStore.setState({
        sessions,
        recentSessionIds,
      });
    } catch (err) {
      // Persisting/listing is best-effort: never block the UI when the index
      // is unavailable. Surface the message so T-09 diagnostics can show it.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer to mount so the LeftNav / tree hooks hydrate first (workspaces
    // must be available for path→workspaceId mapping). A microtask is enough.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  return { refresh, loading, error };
}

/**
 * The rename action/IPC itself, extracted from `useSessionIndexMutations` so
 * non-hook callers (T-27 round-3's first-message auto-title wiring in
 * `stores/chatSessionActions.ts`) can reuse the exact same call instead of
 * opening a second path to `window.electronAPI.chat.renameSession`.
 * `onRenamed` runs only after the IPC confirms success — the manual
 * LeftNav rename flow passes its `refresh()` (full session-index refetch);
 * other callers may pass a cheaper targeted store update instead.
 */
export async function renameSessionIndexEntry(
  sessionId: string,
  title: string,
  onRenamed: () => Promise<void>
): Promise<boolean> {
  try {
    const ok = await window.electronAPI.chat.renameSession({ sessionId, title });
    if (ok) await onRenamed();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Mutation helpers for rename / archive / close — mirror the Main IPC and
 * refresh the index afterwards so the live list reflects the new state.
 */
export function useSessionIndexMutations(refresh: () => Promise<void>) {
  const rename = useCallback(
    (sessionId: string, title: string): Promise<boolean> =>
      renameSessionIndexEntry(sessionId, title, refresh),
    [refresh]
  );

  const archive = useCallback(
    async (sessionId: string, archived: boolean): Promise<boolean> => {
      try {
        const ok = await window.electronAPI.chat.archiveSession({ sessionId, archived });
        if (ok) await refresh();
        return ok;
      } catch {
        return false;
      }
    },
    [refresh]
  );

  const close = useCallback(
    async (sessionId: string): Promise<boolean> => {
      try {
        await window.electronAPI.chat.closeSession({ sessionId });
        // Active removal is reflected immediately by the store's event flow;
        // refresh the index so updatedAt on survivors is current.
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh]
  );

  return { rename, archive, close };
}

/**
 * Bump the live session updatedAt so recent ordering follows activity.
 */
function touchLiveUpdatedAt(sessionId: string, now = Date.now()): void {
  const state = useChatSessionsStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (session && session.updatedAt < now) {
    useChatSessionsStore.setState({
      sessions: state.sessions.map((item) =>
        item.id === sessionId ? { ...item, updatedAt: now } : item
      ),
    });
  }
}

export { touchLiveUpdatedAt, type SessionIndexEntry };
