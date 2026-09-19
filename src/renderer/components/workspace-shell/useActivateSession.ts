/**
 * D08 (U15-c): the single "start this session" path.
 *
 * Under D08 clicking a session in the dock no longer just switches the center
 * column — it STARTS the session and gives it a tab. Two callers need that same
 * behaviour (the dock's session rows and the center tab strip, the latter
 * because a persisted tab survives a restart with no timeline loaded), and the
 * resume decision is subtle enough that a second copy would drift:
 *
 *   - resume only when the session has a runtime identity AND no timeline yet,
 *   - resolve the model the same way the Composer's trigger does (F9/D48 S2),
 *     because a model-less resume silently hands the turn to the gateway default,
 *   - treat an unbound session as resumable even though it has no workspace.
 *
 * Opening the tab is NOT done here. `WorkspaceShell` mirrors `activeSessionId`
 * into the tab list with one effect, so every existing `selectSession(...)` call
 * site — new chat, fork, index resume — gets a tab without being touched. See
 * `sessionTabsModel.ts`.
 */
import { useCallback } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useResumeSession } from '../chat/sessionIndex/useResumeSession';
import { useResolvedSessionModel } from '../chat/useResolvedSessionModel';
import { runSessionActivation } from './activateSessionStart';

export type ActivateSession = (sessionId: string, persistedRuntimeIdentity?: string) => void;

export function useActivateSession(): ActivateSession {
  const selectSession = useChatSessionsStore((state) => state.selectSession);
  const { resume } = useResumeSession();
  const resolveSessionModel = useResolvedSessionModel();

  return useCallback(
    (sessionId: string, persistedRuntimeIdentity?: string) => {
      selectSession(sessionId);
      // Read fresh store state at click time rather than a render-body
      // snapshot: this handler can fire well after the render that created it.
      const state = useChatSessionsStore.getState();
      const session = state.sessions.find((item) => item.id === sessionId);
      const workspace = state.workspaces.find((ws) => ws.id === session?.workspaceId);
      const runtimeIdentity = session?.runtimeIdentity ?? persistedRuntimeIdentity;
      // The three-part rule (identity / somewhere to run / no timeline yet) is
      // stated in `activateSessionStart.ts`, together with T102's preview-first
      // rule; the cwd a resume runs into stays inside `shouldResumeSession`.
      void runSessionActivation(
        {
          sessionId,
          runtimeIdentity,
          hasWorkspace: workspace != null,
          unbound: session?.unbound != null,
          hasTimeline: (state.messages[sessionId]?.length ?? 0) > 0,
          hostBound: state.hostBoundSessionIds.includes(sessionId),
        },
        {
          // Offset omitted rather than 0: the reader defaults to the newest
          // page, which is the one a click wants.
          preview: (input) =>
            window.electronAPI.chat.readSessionPage({
              sessionId: input.sessionId,
              limit: 80,
            }),
          resume: (input) =>
            resume(input.sessionId, {
              persistedRuntimeIdentity: input.runtimeIdentity,
              model: resolveSessionModel(input.sessionId),
            }),
        }
      );
    },
    [selectSession, resume, resolveSessionModel]
  );
}
