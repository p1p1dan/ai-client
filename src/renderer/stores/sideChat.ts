/**
 * Layout 5f (ui-cohesion §6, ruling L6): the side chat's state — open or not,
 * floating or docked, the conversation it reads and what was asked in it.
 *
 * Nothing here is persisted: closing the side chat discards it (Claude Code
 * desktop does not save side chats either). Only the form outlives a close,
 * for this run. The rules are `sideChatModel.ts`; this file adds the ids and
 * the one IPC call per question.
 */
import type { WorkerSideQuestionTurn } from '@shared/types/workerRpc';
import { WORKER_SIDE_QUESTION_UNAVAILABLE } from '@shared/types/workerRpc';
import { create } from 'zustand';
import {
  addSideQuestion,
  closeSideChat,
  followActiveSession,
  INITIAL_SIDE_CHAT,
  openSideChat,
  pendingSideQuestionIds,
  type SideChatForm,
  type SideChatState,
  type SideQuestionOutcome,
  setSideChatForm,
  settleSideQuestion,
  sideChatBusy,
  sideQuestionHistory,
  toggleSideChat,
} from '@/components/workspace-shell/sideChat/sideChatModel';

/** Dictionary keys of the side chat's failures. */
export const SIDE_QUESTION_FAILED = 'The side question could not be answered. Try again.';
export const SIDE_QUESTION_UNAVAILABLE =
  'The engine of this conversation cannot answer side questions.';

export interface SideQuestionRequest {
  sessionId: string;
  questionId: string;
  question: string;
  history: WorkerSideQuestionTurn[];
}

/**
 * How a question reaches the engine. The default starts the conversation the
 * way a send does when the engine is not running it (a chat reopened from the
 * list), then asks; tests replace it.
 */
export interface SideChatTransport {
  ask(request: SideQuestionRequest): Promise<SideQuestionOutcome>;
  cancel(sessionId: string, questionId: string): void;
}

const defaultTransport: SideChatTransport = {
  async ask(request) {
    const { runSideQuestion } = await import(
      '@/components/workspace-shell/sideChat/sideChatTransport'
    );
    return runSideQuestion(request);
  },
  cancel(sessionId, questionId) {
    void Promise.resolve(
      window.electronAPI?.chat?.cancelSideQuestion?.({ sessionId, questionId })
    ).catch(() => undefined);
  },
};

let transport: SideChatTransport = defaultTransport;

/** Tests only: replace the transport; `null` restores the default. */
export function setSideChatTransport(next: SideChatTransport | null): void {
  transport = next ?? defaultTransport;
}

/** A failure the transport did not classify: the generic sentence, or the engine's refusal. */
export function sideQuestionFailureKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(WORKER_SIDE_QUESTION_UNAVAILABLE)
    ? SIDE_QUESTION_UNAVAILABLE
    : SIDE_QUESTION_FAILED;
}

let questionSequence = 0;

function nextQuestionId(): string {
  questionSequence += 1;
  return `side-${Date.now().toString(36)}-${questionSequence}`;
}

interface SideChatStore extends SideChatState {
  openFor: (sessionId: string) => void;
  close: () => void;
  toggleFor: (sessionId: string | null) => void;
  setForm: (form: SideChatForm) => void;
  /** The open conversation changed. */
  followSession: (activeSessionId: string | null) => void;
  /** Ask on `sessionId` (opening the side chat on it). False when one is still waiting. */
  ask: (sessionId: string, question: string) => boolean;
}

export const useSideChatStore = create<SideChatStore>()((set, get) => {
  /** Swap the state, telling the engine to drop questions that were discarded with it. */
  const replace = (next: SideChatState) => {
    const before = get();
    if (next === before) return;
    const kept = new Set(pendingSideQuestionIds(next));
    for (const id of pendingSideQuestionIds(before)) {
      if (!kept.has(id) && before.sessionId) transport.cancel(before.sessionId, id);
    }
    set({ open: next.open, form: next.form, sessionId: next.sessionId, entries: next.entries });
  };
  return {
    ...INITIAL_SIDE_CHAT,
    openFor: (sessionId) => replace(openSideChat(get(), sessionId)),
    close: () => replace(closeSideChat(get())),
    toggleFor: (sessionId) => replace(toggleSideChat(get(), sessionId)),
    setForm: (form) => replace(setSideChatForm(get(), form)),
    followSession: (activeSessionId) => replace(followActiveSession(get(), activeSessionId)),
    ask: (sessionId, question) => {
      const text = question.trim();
      const current = get();
      const sameChat = current.open && current.sessionId === sessionId;
      if (!text) {
        replace(openSideChat(current, sessionId));
        return true;
      }
      if (sameChat && sideChatBusy(current)) return false;
      const questionId = nextQuestionId();
      replace(addSideQuestion(current, sessionId, questionId, text));
      const history = sideQuestionHistory(get().entries, questionId);
      void transport
        .ask({ sessionId, questionId, question: text, history })
        .catch((error: unknown): SideQuestionOutcome => {
          console.warn('[side-chat] the side question failed:', error);
          return { kind: 'failed', errorKey: sideQuestionFailureKey(error) };
        })
        .then((outcome) => {
          // Settled against the state of now: a closed side chat drops it.
          const state = get();
          if (state.sessionId !== sessionId) return;
          replace(settleSideQuestion(state, questionId, outcome));
        });
      return true;
    },
  };
});
