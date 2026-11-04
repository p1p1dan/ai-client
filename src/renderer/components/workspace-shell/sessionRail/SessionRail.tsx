import { useEffect, useMemo } from 'react';
import { useSessionLanes } from '@/components/chat/BackgroundJobsWindow';
import { deriveTodoCardView } from '@/components/chat/sessionPanelsModel';
import { useSubwindowClock } from '@/components/chat/useSubwindowClock';
import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import { useSessionSubwindowsStore } from '@/stores/sessionSubwindows';
import { stopBackgroundTask } from '../panes/BackgroundTasksPane';
import { deriveBackgroundTasksView } from '../panes/backgroundTasksModel';
import { deriveSessionReview, type SessionReviewEntry } from '../sessionReview';
import type { PaneKind } from '../workPanelModel';
import { ChangesCard } from './ChangesCard';
import { ContextCard } from './ContextCard';
import { EnvironmentCard, useEnvironmentRows } from './EnvironmentCard';
import { OutputsCard } from './OutputsCard';
import { deriveSessionOutputs } from './outputsModel';
import { RunningCard } from './RunningCard';
import { ServersCard } from './ServersCard';
import { SubagentsCard } from './SubagentsCard';
import {
  deriveChangesCardView,
  deriveContextCardView,
  railRunningRows,
  SESSION_RAIL_WIDTH,
  visibleRailCards,
} from './sessionRailModel';
import { deriveSubagentsCardView } from './subagentsCardModel';
import { TodoRailCard } from './TodoRailCard';
import { useJobServers } from './useJobServers';

const NO_HIDDEN: readonly string[] = [];

export interface SessionRailProps {
  sessionId: string;
  /** The session review's entries; null while the review is off (setting). */
  reviewEntries: readonly SessionReviewEntry[] | null;
  onOpenPane: (kind: PaneKind) => void;
  onRevealChange: (target: { entryId: string; path: string }) => void;
}

/**
 * Layout 5e (ui-cohesion §6, ruling L5): the session details panel — a 260px
 * column right of the chat, cards stacked 8px apart, scrolling when tall.
 * Environment, context, outputs, changes, todo, subagents, servers, running; a card with nothing to say
 * is not drawn. Whether the rail is on screen at all is the shell's call
 * (`resolveSessionRailVisibility`).
 */
export function SessionRail({
  sessionId,
  reviewEntries,
  onOpenPane,
  onRevealChange,
}: SessionRailProps) {
  const { t } = useI18n();

  const environmentRows = useEnvironmentRows(sessionId);

  const usage = useSessionRuntimeFactsStore(
    (state) => state.factsBySession[sessionId]?.usage ?? null
  );
  const hasMessages = useChatSessionsStore((state) => (state.messages[sessionId]?.length ?? 0) > 0);
  const contextView = useMemo(
    () => deriveContextCardView({ usage, hasMessages }),
    [usage, hasMessages]
  );

  const changesView = useMemo(() => deriveChangesCardView(reviewEntries), [reviewEntries]);

  // Decision 209 §2: read from the history on its own, so the 「会话改动」
  // setting (which gates `reviewEntries`) has no say. The review derivation
  // caches per message, so this costs nothing the changes card has not paid.
  const messages = useChatSessionsStore((state) => state.messages[sessionId]);
  const outputs = useMemo(
    () => deriveSessionOutputs(deriveSessionReview(messages ?? [])),
    [messages]
  );
  const workspacePath = useChatSessionsStore((state) => {
    const session = state.sessions.find((entry) => entry.id === sessionId);
    const workspace = state.workspaces.find((entry) => entry.id === session?.workspaceId);
    return workspace?.path?.trim() ? workspace.path : null;
  });

  const panels = useSessionPanelsStore((state) => state.bySession[sessionId]);
  const ensureHydrated = useSessionPanelsStore((state) => state.ensureHydrated);
  useEffect(() => {
    ensureHydrated(sessionId);
  }, [sessionId, ensureHydrated]);
  const todoView = useMemo(() => deriveTodoCardView(panels), [panels]);

  const hidden = useSessionSubwindowsStore((state) => state.hiddenJobs[sessionId] ?? NO_HIDDEN);
  const lanes = useSessionLanes(sessionId);
  // The clock ticks only while something runs (the tasks pane's rule).
  const anyRunning =
    lanes.some((lane) => lane.status === 'running') ||
    (panels?.live === true &&
      (panels.jobs ?? []).some((job) => job.status === 'running' || job.status === 'stopping'));
  const now = useSubwindowClock(anyRunning);
  const running = useMemo(
    () => railRunningRows(deriveBackgroundTasksView({ panels, lanes, hidden, now }).running),
    [panels, lanes, hidden, now]
  );
  const subagentsView = useMemo(
    () => deriveSubagentsCardView({ panels, lanes, now, t }),
    [panels, lanes, now, t]
  );

  const servers = useJobServers(sessionId, panels?.jobs, panels?.live === true);

  const cards = visibleRailCards({
    environmentRows: environmentRows.length,
    context: contextView !== null,
    outputs: outputs.length > 0,
    changes: changesView !== null,
    todo: todoView !== null,
    subagents: subagentsView !== null,
    servers: servers.length,
    running: running.length,
  });

  return (
    <aside
      aria-label={t('Session details')}
      className="flex min-h-0 shrink-0 flex-col gap-2 overflow-y-auto py-2 pr-2"
      style={{ width: SESSION_RAIL_WIDTH }}
      data-session-rail=""
    >
      {cards.map((id) => {
        switch (id) {
          case 'environment':
            return <EnvironmentCard key={id} rows={environmentRows} />;
          case 'context':
            return contextView && <ContextCard key={id} sessionId={sessionId} view={contextView} />;
          case 'outputs':
            return <OutputsCard key={id} rows={outputs} workspacePath={workspacePath} />;
          case 'changes':
            return (
              changesView && (
                <ChangesCard
                  key={id}
                  view={changesView}
                  onOpenChanges={() => onOpenPane('changes')}
                  onRevealFile={onRevealChange}
                  onCommit={() => onOpenPane('git')}
                />
              )
            );
          case 'todo':
            return todoView && <TodoRailCard key={id} view={todoView} />;
          case 'subagents':
            return (
              subagentsView && (
                <SubagentsCard
                  // Per session: an open row or the ended fold is this chat's, not the next one's.
                  key={`${id}:${sessionId}`}
                  sessionId={sessionId}
                  view={subagentsView}
                  onInterrupt={(target) => void stopBackgroundTask(sessionId, target, t)}
                />
              )
            );
          case 'servers':
            return <ServersCard key={id} rows={servers} />;
          case 'running':
            return (
              <RunningCard
                key={id}
                rows={running}
                onOpenTasks={() => onOpenPane('tasks')}
                onStop={(target) => void stopBackgroundTask(sessionId, target, t)}
              />
            );
          default:
            return null;
        }
      })}
    </aside>
  );
}
