import {
  type ExtensionUiDisplayState,
  pruneExtensionUiDisplayState,
} from '@/components/chat/extensionUiDisplayModel';
import type { ExtensionUiState } from '@/components/chat/extensionUiModel';
import type { SubagentActivityState } from '@/components/chat/subagentActivityModel';
import type { SessionRuntimeFactsState } from '@/components/workspace-shell/surfaces/contextSurfaceModel';
import { useExtensionUiStore } from './extensionUi';
import { useExtensionUiDisplayStore } from './extensionUiDisplay';
import { useMessageQueueStore } from './messageQueue';
import { usePendingUserMessagesStore } from './pendingUserMessages';
import { useSessionRuntimeFactsStore } from './sessionRuntimeFacts';
import { useSubagentActivityStore } from './subagentActivity';
import { useToolExpansionStore } from './toolExpansion';
import { useTurnSendStatusStore } from './turnSendStatus';

export function pruneRecordBySession<T>(
  record: Readonly<Record<string, T>>,
  sessionIds: readonly string[]
): Record<string, T> {
  const live = new Set(sessionIds);
  return Object.fromEntries(Object.entries(record).filter(([sessionId]) => live.has(sessionId)));
}

export function pruneExtensionUiState(
  state: ExtensionUiState,
  sessionIds: readonly string[]
): ExtensionUiState {
  const live = new Set(sessionIds);
  const pending = state.pending.filter((dialog) =>
    dialog.sessionId == null ? sessionIds.length > 0 : live.has(dialog.sessionId)
  );
  const pendingIds = new Set(pending.map((dialog) => dialog.uiRequestId));
  return {
    pending,
    sending: state.sending.filter((id) => pendingIds.has(id)),
    sendErrors: Object.fromEntries(
      Object.entries(state.sendErrors).filter(([id]) => pendingIds.has(id))
    ),
  };
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
    factsBySession: omitSession(state.factsBySession as SessionRuntimeFactsState, sessionId),
  }));
  useToolExpansionStore.setState((state) => ({
    bySession: omitSession(state.bySession, sessionId),
  }));
  useExtensionUiStore.setState((state) => {
    const pending = state.pending.filter((dialog) => dialog.sessionId !== sessionId);
    const pendingIds = new Set(pending.map((dialog) => dialog.uiRequestId));
    return {
      pending,
      sending: state.sending.filter((id) => pendingIds.has(id)),
      sendErrors: Object.fromEntries(
        Object.entries(state.sendErrors).filter(([id]) => pendingIds.has(id))
      ),
    };
  });
  useExtensionUiDisplayStore.setState((state) => ({
    statuses: Object.fromEntries(
      Object.entries(state.statuses).filter(([, item]) => item.sessionId !== sessionId)
    ),
    widgets: Object.fromEntries(
      Object.entries(state.widgets).filter(([, item]) => item.sessionId !== sessionId)
    ),
    unsupported: Object.fromEntries(
      Object.entries(state.unsupported).filter(([, item]) => item.sessionId !== sessionId)
    ),
    notifications: state.notifications.filter((item) => item.sessionId !== sessionId),
  }));
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
  useExtensionUiStore.setState((state) => pruneExtensionUiState(state, sessionIds));
  useExtensionUiDisplayStore.setState((state) =>
    pruneExtensionUiDisplayState(state as ExtensionUiDisplayState, sessionIds)
  );
  useSubagentActivityStore.setState((state) => pruneSubagentActivityState(state, sessionIds));
}
