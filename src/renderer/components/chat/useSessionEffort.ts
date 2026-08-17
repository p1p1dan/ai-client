import type { AgentWireName } from '@shared/types/agentWire';
import { useCallback } from 'react';
import {
  readSessionEffort,
  removeSessionEffort,
  writeSessionEffort,
} from './sessionPreferenceStore';

/**
 * Per-session reasoning effort (T-20), re-keyed by (session, agent) in D48 S2.
 *
 * Mirrors `useSessionModel` (T-08) deliberately — same imperative accessor
 * style — so the two Composer selectors stay symmetrical. The storage logic
 * lives in `sessionPreferenceStore.ts` so it is unit testable without a React
 * renderer (the vitest env is `node`).
 *
 * The effort VOCABULARY is not per-agent (both axes ship the same five levels
 * [实测 调查 04 探测 E/G], §4.3-7), but the SELECTION is: switching a zero-turn
 * draft to the other agent and back must return the user to what they picked,
 * and a single scalar per session cannot express that.
 *
 * Renderer-only; does not touch the red-line `chatSessions` store.
 */

export interface SessionEffortApi {
  /** Returns the stored selection for one (session, agent), or null when unset. */
  getSessionEffort: (sessionId: string, agent: AgentWireName) => string | null;
  /** Bind a selection to one (session, agent) and persist. */
  setSessionEffort: (sessionId: string, agent: AgentWireName, selection: string) => void;
  /** Drop the binding for one (session, agent) (no-op when unset). */
  clearSessionEffort: (sessionId: string, agent: AgentWireName) => void;
}

/**
 * Imperative (non-reactive) accessor for the (session, agent)->effort map.
 * Components keep selected state in plain `useState` and call these to
 * persist/restore.
 */
export function useSessionEffort(): SessionEffortApi {
  const getSessionEffort = useCallback(
    (sessionId: string, agent: AgentWireName): string | null => readSessionEffort(sessionId, agent),
    []
  );

  const setSessionEffort = useCallback(
    (sessionId: string, agent: AgentWireName, selection: string): void =>
      writeSessionEffort(sessionId, agent, selection),
    []
  );

  const clearSessionEffort = useCallback(
    (sessionId: string, agent: AgentWireName): void => removeSessionEffort(sessionId, agent),
    []
  );

  return { getSessionEffort, setSessionEffort, clearSessionEffort };
}
