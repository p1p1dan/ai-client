/**
 * Layout 5b: wires `visitHistory` to the open conversation, the sidebar's
 * back / forward buttons and Alt+Left / Alt+Right.
 */
import { useCallback, useEffect, useState } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useActivateSession } from '../useActivateSession';
import { EMPTY_VISIT_HISTORY, recordVisit, stepVisit, type VisitHistory } from './visitHistory';

/** Text fields, Monaco and xterm (both type into a hidden textarea) keep Alt+arrows. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function useVisitHistory() {
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const activateSession = useActivateSession();
  const [history, setHistory] = useState<VisitHistory>(EMPTY_VISIT_HISTORY);

  useEffect(() => {
    setHistory((current) => recordVisit(current, activeSessionId));
  }, [activeSessionId]);

  const isAlive = useCallback(
    (sessionId: string) => sessions.some((session) => session.id === sessionId),
    [sessions]
  );
  const back = stepVisit(history, -1, activeSessionId, isAlive);
  const forward = stepVisit(history, 1, activeSessionId, isAlive);

  const go = useCallback(
    (direction: -1 | 1) => {
      const step = stepVisit(history, direction, activeSessionId, isAlive);
      if (!step) return;
      // Index first: the activation then re-opens the current entry, which
      // `recordVisit` ignores — the step does not record itself.
      setHistory(step.history);
      activateSession(step.sessionId);
    },
    [history, activeSessionId, isAlive, activateSession]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      go(event.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [go]);

  return {
    canGoBack: back !== null,
    canGoForward: forward !== null,
    goBack: () => go(-1),
    goForward: () => go(1),
  };
}
