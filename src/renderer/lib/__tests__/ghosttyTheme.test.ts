import { describe, expect, it } from 'vitest';
import { withPanelBgOpacity } from '../ghosttyTheme';

describe('withPanelBgOpacity', () => {
  it('keeps the source colour and defers the scalar to --panel-bg-opacity', () => {
    expect(withPanelBgOpacity('#282a36')).toBe(
      'color-mix(in srgb, #282a36 calc(var(--panel-bg-opacity, 1) * 100%), transparent)'
    );
  });

  it('falls back to fully opaque when the knob is unset', () => {
    // The fallback inside var() is what makes the no-background-image case a
    // no-op: calc(1 * 100%) === 100%, i.e. the untouched input colour.
    expect(withPanelBgOpacity('#fff')).toContain('var(--panel-bg-opacity, 1)');
    expect(withPanelBgOpacity('#fff')).toContain('* 100%');
  });

  it('accepts non-hex colour notations produced by mixColors', () => {
    expect(withPanelBgOpacity('rgb(40, 42, 54)')).toBe(
      'color-mix(in srgb, rgb(40, 42, 54) calc(var(--panel-bg-opacity, 1) * 100%), transparent)'
    );
  });
});
