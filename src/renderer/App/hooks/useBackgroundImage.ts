import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settings';

/**
 * Drives panel translucency for the background-image feature.
 *
 * The palette itself lives in styles/globals.css: the four panel surfaces
 * (--background / --card / --popover / --muted) are declared as
 * `oklch(L C H / var(--panel-bg-opacity, 1))`, so this hook only has to move a
 * single scalar instead of re-stating every colour.
 *
 * --panel-bg-opacity MUST be set on documentElement, not on <body>: a custom
 * property's var() substitution happens when the *declaring* element computes
 * its value, and the surfaces are declared in :root / .dark (documentElement).
 * A value written to <body> would never be seen by them.
 *
 * theme='sync-terminal' re-declares those same four surfaces as inline styles on
 * documentElement (lib/ghosttyTheme.ts), which outranks :root; that path routes
 * them through withPanelBgOpacity() so this knob keeps working there too.
 */
export function useBackgroundImage() {
  const backgroundImageEnabled = useSettingsStore((s) => s.backgroundImageEnabled);
  const backgroundOpacity = useSettingsStore((s) => s.backgroundOpacity);

  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;

    const reset = () => {
      body.classList.remove('bg-image-enabled');
      body.style.backgroundColor = '';
      html.style.removeProperty('--panel-bg-opacity');
    };

    if (backgroundImageEnabled) {
      // Styling hook only; the palette no longer branches on this class.
      body.classList.add('bg-image-enabled');
      body.style.backgroundColor = 'transparent';
      html.style.setProperty('--panel-bg-opacity', String(1 - backgroundOpacity));
    } else {
      reset();
    }

    return reset;
  }, [backgroundImageEnabled, backgroundOpacity]);
}
