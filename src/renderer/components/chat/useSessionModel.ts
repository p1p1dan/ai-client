import { useCallback } from 'react';
import { readSessionModel, removeSessionModel, writeSessionModel } from './sessionPreferenceStore';

/** Per-session model selection for Pi chat. Renderer-only. */

export interface SessionModelApi {
  getSessionModel: (sessionId: string) => string | null;
  setSessionModel: (sessionId: string, modelId: string) => void;
  clearSessionModel: (sessionId: string) => void;
}

/** Imperative (non-reactive) accessor for the session-to-model map. */
export function useSessionModel(): SessionModelApi {
  const getSessionModel = useCallback(
    (sessionId: string): string | null => readSessionModel(sessionId),
    []
  );

  const setSessionModel = useCallback(
    (sessionId: string, modelId: string): void => writeSessionModel(sessionId, modelId),
    []
  );

  const clearSessionModel = useCallback(
    (sessionId: string): void => removeSessionModel(sessionId),
    []
  );

  return { getSessionModel, setSessionModel, clearSessionModel };
}
