import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { create } from 'zustand';
import {
  initialMetadataRegistry,
  type MetadataRegistry,
  reduceMessageMetadata,
} from '@/components/chat/messageMetadata';
import { subscribeRuntimeEvent } from './runtimeEventBus';
import { isSessionRetired } from './sessionRetirement';

/**
 * dsh-rebase P1-7e (problem 16, decision 139): the turn clock's live stamps,
 * kept for the whole run instead of for one timeline mount.
 *
 * `useMessageMetadata` used to hold this registry in component state, fed only
 * by the active chat's events. A live message carries no date of its own (the
 * red-line store keeps none), so a turn's 「已工作 N 秒」 and 「完成于 HH:MM」
 * lived in that state alone — and the timeline unmounts whenever the middle
 * column shows the start screen (every New chat). Coming back to a chat, after
 * the pool reclaimed it or not, found an empty registry; a turn that ended
 * while another chat was on screen was never recorded at all.
 *
 * Now one listener folds every chat's events into a per-chat registry here,
 * held by `ChatWorkspace` for the whole run and by each hook while it is
 * mounted (refcounted, so a timeline mounted on its own — a test — still gets
 * its events). A restart still starts empty: a reopened chat's turns come back
 * as history rows, which carry the dates the log wrote (`replayedSpanMetadata`).
 */
/** The model a new assistant entry is stamped with when its event names none (T-30 P-14, D48 S2). */
export type SessionModelResolver = (sessionId: string) => string | undefined;

interface MessageMetadataRegistryState {
  bySession: Record<string, MetadataRegistry>;
  /**
   * Start listening; returns the release. The listener lives while anyone
   * holds it. The resolver is `useResolvedSessionModel`'s, handed in by the
   * holder so this store does not reach into the settings store itself.
   */
  retain: (sessionModel: SessionModelResolver) => () => void;
  /** Rewind replaced the branch (`resetSessionScopedRendererState`). */
  resetSession: (sessionId: string) => void;
  pruneSessions: (sessionIds: readonly string[]) => void;
}

/** Fold one event into its chat's registry; the same state when nothing changed. */
export function applyMetadataEvent(
  bySession: Readonly<Record<string, MetadataRegistry>>,
  event: RuntimeEvent,
  sessionModel: SessionModelResolver
): Record<string, MetadataRegistry> {
  const sessionId = event.sessionId;
  // Every event the registry reads names its chat; one that does not changes nothing.
  if (!sessionId) return bySession as Record<string, MetadataRegistry>;
  const previous = bySession[sessionId] ?? initialMetadataRegistry;
  // T-30 P-14 / D48 S2: an untouched chat resolves to no model, and `null` is
  // the right stamp for it ("we did not pin one"); the reducer prefers the
  // model the Host itself reported anyway.
  const next = reduceMessageMetadata(previous, event, sessionModel(sessionId) ?? null);
  if (next === previous) return bySession as Record<string, MetadataRegistry>;
  return { ...bySession, [sessionId]: next };
}

let holders = 0;
let unsubscribe: (() => void) | null = null;
/** The latest holder's resolver; every holder hands in the same rule. */
let resolveModel: SessionModelResolver = () => undefined;

export const useMessageMetadataStore = create<MessageMetadataRegistryState>()((set) => ({
  bySession: {},

  retain: (sessionModel) => {
    holders += 1;
    resolveModel = sessionModel;
    if (!unsubscribe) {
      unsubscribe = subscribeRuntimeEvent((event) => {
        if (isSessionRetired(event.sessionId)) return;
        set((state) => {
          const bySession = applyMetadataEvent(state.bySession, event, resolveModel);
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
export function resetMessageMetadataRegistryForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  holders = 0;
  resolveModel = () => undefined;
  useMessageMetadataStore.setState({ bySession: {} });
}
