/**
 * dsh-rebase P1-7a: the todo card and the goal bar, stacked above the
 * composer (decision 068 as revised by 090 and 109: these two stay here; the
 * background tasks and subagents moved to floating sub-windows, P1-7b).
 *
 * Order and form follow the P1-7 prototype (evidence/p1-7-prototype-2026-09-28,
 * scene B): todo first, goal under it, one row each (28 px) when folded, 4 px
 * apart and 8 px above what follows; each opens in place. A strip with nothing
 * to say is not drawn. They sit above the answerable question and permission
 * cards, which stay nearest the composer (plan P1-7 shard 03 §1).
 *
 * The strips read `stores/sessionPanels.ts`; what they show is
 * `sessionPanelsModel.ts`'s. Their buttons run DSH's `/goal …` out of band
 * (`worker.command`), so nothing is queued behind a running turn and no
 * model turn is opened for them.
 */

import { useEffect } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { GoalBar } from './GoalBar';
import { ReadingColumn } from './ReadingColumn';
import { deriveGoalBarView, deriveTodoCardView } from './sessionPanelsModel';
import { TodoCard } from './TodoCard';
import { isTurnInFlight } from './turnHead';

/** Same wrapper contract as the composer host: the reading column's width, 8 px above the next row. */
export function sessionPanelStripsHostClass(): string {
  return 'min-w-0 shrink-0 px-6 pb-2';
}

/** Two strips, 4 px apart (the queue strip's `gap-1`). */
export function sessionPanelStripsClass(): string {
  return 'flex flex-col gap-1';
}

export function SessionPanelStrips({ sessionId }: { sessionId: string | null }) {
  const panels = useSessionPanelsStore((state) =>
    sessionId ? state.bySession[sessionId] : undefined
  );
  const dismissed = useSessionPanelsStore((state) =>
    sessionId ? state.dismissed[sessionId] : undefined
  );
  const ensureHydrated = useSessionPanelsStore((state) => state.ensureHydrated);
  const turnInFlight = useChatSessionsStore((state) => {
    const status = state.sessions.find((session) => session.id === sessionId)?.status;
    return status ? isTurnInFlight(status) : false;
  });

  // A chat this window knows nothing about (a reload, a chat switched to):
  // ask its worker once. A chat with no running worker answers nothing.
  useEffect(() => {
    if (sessionId) ensureHydrated(sessionId);
  }, [sessionId, ensureHydrated]);

  if (!sessionId) return null;
  const todo = deriveTodoCardView(panels);
  const goal = deriveGoalBarView(panels, turnInFlight, dismissed);
  if (!todo && !goal) return null;

  return (
    <div className={sessionPanelStripsHostClass()} data-testid="session-panel-strips">
      <ReadingColumn className={sessionPanelStripsClass()}>
        {todo && <TodoCard sessionId={sessionId} view={todo} />}
        {goal && <GoalBar sessionId={sessionId} view={goal} />}
      </ReadingColumn>
    </div>
  );
}
