/**
 * Layout 5b: the sidebar's back / forward over the conversations visited in
 * this run (memory only; a restart starts empty). Pure — `useVisitHistory`
 * feeds it the open conversation and performs the step it answers.
 *
 * The home page is not an entry: back from it returns to the conversation
 * last open, which is what the user left to go there.
 */

export interface VisitHistory {
  entries: readonly string[];
  /** The entry the user is at; -1 while empty. */
  index: number;
}

/** Enough to walk back through a working session; older visits fall off. */
export const VISIT_HISTORY_LIMIT = 50;

export const EMPTY_VISIT_HISTORY: VisitHistory = { entries: [], index: -1 };

/**
 * A conversation was opened. Re-opening the current entry changes nothing
 * (which is also what keeps a back / forward step from recording itself); a
 * new one drops the forward entries, like a browser.
 */
export function recordVisit(history: VisitHistory, sessionId: string | null): VisitHistory {
  if (sessionId === null) return history;
  if (history.entries[history.index] === sessionId) return history;
  const kept = [...history.entries.slice(0, history.index + 1), sessionId];
  const entries = kept.slice(-VISIT_HISTORY_LIMIT);
  return { entries, index: entries.length - 1 };
}

export interface VisitStep {
  history: VisitHistory;
  sessionId: string;
}

/**
 * Where back (-1) or forward (+1) goes from `current`, skipping conversations
 * that are gone (archived, removed), or null at the end. Off the current
 * entry (the home page) back lands on that entry itself first.
 */
export function stepVisit(
  history: VisitHistory,
  direction: -1 | 1,
  current: string | null,
  isAlive: (sessionId: string) => boolean
): VisitStep | null {
  const onEntry = current !== null && history.entries[history.index] === current;
  let at = direction === -1 && !onEntry ? history.index : history.index + direction;
  while (at >= 0 && at < history.entries.length) {
    const sessionId = history.entries[at];
    if (sessionId !== undefined && sessionId !== current && isAlive(sessionId)) {
      return { history: { entries: history.entries, index: at }, sessionId };
    }
    at += direction;
  }
  return null;
}
