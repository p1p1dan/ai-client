/**
 * Initial window background color, resolved before first paint to avoid a
 * white/dark flash while the renderer boots.
 *
 * Values mirror `--background` in src/renderer/styles/globals.css:
 * - light: `:root` block (~line 145)
 * - dark: `.dark` block (~line 198)
 * Keep these in sync if the CSS values ever change.
 */
export const WINDOW_BACKGROUND_LIGHT = '#FFFDF4';
export const WINDOW_BACKGROUND_DARK = '#171515';

/**
 * Resolves whether the very first window paint should use dark colors.
 *
 * 'dark' / 'light' map directly. 'system', 'sync-terminal', and any other
 * unrecognized (or missing) value defer to the OS-level preference, passed
 * in as `shouldUseDarkColors` (Electron's `nativeTheme.shouldUseDarkColors`)
 * so this function stays Electron-free and unit-testable.
 */
export function resolveIsDarkTheme(
  theme: string | undefined,
  shouldUseDarkColors: boolean
): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return shouldUseDarkColors;
}

/** Convenience wrapper returning the background color instead of the isDark flag. */
export function resolveWindowBackgroundColor(
  theme: string | undefined,
  shouldUseDarkColors: boolean
): string {
  return resolveIsDarkTheme(theme, shouldUseDarkColors)
    ? WINDOW_BACKGROUND_DARK
    : WINDOW_BACKGROUND_LIGHT;
}

/**
 * `webPreferences.additionalArguments` entry carrying the resolved initial
 * theme into the renderer process argv, read by preload to strip the
 * `dark` class from `<html>` before first paint when the theme is light.
 * Shared between main (writer) and preload (reader) so the flag never drifts.
 */
export const INITIAL_THEME_ARG_PREFIX = '--aiclient-initial-theme=';

export function buildInitialThemeArg(isDark: boolean): string {
  return `${INITIAL_THEME_ARG_PREFIX}${isDark ? 'dark' : 'light'}`;
}

export function parseInitialThemeArg(argv: readonly string[]): boolean | undefined {
  const arg = argv.find((entry) => entry.startsWith(INITIAL_THEME_ARG_PREFIX));
  if (!arg) return undefined;
  const value = arg.slice(INITIAL_THEME_ARG_PREFIX.length);
  if (value === 'dark') return true;
  if (value === 'light') return false;
  return undefined;
}
