import { create } from 'zustand';

/**
 * T-05: team-side store recording a "please open this file" intent from the
 * chat timeline (Read row click, Grep/Glob hit-list click). Deliberately not
 * `stores/navigation.ts` — that store's only consumer
 * (`App/hooks/useTerminalNavigation.ts`) mounts on a non-shell branch only,
 * so writing into it here would leave a `pendingNavigation` no one ever
 * clears. This store is consumed by the shell's editor surface once T-13
 * lands; until then the shell shows an honest empty state
 * (`SurfacePlaceholder`, `pendingTask: 'T-13'`) and the intent sits unread.
 */

export interface FileOpenIntent {
  path: string;
  line?: number;
  endLine?: number;
  /** Monotonic counter so re-clicking the same path still fires consumer effects. */
  requestId: number;
  /** Provenance: which UI surface produced this request. */
  source: 'tool-row' | 'hit-list';
}

/** Pure reducer — unit testable independent of the store shell. */
export function nextIntent(
  prev: FileOpenIntent | null,
  input: Omit<FileOpenIntent, 'requestId'>
): FileOpenIntent {
  return { ...input, requestId: (prev?.requestId ?? 0) + 1 };
}

interface FileOpenIntentState {
  intent: FileOpenIntent | null;
  requestFileOpen: (input: Omit<FileOpenIntent, 'requestId'>) => void;
  /** Consumer (T-13 editor surface) reads and clears; an already-consumed requestId never refires. */
  consumeFileOpen: () => FileOpenIntent | null;
}

export const useFileOpenIntentStore = create<FileOpenIntentState>((set, get) => ({
  intent: null,

  requestFileOpen: (input) => set((state) => ({ intent: nextIntent(state.intent, input) })),

  consumeFileOpen: () => {
    const { intent } = get();
    if (intent) set({ intent: null });
    return intent;
  },
}));
