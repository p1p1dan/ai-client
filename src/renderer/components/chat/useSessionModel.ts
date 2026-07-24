import { useCallback } from 'react';

/**
 * Per-session model selection (T-08): persist a `sessionId -> model id` map in
 * localStorage so each Session keeps a fixed model across Composer sends,
 * send-session-close/recreate cycles, and app restarts (until the Host-side
 * session index lands via C-07/T-02 and owns this field).
 *
 * Renderer-only; does not touch the red-line `chatSessions` store.
 */

const STORAGE_KEY = 'aiclient:chat:session-models';

type SessionModelMap = Record<string, string>;

function loadMap(): SessionModelMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SessionModelMap;
    }
    return {};
  } catch {
    return {};
  }
}

function saveMap(map: SessionModelMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage may be unavailable (private mode / quota); selection stays in memory only.
  }
}

export interface SessionModelApi {
  /** Returns the stored model id for a session, or null when unset. */
  getSessionModel: (sessionId: string) => string | null;
  /** Bind a model id to a session and persist. */
  setSessionModel: (sessionId: string, modelId: string) => void;
  /** Drop the binding for a session (no-op when unset). */
  clearSessionModel: (sessionId: string) => void;
}

/**
 * Imperative (non-reactive) accessor for the session->model map. Components
 * keep selected state in plain `useState` and call these to persist/restore.
 */
export function useSessionModel(): SessionModelApi {
  const getSessionModel = useCallback((sessionId: string): string | null => {
    return loadMap()[sessionId] ?? null;
  }, []);

  const setSessionModel = useCallback((sessionId: string, modelId: string): void => {
    const map = loadMap();
    map[sessionId] = modelId;
    saveMap(map);
  }, []);

  const clearSessionModel = useCallback((sessionId: string): void => {
    const map = loadMap();
    if (sessionId in map) {
      delete map[sessionId];
      saveMap(map);
    }
  }, []);

  return { getSessionModel, setSessionModel, clearSessionModel };
}
