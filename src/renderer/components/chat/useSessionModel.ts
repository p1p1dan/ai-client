import type { AgentWireName } from '@shared/types/agentWire';
import { useCallback } from 'react';
import { readSessionModel, removeSessionModel, writeSessionModel } from './sessionPreferenceStore';

/**
 * Per-session model selection (T-08), re-keyed by (session, agent) in D48 S2:
 * the storage layer moved to `sessionPreferenceStore.ts` (pure, and therefore
 * testable under the node-env vitest, which cannot call a `useCallback`), and
 * every accessor now names the agent whose catalog the id came from.
 *
 * Renderer-only; does not touch the red-line `chatSessions` store.
 */

export interface SessionModelApi {
  /** Returns the stored model id for one (session, agent), or null when unset. */
  getSessionModel: (sessionId: string, agent: AgentWireName) => string | null;
  /** Bind a model id to one (session, agent) and persist. */
  setSessionModel: (sessionId: string, agent: AgentWireName, modelId: string) => void;
  /** Drop the binding for one (session, agent) — how `Automatic` is stored. */
  clearSessionModel: (sessionId: string, agent: AgentWireName) => void;
}

/**
 * Imperative (non-reactive) accessor for the (session, agent)->model map.
 * Components keep selected state in plain `useState` and call these to
 * persist/restore.
 */
export function useSessionModel(): SessionModelApi {
  const getSessionModel = useCallback(
    (sessionId: string, agent: AgentWireName): string | null => readSessionModel(sessionId, agent),
    []
  );

  const setSessionModel = useCallback(
    (sessionId: string, agent: AgentWireName, modelId: string): void =>
      writeSessionModel(sessionId, agent, modelId),
    []
  );

  const clearSessionModel = useCallback(
    (sessionId: string, agent: AgentWireName): void => removeSessionModel(sessionId, agent),
    []
  );

  return { getSessionModel, setSessionModel, clearSessionModel };
}
