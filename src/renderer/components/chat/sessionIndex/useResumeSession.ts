import { useCallback } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { shouldResumeSession } from './resumeIntent';

/**
 * Hook exposing the user-driven "resume historical session" action (T-03).
 *
 * Brings a session into focus and asks the Agent Host to replay its
 * transcript. The Host emits `session.resumed → session.history → status
 * idle`; the red-line store already folds `session.history` into the
 * timeline (history messages use `h:` prefix, runtime messages untouched).
 *
 * Renderer-only: does not touch chatSessions.ts. Status display + first
 * user prompt preview come from index (listHistory) and the live store.
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
        useChatSessionsStore.setState({
          activeSessionId: sessionId,
          lastError: null,
        });
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  return { resume };
}
