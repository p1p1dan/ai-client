/**
 * Layout 5f (ui-cohesion §6, ruling L6): the pure half of the side chat — a
 * quick question about the conversation so far (Ctrl+; or `/btw`), answered
 * beside it. It reads the main conversation and writes nothing back; closing
 * it discards it (Claude Code desktop does not save side chats either).
 *
 * Two forms: a floating window over the chat's bottom-right corner (the
 * default), or docked as a column right of the chat, where the session rail
 * would be. Which one is on screen is derived per render (`resolveSideChatPlacement`).
 *
 * No React, no store, no IPC: node-env tests assert every rule here.
 */
import type { WorkerSideQuestionTurn } from '@shared/types/workerRpc';
import { WORKER_SIDE_QUESTION_MAX_TURNS } from '@shared/types/workerRpc';

export type SideChatForm = 'float' | 'dock';

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

/** The floating window (the reference's ~380×440 corner window). */
export const SIDE_CHAT_FLOAT_WIDTH = 380;
export const SIDE_CHAT_FLOAT_HEIGHT = 440;
/** The docked column's width. */
export const SIDE_CHAT_DOCK_WIDTH = 380;
/** The narrowest chat left beside a docked side chat; below it the side chat floats. */
export const SIDE_CHAT_MIN_CHAT_WIDTH = 480;

export const INITIAL_SIDE_CHAT: SideChatState = {
  open: false,
  form: 'float',
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

/** Ctrl+; and the title-bar button: close an open one, else open on the conversation. */
export function toggleSideChat(state: SideChatState, sessionId: string | null): SideChatState {
  if (state.open) return closeSideChat(state);
  return sessionId ? openSideChat(state, sessionId) : state;
}

export function setSideChatForm(state: SideChatState, form: SideChatForm): SideChatState {
  return state.form === form ? state : { ...state, form };
}

/**
 * The open conversation changed: a side chat about another one is discarded
 * (it would otherwise read a conversation that is no longer on screen).
 */
export function followActiveSession(
  state: SideChatState,
  activeSessionId: string | null
): SideChatState {
  return state.open && state.sessionId !== activeSessionId ? closeSideChat(state) : state;
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

export type SideChatPlacement = 'hidden' | 'float' | 'dock';

/**
 * Where the side chat is on screen. Docked only while the chat keeps
 * `SIDE_CHAT_MIN_CHAT_WIDTH` beside it; narrower, the docked side chat floats
 * until there is room again (nothing is stored).
 */
export function resolveSideChatPlacement(input: {
  open: boolean;
  form: SideChatForm;
  sessionOpen: boolean;
  chatWidth: number;
}): SideChatPlacement {
  if (!input.open || !input.sessionOpen) return 'hidden';
  if (input.form === 'dock' && input.chatWidth - SIDE_CHAT_DOCK_WIDTH >= SIDE_CHAT_MIN_CHAT_WIDTH) {
    return 'dock';
  }
  return 'float';
}

/** The floating window's drag offset from its resting corner (bottom-right), in px. */
export interface SideChatFloatOffset {
  x: number;
  y: number;
}

/** Keep this many px between the floating window and the chat area's edges. */
export const SIDE_CHAT_FLOAT_MARGIN = 16;

/**
 * Clamp a drag offset so the floating window stays inside its container.
 * The window rests at the container's bottom-right corner, `margin` px in;
 * a negative x moves it left, a negative y moves it up. Pure: the caller
 * measures both boxes once per pointer move, while dragging only.
 */
export function clampSideChatFloatOffset(
  offset: SideChatFloatOffset,
  container: { width: number; height: number },
  panel: { width: number; height: number },
  margin: number = SIDE_CHAT_FLOAT_MARGIN
): SideChatFloatOffset {
  const maxLeft = Math.max(0, container.width - panel.width - 2 * margin);
  const maxUp = Math.max(0, container.height - panel.height - 2 * margin);
  // `+ 0` folds -0 to 0 (no room to move: -0 from `-maxLeft`).
  return {
    x: Math.min(0, Math.max(-maxLeft, offset.x)) + 0,
    y: Math.min(0, Math.max(-maxUp, offset.y)) + 0,
  };
}
