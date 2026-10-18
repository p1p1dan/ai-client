import { create } from 'zustand';

/**
 * dsh-rebase decision 194 Q2: `/model` and `/effort`, typed in the composer, for the
 * composer's model menu (`ComposerModelTrigger`), which owns the selection and its rules.
 * Same shape as `settingsIntent.ts`: a request the menu consumes and clears.
 *
 * `sessionId` names the chat the command was typed in (null: the home page), so only
 * that composer's menu acts on it.
 */
export interface ModelMenuRequest {
  seq: number;
  sessionId: string | null;
  kind: 'model' | 'effort';
  /** What followed the command; empty opens the menu. */
  query: string;
}

interface ModelMenuIntentState {
  pending: ModelMenuRequest | null;
  request: (input: Omit<ModelMenuRequest, 'seq'>) => void;
  /** Clears `seq`'s request; a newer one stays. */
  clear: (seq: number) => void;
}

let seq = 0;

export const useModelMenuIntentStore = create<ModelMenuIntentState>((set) => ({
  pending: null,
  request: (input) => set({ pending: { ...input, seq: ++seq } }),
  clear: (done) => set((state) => (state.pending?.seq === done ? { pending: null } : state)),
}));
