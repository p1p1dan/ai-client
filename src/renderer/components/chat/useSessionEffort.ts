import { useCallback } from 'react';
import {
  readSessionEffort,
  removeSessionEffort,
  writeSessionEffort,
} from './sessionPreferenceStore';

/** Per-session reasoning effort selection for Pi chat. Renderer-only. */

export interface SessionEffortApi {
  getSessionEffort: (sessionId: string) => string | null;
  setSessionEffort: (sessionId: string, selection: string) => void;
  clearSessionEffort: (sessionId: string) => void;
}

/** Imperative (non-reactive) accessor for the session-to-effort map. */
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
