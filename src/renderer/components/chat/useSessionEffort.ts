import { useCallback } from 'react';
import { readSessionEffort, removeSessionEffort, writeSessionEffort } from './sessionEffortStore';

/**
 * Per-session reasoning effort (T-20): each Session keeps its effort across
 * Composer sends, close/recreate cycles, and app restarts.
 *
 * Mirrors `useSessionModel` (T-08) deliberately — same imperative accessor
 * style — so the two Composer selectors stay symmetrical. The storage logic
 * lives in `sessionEffortStore.ts` so it is unit testable without a React
 * renderer (the vitest env is `node`).
 *
 * Renderer-only; does not touch the red-line `chatSessions` store.
 */

export interface SessionEffortApi {
  /** Returns the stored selection for a session, or null when unset. */
  getSessionEffort: (sessionId: string) => string | null;
  /** Bind a selection to a session and persist. */
  setSessionEffort: (sessionId: string, selection: string) => void;
  /** Drop the binding for a session (no-op when unset). */
  clearSessionEffort: (sessionId: string) => void;
}

/**
 * Imperative (non-reactive) accessor for the session->effort map. Components
 * keep selected state in plain `useState` and call these to persist/restore.
 */
export function useSessionEffort(): SessionEffortApi {
  const getSessionEffort = useCallback(
    (sessionId: string): string | null => readSessionEffort(sessionId),
    []
  );

  const setSessionEffort = useCallback(
    (sessionId: string, selection: string): void => writeSessionEffort(sessionId, selection),
    []
  );

  const clearSessionEffort = useCallback(
    (sessionId: string): void => removeSessionEffort(sessionId),
    []
  );

  return { getSessionEffort, setSessionEffort, clearSessionEffort };
}
