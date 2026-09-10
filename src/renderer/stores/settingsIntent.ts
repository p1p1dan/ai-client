import { create } from 'zustand';
import type { SettingsCategory } from '@/components/settings/constants';

/**
 * R02-c — "open settings", requested from somewhere that cannot open it.
 *
 * `openSettings` lives in `App/hooks/useSettingsState`, which owns whether
 * settings are a tab or a dialog. The composer is several levels below that and
 * has no path to it; threading a callback down would put a prop on every
 * component in between purely as a conduit.
 *
 * Same shape as `navigation.ts`'s pending request: a flag the App layer
 * consumes and clears. A boolean rather than a counter because two `/settings`
 * in a row should open settings once, not twice.
 */
interface SettingsIntentState {
  pendingOpen: boolean;
  /**
   * Which pane to land on, when the requester cares (H/17 L4 opens `pi`).
   * Absent keeps whatever pane was last used, which is what `/settings` wants.
   */
  pendingCategory: SettingsCategory | null;
  requestSettings: (category?: SettingsCategory) => void;
  clearSettingsRequest: () => void;
}

export const useSettingsIntentStore = create<SettingsIntentState>((set) => ({
  pendingOpen: false,
  pendingCategory: null,
  requestSettings: (category) => set({ pendingOpen: true, pendingCategory: category ?? null }),
  clearSettingsRequest: () => set({ pendingOpen: false, pendingCategory: null }),
}));
