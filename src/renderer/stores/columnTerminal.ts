import { create } from 'zustand';
import { normalizePath } from '@/App/storage';

/**
 * dsh-rebase P1-11 (decisions 109, 126, 128): the shell terminals that open in
 * the right column, the same column the file editor and the session review use.
 *
 * One terminal per DIRECTORY, not per conversation: chats that share a folder
 * share its shell, the same keying `TerminalPanel` uses per worktree and the
 * editor uses for its tabs. An entry exists while its shell runs — the column
 * keeps every entry's `ShellTerminal` mounted (hidden, never `display: none`),
 * so switching to another conversation and back finds the shell still there.
 * Removing an entry unmounts it, and the detach ends a local shell (it is
 * created with `persistOnDisconnect: false`).
 *
 * `front` is whether the terminal sits above the file editor while its folder
 * is on screen. The session review, when open, sits above both. Hiding keeps
 * the shell running; only `close` (the tab's ✕, the shell exiting, the folder
 * going away) ends it.
 *
 * Not persisted: a shell does not survive a restart, so neither does its entry.
 */
export interface ColumnTerminal {
  /** `columnTerminalKey(cwd)` — the directory, compared the way the OS does. */
  key: string;
  /** The directory as the conversation names it (case kept): the shell's cwd. */
  cwd: string;
  /** Above the file editor while this directory is on screen. */
  front: boolean;
}

interface ColumnTerminalState {
  terminals: Record<string, ColumnTerminal>;
  /** Starts the directory's shell if it has none, and brings it to the front. */
  show: (cwd: string) => void;
  /** Sends it behind the file editor; the shell keeps running. */
  hide: (key: string) => void;
  /** Ends it: the entry goes, the view unmounts, the detach ends the shell. */
  close: (key: string) => void;
  /** Ends every terminal at or under `path` (a workspace being deleted). */
  closeUnder: (path: string) => void;
  /** Forgets everything: the host that renders the shells went away. */
  reset: () => void;
}

/**
 * Trailing separators dropped, `\` as `/`, case folded where the file system
 * folds it — `TerminalPanel`'s per-worktree key, so both agree on "same folder".
 */
export function columnTerminalKey(cwd: string): string {
  return normalizePath(cwd.trim());
}

export const useColumnTerminalStore = create<ColumnTerminalState>((set) => ({
  terminals: {},

  show: (cwd) => {
    const trimmed = cwd.trim();
    // Decision 126 rule 2: no directory, no shell. Never fall back to $HOME.
    if (!trimmed) return;
    const key = columnTerminalKey(trimmed);
    set((state) => {
      const existing = state.terminals[key];
      if (existing?.front) return state;
      return {
        terminals: {
          ...state.terminals,
          [key]: existing ? { ...existing, front: true } : { key, cwd: trimmed, front: true },
        },
      };
    });
  },

  hide: (key) =>
    set((state) => {
      const existing = state.terminals[key];
      if (!existing?.front) return state;
      return { terminals: { ...state.terminals, [key]: { ...existing, front: false } } };
    }),

  close: (key) =>
    set((state) => {
      if (!state.terminals[key]) return state;
      const terminals = { ...state.terminals };
      delete terminals[key];
      return { terminals };
    }),

  closeUnder: (path) =>
    set((state) => {
      const root = columnTerminalKey(path);
      if (!root) return state;
      const kept = Object.entries(state.terminals).filter(
        ([key]) => key !== root && !key.startsWith(`${root}/`)
      );
      if (kept.length === Object.keys(state.terminals).length) return state;
      return { terminals: Object.fromEntries(kept) };
    }),

  reset: () =>
    set((state) => (Object.keys(state.terminals).length === 0 ? state : { terminals: {} })),
}));

/** How many column shells are running — for the sign-in confirmation's count. */
export function countColumnTerminals(): number {
  return Object.keys(useColumnTerminalStore.getState().terminals).length;
}
