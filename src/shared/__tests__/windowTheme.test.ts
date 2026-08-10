import { describe, expect, it } from 'vitest';
import {
  buildInitialThemeArg,
  parseInitialThemeArg,
  resolveIsDarkTheme,
  resolveWindowBackgroundColor,
  WINDOW_BACKGROUND_DARK,
  WINDOW_BACKGROUND_LIGHT,
} from '../windowTheme';

describe('resolveIsDarkTheme', () => {
  it('maps light theme to isDark=false regardless of OS preference', () => {
    expect(resolveIsDarkTheme('light', true)).toBe(false);
    expect(resolveIsDarkTheme('light', false)).toBe(false);
  });

  it('maps dark theme to isDark=true regardless of OS preference', () => {
    expect(resolveIsDarkTheme('dark', false)).toBe(true);
    expect(resolveIsDarkTheme('dark', true)).toBe(true);
  });

  it('defers system theme to the OS preference', () => {
    expect(resolveIsDarkTheme('system', true)).toBe(true);
    expect(resolveIsDarkTheme('system', false)).toBe(false);
  });

  it('defers unknown values (e.g. sync-terminal, missing) to the OS preference', () => {
    expect(resolveIsDarkTheme('sync-terminal', true)).toBe(true);
    expect(resolveIsDarkTheme('sync-terminal', false)).toBe(false);
    expect(resolveIsDarkTheme(undefined, true)).toBe(true);
    expect(resolveIsDarkTheme(undefined, false)).toBe(false);
  });
});

describe('resolveWindowBackgroundColor', () => {
  it('returns the color constants matching the resolved theme', () => {
    expect(resolveWindowBackgroundColor('light', true)).toBe(WINDOW_BACKGROUND_LIGHT);
    expect(resolveWindowBackgroundColor('dark', false)).toBe(WINDOW_BACKGROUND_DARK);
    expect(resolveWindowBackgroundColor('system', true)).toBe(WINDOW_BACKGROUND_DARK);
    expect(resolveWindowBackgroundColor('unknown-value', false)).toBe(WINDOW_BACKGROUND_LIGHT);
  });
});

describe('buildInitialThemeArg / parseInitialThemeArg', () => {
  it('round-trips isDark through the argv flag', () => {
    expect(parseInitialThemeArg([buildInitialThemeArg(true)])).toBe(true);
    expect(parseInitialThemeArg([buildInitialThemeArg(false)])).toBe(false);
  });

  it('returns undefined when the flag is absent or malformed', () => {
    expect(parseInitialThemeArg(['--some-other-flag'])).toBeUndefined();
    expect(parseInitialThemeArg(['--aiclient-initial-theme=bogus'])).toBeUndefined();
  });
});
