import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { WorkerCommandResult } from '@shared/types/workerRpc';
import { create } from 'zustand';
import {
  applyPanelsSnapshot,
  initialSessionPanels,
  panelsMark,
  pruneSessionPanels,
  reduceSessionPanels,
  type SessionPanelsState,
} from '@/components/chat/sessionPanelsModel';
import { subscribeRuntimeEvent } from './runtimeEventBus';
import { isSessionRetired } from './sessionRetirement';

/**
 * dsh-rebase P1-7a: adjacent store for the goal bar and the todo card — the
 * red-line `chatSessions.ts` never carries them. The fold is
 * `sessionPanelsModel.ts`'s (pure, node-env tests); this file is the zustand
 * shell, the subscription latch (the `sessionRuntimeFacts.ts` shape: ONE
 * app-lifetime owner, `ChatWorkspace.tsx`, calls `init()`), the rehydration
 * through `worker.panels`, and the strips' own window-local state.
 *
 * Rehydration (decision 113 rule 12): the bridge sends a session's panels
 * ahead of its first event after a bootstrap, so a session reopened with no
 * event since — and every session after a renderer reload — has told this
 * window nothing. It is asked once per `session.resumed` and once when a chat
 * nothing is known about is shown (`ensureHydrated`).
 */
interface SessionPanelsStoreState extends SessionPanelsState {
  listening: boolean;
  /** Which strips are open, per session (plan P1-7 shard 03 §3: remembered per session). */
  open: Record<string, { todo?: boolean; goal?: boolean }>;
  /** The complete goal this window put away, per session (`goalDismissKey`). */
  dismissed: Record<string, string>;
  /** A goal command is on its way: that session's buttons wait for it. */
  commandPending: Record<string, true>;
  init: () => () => void;
  hydrate: (sessionId: string) => Promise<void>;
  /** Rehydrate a session this window has heard nothing about yet. */
  ensureHydrated: (sessionId: string) => void;
  setOpen: (sessionId: string, strip: 'todo' | 'goal', open: boolean) => void;
  dismissGoal: (sessionId: string, key: string) => void;
  /**
   * Run one `/goal …` line out of band. Resolves with the engine's answer,
   * `undefined` when one is already on its way; rejects when the request
   * itself failed (no worker, a timeout).
   */
  runGoalCommand: (sessionId: string, line: string) => Promise<WorkerCommandResult | undefined>;
  pruneSessions: (sessionIds: readonly string[]) => void;
}

/** Rehydrations on their way, so a burst of triggers asks once. */
const hydrating = new Set<string>();

function omit<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function pruneRecord<T>(
  record: Readonly<Record<string, T>>,
  live: ReadonlySet<string>
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => live.has(id)));
}

export const useSessionPanelsStore = create<SessionPanelsStoreState>()((set, get) => ({
  ...initialSessionPanels,
  listening: false,
  open: {},
  dismissed: {},
  commandPending: {},

  init: () => {
    if (get().listening) {
      return () => {};
    }
    set({ listening: true });

    const unsubscribe = subscribeRuntimeEvent((event: RuntimeEvent) => {
      if (isSessionRetired(event.sessionId)) return;
      set((state) => {
        const next = reduceSessionPanels(state, event);
        return next === state ? state : { bySession: next.bySession };
      });
      // The slot was (re)opened: whatever the bridge holds for it may never
      // be sent again until its next event.
      if (event.type === 'session.resumed') void get().hydrate(event.sessionId);
    });

    return () => {
      set({ listening: false });
      unsubscribe();
    };
  },

  hydrate: async (sessionId) => {
    const read = window.electronAPI?.chat?.getSessionPanels;
    if (!read || hydrating.has(sessionId)) return;
    hydrating.add(sessionId);
    const mark = panelsMark(get(), sessionId);
    try {
      const result = await read({ sessionId });
      if (isSessionRetired(sessionId)) return;
      set((state) => {
        const next = applyPanelsSnapshot(state, sessionId, result?.projections ?? [], mark);
        return next === state ? state : { bySession: next.bySession };
      });
    } catch {
      // A failed read costs the strips until the next event, never the chat.
    } finally {
      hydrating.delete(sessionId);
    }
  },

  ensureHydrated: (sessionId) => {
    if (get().bySession[sessionId]) return;
    void get().hydrate(sessionId);
  },

  setOpen: (sessionId, strip, open) =>
    set((state) => ({
      open: { ...state.open, [sessionId]: { ...state.open[sessionId], [strip]: open } },
    })),

  dismissGoal: (sessionId, key) =>
    set((state) => ({ dismissed: { ...state.dismissed, [sessionId]: key } })),

  runGoalCommand: async (sessionId, line) => {
    if (get().commandPending[sessionId]) return undefined;
    set((state) => ({ commandPending: { ...state.commandPending, [sessionId]: true } }));
    try {
      return await window.electronAPI.chat.runSessionCommand({ sessionId, line });
    } finally {
      set((state) => ({ commandPending: omit(state.commandPending, sessionId) }));
    }
  },

  pruneSessions: (sessionIds) =>
    set((state) => {
      const live = new Set(sessionIds);
      const panels = pruneSessionPanels(state, sessionIds);
      const open = pruneRecord(state.open, live);
      const dismissed = pruneRecord(state.dismissed, live);
      const commandPending = pruneRecord(state.commandPending, live);
      const unchanged =
        panels.bySession === state.bySession &&
        Object.keys(open).length === Object.keys(state.open).length &&
        Object.keys(dismissed).length === Object.keys(state.dismissed).length &&
        Object.keys(commandPending).length === Object.keys(state.commandPending).length;
      return unchanged ? state : { bySession: panels.bySession, open, dismissed, commandPending };
    }),
}));
