import {
  type ExtensionUiDisplayState,
  pruneExtensionUiDisplayState,
} from '@/components/chat/extensionUiDisplayModel';
import type { ExtensionUiState } from '@/components/chat/extensionUiModel';
import type { SubagentActivityState } from '@/components/chat/subagentActivityModel';
import type { SessionRuntimeFactsState } from '@/components/workspace-shell/surfaces/contextSurfaceModel';
import { useExtensionUiStore } from './extensionUi';
import { useExtensionUiDisplayStore } from './extensionUiDisplay';
import { useSessionRuntimeFactsStore } from './sessionRuntimeFacts';
import { useSubagentActivityStore } from './subagentActivity';
import { useToolExpansionStore } from './toolExpansion';

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

/** Clear all adjacent session-keyed renderer stores after tree synchronization. */
export function pruneSessionScopedRendererState(sessionIds: readonly string[]): void {
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
