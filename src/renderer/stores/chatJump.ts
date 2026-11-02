/**
 * Chat search (docs/plantree/plans/chat-search, stage 4): a request to show
 * one matching message in a chat's timeline, plus the find bar's place among
 * that chat's matches.
 *
 * Modelled on the change-focus request (`shellLayout.changeFocus`): `seq`
 * rises on every request and every step, so the timeline reveals again even
 * when the target message is the same one.
 */
import { create } from 'zustand';

export interface ChatJumpRequest {
  sessionId: string;
  /** The query as typed, shown in the find bar. */
  query: string;
  /** Every matching message, oldest first (`ChatSearchSessionResult.messageKeys`). */
  messageKeys: readonly string[];
  /** The match being shown, an index into `messageKeys`. */
  index: number;
  seq: number;
}

export interface ChatJumpTarget {
  sessionId: string;
  query: string;
  messageKeys: readonly string[];
}

/** A new request at the first match, or null when there is nothing to show. */
export function nextChatJump(lastSeq: number, target: ChatJumpTarget): ChatJumpRequest | null {
  if (target.messageKeys.length === 0) return null;
  return {
    sessionId: target.sessionId,
    query: target.query,
    messageKeys: [...target.messageKeys],
    index: 0,
    seq: lastSeq + 1,
  };
}

/** Move to the previous or next match, wrapping at both ends. */
export function stepChatJump(request: ChatJumpRequest, delta: number): ChatJumpRequest {
  const count = request.messageKeys.length;
  const index = (((request.index + delta) % count) + count) % count;
  return { ...request, index, seq: request.seq + 1 };
}

/** The message key the request currently points at. */
export function chatJumpTargetKey(request: ChatJumpRequest): string | null {
  return request.messageKeys[request.index] ?? null;
}

interface ChatJumpState {
  request: ChatJumpRequest | null;
  /** Last seq handed out; survives `clear` so a later request never reuses one. */
  lastSeq: number;
  requestJump: (target: ChatJumpTarget) => void;
  step: (delta: number) => void;
  clear: () => void;
}

export const useChatJumpStore = create<ChatJumpState>((set) => ({
  request: null,
  lastSeq: 0,
  requestJump: (target) =>
    set((state) => {
      const request = nextChatJump(state.lastSeq, target);
      return { request, lastSeq: request?.seq ?? state.lastSeq };
    }),
  step: (delta) =>
    set((state) => {
      if (!state.request) return {};
      const request = stepChatJump(state.request, delta);
      return { request, lastSeq: request.seq };
    }),
  clear: () => set((state) => (state.request ? { request: null } : {})),
}));
