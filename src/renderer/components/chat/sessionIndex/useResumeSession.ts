import { useCallback } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { encodePiResumeError } from '../historyError';
import { shouldApplyResumeResult, shouldResumeSession } from './resumeIntent';

/**
 * Hook exposing the user-driven "resume historical session" action (T-03).
 *
 * Brings a session into focus and asks the Agent Host to replay its
 * transcript. The Host emits `session.resumed → session.history → status
 * idle`; the red-line store already folds `session.history` into the
 * timeline (history messages use `h:` prefix, runtime messages untouched).
 *
 * Renderer-only: does not read Pi JSONL. Session metadata comes from the
 * durable index; branch history arrives only through WorkerSlot RuntimeEvents.
 */

export interface UseResumeSessionResult {
  resume: (
    sessionId: string,
    options?: { persistedRuntimeIdentity?: string; model?: string }
  ) => Promise<boolean>;
}

export function useResumeSession(): UseResumeSessionResult {
  const resume = useCallback(
    async (
      sessionId: string,
      options: { persistedRuntimeIdentity?: string; model?: string } = {}
    ): Promise<boolean> => {
      const state = useChatSessionsStore.getState();
      const session = state.sessions.find((item) => item.id === sessionId);
      const workspace = state.workspaces.find((ws) => ws.id === session?.workspaceId);
      const intent = shouldResumeSession(session, workspace, {
        persistedRuntimeIdentity: options.persistedRuntimeIdentity,
        model: options.model,
      });
      if (!intent.shouldResume || !intent.args) return false;

      try {
        await window.electronAPI.chat.resumeSession(intent.args);
        // F2 (D29 adversarial-review, major): guard against the race where
        // the user selects a different session while resumeSession is in
        // flight (see shouldApplyResumeResult's doc comment — most visible on
        // a cold-start resume). Both callers already set activeSessionId to
        // sessionId synchronously before calling resume(), so this write is a
        // redundant backstop; skipping it here is zero-risk when the guard
        // fails and prevents dragging the user back to a session they left.
        if (shouldApplyResumeResult(useChatSessionsStore.getState().activeSessionId, sessionId)) {
          useChatSessionsStore.setState({
            activeSessionId: sessionId,
            lastError: null,
          });
        }
        return true;
      } catch (error) {
        const encodedError = encodePiResumeError(error);
        useChatSessionsStore.setState((current) => ({
          lastError: encodedError.message,
          historyErrors: {
            ...current.historyErrors,
            [sessionId]: encodedError.encoded,
          },
        }));
        return false;
      }
    },
    []
  );

  return { resume };
}
