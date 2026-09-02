import type { FontWeight } from '@/stores/settings';

/**
 * Every settings pane, as data.
 *
 * The union used to be hand-written next to a hand-written array of the same
 * names in `useSettingsState`, which validates the category restored from
 * localStorage. Adding a pane to one and not the other type-checks perfectly and
 * fails silently: the new pane opens, and then never opens again after a
 * restart, because the saved value is rejected as unknown and falls back to
 * `general`. One list, derived type, no drift.
 */
export const SETTINGS_CATEGORIES = [
  'general',
  'appearance',
  'editor',
  'keybindings',
  'ai',
  'piModels',
  'piPermissions',
  'remote',
  'webInspector',
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return (SETTINGS_CATEGORIES as readonly unknown[]).includes(value);
}

export const fontWeightOptions: { value: FontWeight; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: '100', label: '100 (Thin)' },
  { value: '200', label: '200 (Extra Light)' },
  { value: '300', label: '300 (Light)' },
  { value: '400', label: '400 (Regular)' },
  { value: '500', label: '500 (Medium)' },
  { value: '600', label: '600 (Semi Bold)' },
  { value: '700', label: '700 (Bold)' },
  { value: '800', label: '800 (Extra Bold)' },
  { value: '900', label: '900 (Black)' },
  { value: 'bold', label: 'Bold' },
];

// Auto save delay default (in milliseconds)
export const AUTO_SAVE_DELAY_DEFAULT = 1000;
