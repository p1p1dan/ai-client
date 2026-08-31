/**
 * T-19 message queue — zustand shell. In-memory only, never persisted (decision
 * 1: a queued entry is "the next turn on the session that is currently
 * running"; after an app restart the Host-side runtime context is gone, so
 * there is nothing correct left to replay it into).
 *
 * Every action below just forwards to a reducer in `components/chat/
 * messageQueue.ts` and writes the result back — no judgment logic lives here.
 * `sessionId` filtering for the actual "is it safe to release" question stays
 * in `queueRelease.ts` / `useQueueRelease.ts`.
 */
import { create } from 'zustand';
import {
  clearPause as clearPauseReducer,
  createEmptyState,
  type DraftPayload,
  type EnqueueResult,
  enqueue as enqueueReducer,
  type MessageQueueState,
  moveEntry as moveEntryReducer,
  pauseSession as pauseSessionReducer,
  pruneSessions as pruneSessionsReducer,
  type QueuedMessage,
  type QueueMoveDirection,
  type QueuePauseReason,
  removeEntry as removeEntryReducer,
  restoreHead as restoreHeadReducer,
  type TakeEntryIntoDraftResult,
  takeEntryIntoDraft as takeEntryIntoDraftReducer,
  takeHead as takeHeadReducer,
} from '@/components/chat/messageQueue';

interface MessageQueueStore {
  state: MessageQueueState;

  enqueue: (message: QueuedMessage) => EnqueueResult;
  takeHead: (sessionId: string) => QueuedMessage | null;
  restoreHead: (entry: QueuedMessage) => void;
  removeEntry: (sessionId: string, entryId: string) => void;
  moveEntry: (sessionId: string, entryId: string, direction: QueueMoveDirection) => void;
  takeEntryIntoDraft: (
    sessionId: string,
    entryId: string,
    currentDraft: DraftPayload
  ) => TakeEntryIntoDraftResult | null;
  pauseSession: (sessionId: string, reason?: QueuePauseReason) => void;
  clearPause: (sessionId: string) => void;
  pruneSessions: (liveSessionIds: readonly string[]) => void;
}

export const useMessageQueueStore = create<MessageQueueStore>()((set, get) => ({
  state: createEmptyState(),

  enqueue: (message) => {
    const result = enqueueReducer(get().state, message);
    if (result.ok) set({ state: result.state });
    return result;
  },

  takeHead: (sessionId) => {
    const { state, entry } = takeHeadReducer(get().state, sessionId);
    if (entry) set({ state });
    return entry;
  },

  restoreHead: (entry) => set({ state: restoreHeadReducer(get().state, entry) }),

  removeEntry: (sessionId, entryId) =>
    set({ state: removeEntryReducer(get().state, sessionId, entryId) }),

  moveEntry: (sessionId, entryId, direction) =>
    set({ state: moveEntryReducer(get().state, sessionId, entryId, direction) }),

  takeEntryIntoDraft: (sessionId, entryId, currentDraft) => {
    const { state, result } = takeEntryIntoDraftReducer(
      get().state,
      sessionId,
      entryId,
      currentDraft
    );
    if (result) set({ state });
    return result;
  },

  pauseSession: (sessionId, reason) =>
    set({ state: pauseSessionReducer(get().state, sessionId, reason) }),

  clearPause: (sessionId) => set({ state: clearPauseReducer(get().state, sessionId) }),

  pruneSessions: (liveSessionIds) =>
    set({ state: pruneSessionsReducer(get().state, liveSessionIds) }),
}));
