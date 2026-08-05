/**
 * T-16: a synchronous mirror of the `useOpenChamberShell` preference.
 *
 * The settings store persists through `electronStorage`, which is IPC-backed
 * and therefore ASYNC: the store renders its in-code defaults for at least one
 * frame before rehydration lands. That was invisible while `Root.tsx` pinned
 * the shell on, but the moment the switch became reversible it turned into a
 * visible flash — a user who chose the legacy shell would watch the new shell
 * paint on every launch and then be replaced.
 *
 * `localStorage` is synchronous, so a mirror of the one boolean the very first
 * render depends on removes the frame entirely. Same reasoning as
 * `stores/shellLayout.ts`, which keeps the whole layout in localStorage for
 * this exact reason.
 *
 * Authority still belongs to the settings store: the mirror is written when the
 * user flips the switch and re-written from the hydrated value on every
 * rehydrate, so an out-of-band edit to settings.json converges after one
 * launch rather than being fought over.
 */

export const SHELL_PREFERENCE_MIRROR_KEY = 'aiclient-use-openchamber-shell';

/**
 * On by default: the legacy tab shell is the fallback, not the product. See the
 * matching comment in `stores/settings/index.ts`.
 */
export const DEFAULT_USE_OPENCHAMBER_SHELL = true;

/** The whole decision, as a pure function — anything unrecognised is a default. */
export function parseShellPreference(raw: string | null): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return DEFAULT_USE_OPENCHAMBER_SHELL;
}

export function readShellPreference(): boolean {
  try {
    return parseShellPreference(localStorage.getItem(SHELL_PREFERENCE_MIRROR_KEY));
  } catch {
    // Storage can be unavailable (disabled, quota, non-DOM host). Never let a
    // cache read decide whether the app boots.
    return DEFAULT_USE_OPENCHAMBER_SHELL;
  }
}

export function writeShellPreference(value: boolean): void {
  try {
    localStorage.setItem(SHELL_PREFERENCE_MIRROR_KEY, value ? 'true' : 'false');
  } catch {
    // A missing mirror only costs the flash it exists to avoid.
  }
}
