import type { SubagentActivityState } from '@/components/chat/subagentActivityModel';
import type { SessionRuntimeFactsState } from '@/components/workspace-shell/surfaces/contextSurfaceModel';
import { useComposerDraftsStore } from './composerDrafts';
import { useMessageMetadataStore } from './messageMetadataRegistry';
import { useMessageQueueStore } from './messageQueue';
import { usePendingUserMessagesStore } from './pendingUserMessages';
import { useSessionPanelsStore } from './sessionPanels';
import { useSessionRuntimeFactsStore } from './sessionRuntimeFacts';
import { useSessionSubwindowsStore } from './sessionSubwindows';
import { useSubagentActivityStore } from './subagentActivity';
import { useToolExpansionStore } from './toolExpansion';
import { useToolLiveOutputStore } from './toolLiveOutput';
import { useTurnSendStatusStore } from './turnSendStatus';
import { useTurnTimingStore } from './turnTimingRegistry';

export function pruneRecordBySession<T>(
  record: Readonly<Record<string, T>>,
  sessionIds: readonly string[]
): Record<string, T> {
  const live = new Set(sessionIds);
  return Object.fromEntries(Object.entries(record).filter(([sessionId]) => live.has(sessionId)));
}

export function pruneSubagentActivityState(
  state: SubagentActivityState,
  sessionIds: readonly string[]
): SubagentActivityState {
  const live = new Set(sessionIds);
  const keptLaneEntries = Object.entries(state.lanes).filter(([, lane]) =>
    live.has(lane.sessionId)
  );
  const keptLanes = Object.fromEntries(keptLaneEntries);
  const keptParentIds = new Set(keptLaneEntries.map(([, lane]) => lane.parentToolCallId));
  const agentIndex = Object.fromEntries(
    Object.entries(state.agentIndex).filter(([, parentToolCallId]) =>
      keptParentIds.has(parentToolCallId)
    )
  );
  const permissionOrigin = Object.fromEntries(
    Object.entries(state.permissionOrigin).filter(
      ([, origin]) => origin.parentToolCallId == null || keptParentIds.has(origin.parentToolCallId)
    )
  );
  return { lanes: keptLanes, agentIndex, permissionOrigin, nextOrdinal: state.nextOrdinal };
}

function omitSession<T>(record: Readonly<Record<string, T>>, sessionId: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== sessionId));
}

/** Clear transient renderer projections before replacing one session's active branch. */
export function resetSessionScopedRendererState(sessionId: string): void {
  useMessageQueueStore.setState((state) => ({
    state: { bySession: omitSession(state.state.bySession, sessionId) },
  }));
  usePendingUserMessagesStore.setState((state) => ({
    bySession: omitSession(state.bySession, sessionId),
  }));
  useTurnSendStatusStore.setState((state) => ({
    status: state.status?.sessionId === sessionId ? null : state.status,
    baseline: state.baseline?.sessionId === sessionId ? null : state.baseline,
    pendingReply: state.pendingReply?.sessionId === sessionId ? null : state.pendingReply,
  }));
  useSessionRuntimeFactsStore.setState((state) => ({
    factsBySession: omitSession(state.factsBySession, sessionId),
  }));
  useToolExpansionStore.setState((state) => ({
    bySession: omitSession(state.bySession, sessionId),
  }));
  // P1-7e (problem 16): the live stamps name messages of the branch being
  // replaced. The composer's draft is NOT cleared here: it is what the user
  // typed, and a rewind hands its prompt back into it (problem 1).
  useMessageMetadataStore.getState().resetSession(sessionId);
  // P1-7e (decision 140): the thought and tool stamps of that branch too.
  useTurnTimingStore.getState().resetSession(sessionId);
  useSubagentActivityStore.setState((state) => {
    const liveSessionIds = [
      ...new Set(
        Object.values(state.lanes)
          .map((lane) => lane.sessionId)
          .filter((id) => id !== sessionId)
      ),
    ];
    return pruneSubagentActivityState(state, liveSessionIds);
  });
}

/** Clear every transient renderer projection for sessions absent from the live tree. */
export function pruneSessionScopedRendererState(sessionIds: readonly string[]): void {
  const live = new Set(sessionIds);
  useMessageQueueStore.getState().pruneSessions(sessionIds);
  usePendingUserMessagesStore.getState().pruneSessions(sessionIds);
  useTurnSendStatusStore.setState((state) => ({
    status: state.status && live.has(state.status.sessionId) ? state.status : null,
    baseline: state.baseline && live.has(state.baseline.sessionId) ? state.baseline : null,
    pendingReply:
      state.pendingReply && live.has(state.pendingReply.sessionId) ? state.pendingReply : null,
  }));
  useSessionRuntimeFactsStore.setState((state) => ({
    factsBySession: pruneRecordBySession(
      state.factsBySession as SessionRuntimeFactsState,
      sessionIds
    ),
  }));
  useToolExpansionStore.setState((state) => ({
    bySession: pruneRecordBySession(state.bySession, sessionIds),
  }));
  useSubagentActivityStore.setState((state) => pruneSubagentActivityState(state, sessionIds));
  useSessionPanelsStore.getState().pruneSessions(sessionIds);
  // dsh-rebase P1-7b: the live output of running commands and the jobs window's put-away list.
  useToolLiveOutputStore.getState().pruneSessions(sessionIds);
  useSessionSubwindowsStore.getState().pruneSessions(sessionIds);
  // dsh-rebase P1-7e: the turn clock's live stamps (problem 16) and the parked
  // composer drafts (problem 33) of chats that are gone.
  useMessageMetadataStore.getState().pruneSessions(sessionIds);
  useComposerDraftsStore.getState().pruneSessions(sessionIds);
  // P1-7e (decision 140): the thought and tool stamps of chats that are gone.
  useTurnTimingStore.getState().pruneSessions(sessionIds);
}
