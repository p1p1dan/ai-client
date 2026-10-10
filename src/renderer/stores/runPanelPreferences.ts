/**
 * Issue #9 (decision 173 §4.5): the Run panel's own view state.
 *
 * - `cacheStepsGroup`: whether the 「逐步缓存」 group is open. `auto` until the
 *   user toggles it, which opens the group exactly when the turn on screen has
 *   a step with no local cause; after the first toggle their choice holds for
 *   every chat and survives a restart. Persisted the way `shellLayout.ts`
 *   persists the shell: zustand `persist` over `localStorage`, synchronous, so
 *   no frame paints the default first.
 * - `dismissedCacheAlerts`: chats whose cache alert the user closed. Memory
 *   only, for this run: the alert stays the session's to raise again after a
 *   restart.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type CacheStepsGroupPreference = 'auto' | 'open' | 'closed';

interface PersistedRunPanelPreferences {
  cacheStepsGroup: CacheStepsGroupPreference;
}

interface RunPanelPreferencesState extends PersistedRunPanelPreferences {
  /** The user opened or closed the group: from now on that is the answer. */
  setCacheStepsGroupOpen: (open: boolean) => void;
  dismissedCacheAlerts: Readonly<Record<string, true>>;
  dismissCacheAlert: (sessionId: string) => void;
}

const DEFAULT_PREFERENCES: PersistedRunPanelPreferences = { cacheStepsGroup: 'auto' };

/** A stored value this build understands, else the default. */
export function sanitizeRunPanelPreferences(value: unknown): PersistedRunPanelPreferences {
  const group = (value as { cacheStepsGroup?: unknown } | null | undefined)?.cacheStepsGroup;
  return {
    cacheStepsGroup:
      group === 'open' || group === 'closed' || group === 'auto'
        ? group
        : DEFAULT_PREFERENCES.cacheStepsGroup,
  };
}

export const useRunPanelPreferencesStore = create<RunPanelPreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      setCacheStepsGroupOpen: (open) => set({ cacheStepsGroup: open ? 'open' : 'closed' }),
      dismissedCacheAlerts: {},
      dismissCacheAlert: (sessionId) =>
        set((state) =>
          state.dismissedCacheAlerts[sessionId]
            ? state
            : { dismissedCacheAlerts: { ...state.dismissedCacheAlerts, [sessionId]: true } }
        ),
    }),
    {
      name: 'aiclient-run-panel',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedRunPanelPreferences => ({
        cacheStepsGroup: state.cacheStepsGroup,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitizeRunPanelPreferences(persisted) }),
    }
  )
);
