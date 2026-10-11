/**
 * dsh-rebase decision 176 — `sessionStart.ts` wired to this window: the chat
 * store, the stored preferences and `window.electronAPI`.
 *
 * `preferences` reads what `runSend` reads, in the order it reads it — the
 * defaults pinned on first use (`captureSessionGenerationPreferences`), the
 * model (`resolveResumeModel`), the effort (`toWireEffort` of the stored or
 * template selection), the permissions (the session's, else the default) —
 * so a start made for an operation and a send's resume name the same thing,
 * and Main joins the two when they overlap. The directory is the send path's
 * too (`runDirectory.ts`): a temporary chat's scratch directory comes from the
 * store `runSend` asks (GUI point-check fix, 2026-10-11).
 */

import { agentDefaultEffort, agentDefaultModel } from '@shared/models/chatAgentDefaults';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSettingsStore } from '@/stores/settings';
import { resolveEffortSelection, toWireEffort } from './efforts';
import { resolveResumeModel } from './models';
import { ensureScratchRunDirectory } from './runDirectory';
import { captureSessionGenerationPreferences } from './sessionGenerationPreferences';
import { resumeSessionWithMigration } from './sessionIndex/legacyMigration';
import {
  readDefaultPermissions,
  readSessionEffort,
  readSessionModel,
  readSessionPermissions,
} from './sessionPreferenceStore';
import {
  type SessionStartDeps,
  type SessionStartEffects,
  type SessionStartOutcome,
  type SessionStartPreferences,
  startSessionAsSendDoes,
} from './sessionStart';

/** What a send started now would start this conversation on. */
export function sendStartPreferences(sessionId: string): SessionStartPreferences {
  const defaults = useSettingsStore.getState().chatAgentDefaults;
  captureSessionGenerationPreferences(sessionId, defaults);
  const model = resolveResumeModel(readSessionModel, sessionId, agentDefaultModel(defaults));
  const effort = toWireEffort(
    resolveEffortSelection(readSessionEffort(sessionId), agentDefaultEffort(defaults))
  );
  const permissions = readSessionPermissions(sessionId) ?? readDefaultPermissions() ?? undefined;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(permissions ? { permissions } : {}),
  };
}

function markRunning(sessionId: string, running: boolean): void {
  useChatSessionsStore.setState((state) => {
    const listed = state.hostBoundSessionIds.includes(sessionId);
    if (listed === running) return state;
    return {
      hostBoundSessionIds: running
        ? [...state.hostBoundSessionIds, sessionId]
        : state.hostBoundSessionIds.filter((id) => id !== sessionId),
    };
  });
}

export function sessionStartDeps(): SessionStartDeps {
  return {
    snapshot: (sessionId) => {
      const state = useChatSessionsStore.getState();
      const session = state.sessions.find((item) => item.id === sessionId);
      return {
        running: state.hostBoundSessionIds.includes(sessionId),
        session,
        workspace: state.workspaces.find((workspace) => workspace.id === session?.workspaceId),
      };
    },
    preferences: sendStartPreferences,
    ensureHost: () => window.electronAPI.chat.ensureHost(),
    resume: (args) => resumeSessionWithMigration(args),
    markRunning,
    fileFailure: (sessionId, encoded) =>
      useChatSessionsStore.setState((state) => ({
        historyErrors: { ...state.historyErrors, [sessionId]: encoded },
      })),
    // The send path's own allocation (`runSend` asks the same store).
    ensureScratchDirectory: ensureScratchRunDirectory,
  };
}

export function startSession(sessionId: string): Promise<SessionStartOutcome> {
  return startSessionAsSendDoes(sessionId, sessionStartDeps());
}

/** `runWithSessionStarted`'s three effects, bound to this window. */
export const sessionStartEffects: SessionStartEffects = {
  start: startSession,
  isRunning: (sessionId) => useChatSessionsStore.getState().hostBoundSessionIds.includes(sessionId),
  forgetRunning: (sessionId) => markRunning(sessionId, false),
};
