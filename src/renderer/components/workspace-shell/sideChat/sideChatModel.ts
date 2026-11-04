/**
 * Layout 5f (ui-cohesion §6, ruling L6): the pure half of the side chat — a
 * quick question about the conversation so far (Ctrl+; or `/btw`), answered
 * beside it. It reads the main conversation and writes nothing back; closing
 * it discards it (Claude Code desktop does not save side chats either).
 *
 * Two forms (decision 209 §3, overturning L6's corner window): a window of its
 * own (the default) that can go anywhere on any screen and stays on top of the
 * main window, or docked as a column right of the chat, where the session rail
 * would be. Which one is on screen is derived per render
 * (`resolveSideChatPlacement`).
 *
 * It belongs to the conversation it was opened on, and stays on it while the
 * main window shows another (decision 209 ruling 4); only one is open at a time.
 *
 * No React, no store, no IPC: node-env tests assert every rule here.
 */
import type { WorkerSideQuestionTurn } from '@shared/types/workerRpc';
import { WORKER_SIDE_QUESTION_MAX_TURNS } from '@shared/types/workerRpc';

export type SideChatForm = 'window' | 'dock';

export type SideChatEntryStatus = 'pending' | 'answered' | 'no-answer' | 'failed';

export interface SideChatEntry {
  id: string;
  question: string;
  status: SideChatEntryStatus;
  answer?: string;
  /** A dictionary key: why there is no answer. */
  errorKey?: string;
}

export interface SideChatState {
  open: boolean;
  /** The user's form; kept across closes. */
  form: SideChatForm;
  /** The conversation the side chat reads. */
  sessionId: string | null;
  entries: SideChatEntry[];
}

/** The docked column's width. */
export const SIDE_CHAT_DOCK_WIDTH = 380;
/**
 * The narrowest chat left beside a docked side chat; below it the docked
 * column lies over the chat instead (decision 209 §4, §5).
 */
export const SIDE_CHAT_MIN_CHAT_WIDTH = 480;

export const INITIAL_SIDE_CHAT: SideChatState = {
  open: false,
  form: 'window',
  sessionId: null,
  entries: [],
};

/**
 * Open on `sessionId`. Already open on it: unchanged. Open on another
 * conversation: that side chat is discarded and a fresh one starts — a side
 * chat belongs to the conversation it reads.
 */
export function openSideChat(state: SideChatState, sessionId: string): SideChatState {
  if (state.open && state.sessionId === sessionId) return state;
  return { open: true, form: state.form, sessionId, entries: [] };
}

/** Close and discard everything said in it; the form is remembered. */
export function closeSideChat(state: SideChatState): SideChatState {
  if (!state.open && state.entries.length === 0 && state.sessionId === null) return state;
  return { open: false, form: state.form, sessionId: null, entries: [] };
}

/**
 * Ctrl+;, the title-bar button and `/btw` (decision 209 §3): open on this
 * conversation → close; open on another one → move to this one (what was
 * asked there is discarded, one side chat at a time); closed → open on it.
 * With no conversation open, only closing is possible.
 */
export function toggleSideChat(state: SideChatState, sessionId: string | null): SideChatState {
  if (state.open && (state.sessionId === sessionId || !sessionId)) return closeSideChat(state);
  return sessionId ? openSideChat(state, sessionId) : state;
}

export function setSideChatForm(state: SideChatState, form: SideChatForm): SideChatState {
  return state.form === form ? state : { ...state, form };
}

/**
 * Decision 209 ruling 4: switching the main window to another conversation
 * leaves the side chat where it is. It closes only when its own conversation
 * is gone from the list (deleted or archived) — `liveSessionIds` is the
 * session tree's, as the other session-scoped stores prune against.
 */
export function pruneSideChat(
  state: SideChatState,
  liveSessionIds: readonly string[]
): SideChatState {
  return state.open && state.sessionId !== null && !liveSessionIds.includes(state.sessionId)
    ? closeSideChat(state)
    : state;
}

/** One question waits for its answer; the box sends nothing more meanwhile. */
export function sideChatBusy(state: SideChatState): boolean {
  return state.entries.some((entry) => entry.status === 'pending');
}

export function pendingSideQuestionIds(state: SideChatState): string[] {
  return state.entries.filter((entry) => entry.status === 'pending').map((entry) => entry.id);
}

/** Ask `question` on `sessionId`, opening the side chat on it first if needed. */
export function addSideQuestion(
  state: SideChatState,
  sessionId: string,
  id: string,
  question: string
): SideChatState {
  const opened = openSideChat(state, sessionId);
  return {
    ...opened,
    entries: [...opened.entries, { id, question: question.trim(), status: 'pending' }],
  };
}

export type SideQuestionOutcome =
  | { kind: 'answer'; text: string | null }
  | { kind: 'failed'; errorKey: string };

/**
 * The answer to question `id`. A question no longer in the side chat (it was
 * closed, or reopened on another conversation) is dropped: its answer arrives
 * to nothing.
 */
export function settleSideQuestion(
  state: SideChatState,
  id: string,
  outcome: SideQuestionOutcome
): SideChatState {
  const index = state.entries.findIndex((entry) => entry.id === id);
  const entry = state.entries[index];
  if (!entry || entry.status !== 'pending') return state;
  const settled: SideChatEntry =
    outcome.kind === 'failed'
      ? { id, question: entry.question, status: 'failed', errorKey: outcome.errorKey }
      : outcome.text?.trim()
        ? { id, question: entry.question, status: 'answered', answer: outcome.text }
        : { id, question: entry.question, status: 'no-answer' };
  const entries = state.entries.slice();
  entries[index] = settled;
  return { ...state, entries };
}

/** The earlier answered questions of this side chat, for a follow-up (newest last). */
export function sideQuestionHistory(
  entries: readonly SideChatEntry[],
  beforeId: string
): WorkerSideQuestionTurn[] {
  const turns: WorkerSideQuestionTurn[] = [];
  for (const entry of entries) {
    if (entry.id === beforeId) break;
    if (entry.status === 'answered' && entry.answer) {
      turns.push({ question: entry.question, answer: entry.answer });
    }
  }
  return turns.slice(-WORKER_SIDE_QUESTION_MAX_TURNS);
}

/**
 * `window`: its own window. `dock`: the column right of the chat.
 * `dock-over`: docked, but the chat is too narrow to keep
 * `SIDE_CHAT_MIN_CHAT_WIDTH` beside it, so the column lies over the chat's
 * right edge (decision 209 §4, §5).
 */
export type SideChatPlacement = 'hidden' | 'window' | 'dock' | 'dock-over';

/**
 * Where the side chat is on screen. `dockFits` is the shell's
 * `fitShell(...).slotFits` with the docked column as the slot (open panes are
 * squeezed first). Nothing is stored: a wider window docks it again.
 */
export function resolveSideChatPlacement(input: {
  open: boolean;
  form: SideChatForm;
  dockFits: boolean;
}): SideChatPlacement {
  if (!input.open) return 'hidden';
  if (input.form === 'window') return 'window';
  return input.dockFits ? 'dock' : 'dock-over';
}
