import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { create } from 'zustand';
import {
  initialTurnTimingRegistry,
  reduceTurnTiming,
  type TurnTimingRegistry,
} from '@/components/chat/turnTiming';
import { subscribeRuntimeEvent } from './runtimeEventBus';
import { isSessionRetired } from './sessionRetirement';

/**
 * dsh-rebase P1-7e (decision 140; decision 139's leftover): the live stamps of
 * thoughts and tool calls, kept for the whole run instead of for one timeline
 * mount — the same move `messageMetadataRegistry.ts` made for the turn clock
 * (problem 16).
 *
 * `useTurnTiming` used to hold this registry in component state, fed only by
 * the chat on screen. A live thought carries no dates of its own, so the turn
 * line's 「思考 N 秒」 lived in that state alone, and the timeline unmounts
 * whenever the middle column shows the start screen: coming back found an
 * empty registry, and a thought that ended while another chat was on screen
 * was never timed. One listener now folds every chat's events into a per-chat
 * registry here, held by `ChatWorkspace` for the whole run and by each hook
 * while it is mounted (refcounted). A restart still starts empty: history
 * rows carry no thinking durations (DSH's log dates messages, not thoughts).
 */
interface TurnTimingRegistryState {
  bySession: Record<string, TurnTimingRegistry>;
  /** Start listening; returns the release. The listener lives while anyone holds it. */
  retain: () => () => void;
  /** Rewind replaced the branch (`resetSessionScopedRendererState`). */
  resetSession: (sessionId: string) => void;
  pruneSessions: (sessionIds: readonly string[]) => void;
}

/** Fold one event into its chat's registry; the same state when nothing changed. */
export function applyTurnTimingEvent(
  bySession: Readonly<Record<string, TurnTimingRegistry>>,
  event: RuntimeEvent
): Record<string, TurnTimingRegistry> {
  const sessionId = event.sessionId;
  // A stamp that names no chat belongs to none.
  if (!sessionId) return bySession as Record<string, TurnTimingRegistry>;
  const previous = bySession[sessionId] ?? initialTurnTimingRegistry;
  const next = reduceTurnTiming(previous, event);
  if (next === previous) return bySession as Record<string, TurnTimingRegistry>;
  return { ...bySession, [sessionId]: next };
}

let holders = 0;
let unsubscribe: (() => void) | null = null;

export const useTurnTimingStore = create<TurnTimingRegistryState>()((set) => ({
  bySession: {},

  retain: () => {
    holders += 1;
    if (!unsubscribe) {
      unsubscribe = subscribeRuntimeEvent((event) => {
        if (isSessionRetired(event.sessionId)) return;
        set((state) => {
          const bySession = applyTurnTimingEvent(state.bySession, event);
          return bySession === state.bySession ? state : { bySession };
        });
      });
    }
    let released = false;
    return () => {
      // Idempotent, like the bus's own unsubscribe (StrictMode double cleanup).
      if (released) return;
      released = true;
      holders -= 1;
      if (holders === 0 && unsubscribe) {
        const stop = unsubscribe;
        unsubscribe = null;
        stop();
      }
    };
  },

  resetSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.bySession)) return state;
      const bySession = { ...state.bySession };
      delete bySession[sessionId];
      return { bySession };
    }),

  pruneSessions: (sessionIds) =>
    set((state) => {
      const live = new Set(sessionIds);
      const keys = Object.keys(state.bySession);
      if (keys.every((key) => live.has(key))) return state;
      return {
        bySession: Object.fromEntries(
          Object.entries(state.bySession).filter(([sessionId]) => live.has(sessionId))
        ),
      };
    }),
}));

/** Test-only: drop every registry and any listener still held. */
export function resetTurnTimingRegistryForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  holders = 0;
  useTurnTimingStore.setState({ bySession: {} });
}
