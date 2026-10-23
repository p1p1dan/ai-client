/**
 * Layout 5e (ui-cohesion §6, ruling L5): the session rail's two user choices —
 * shown or hidden (default shown), and which cards are folded. Persisted.
 *
 * Whether the rail is ON SCREEN is not stored: it is derived per render from
 * this choice, the open panes and the chat width
 * (`resolveSessionRailVisibility`).
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  resolveCardOpen,
  type SessionRailCardId,
  sanitizeCardOpen,
} from '@/components/workspace-shell/sessionRail/sessionRailModel';

interface SessionRailPersisted {
  shown: boolean;
  cardOpen: Partial<Record<SessionRailCardId, boolean>>;
}

interface SessionRailState extends SessionRailPersisted {
  toggleShown: () => void;
  toggleCard: (id: SessionRailCardId) => void;
}

export const useSessionRailStore = create<SessionRailState>()(
  persist(
    (set) => ({
      shown: true,
      cardOpen: {},
      toggleShown: () => set((state) => ({ shown: !state.shown })),
      toggleCard: (id) =>
        set((state) => ({
          cardOpen: { ...state.cardOpen, [id]: !resolveCardOpen(state.cardOpen, id) },
        })),
    }),
    {
      name: 'aiclient-session-rail',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state): SessionRailPersisted => ({
        shown: state.shown,
        cardOpen: state.cardOpen,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Record<string, unknown>>;
        return {
          ...current,
          shown: typeof saved.shown === 'boolean' ? saved.shown : current.shown,
          cardOpen: sanitizeCardOpen(saved.cardOpen),
        };
      },
    }
  )
);

/** Whether a card is open (the persisted fold over the defaults). */
export function useSessionRailCardOpen(id: SessionRailCardId): boolean {
  return useSessionRailStore((state) => resolveCardOpen(state.cardOpen, id));
}
