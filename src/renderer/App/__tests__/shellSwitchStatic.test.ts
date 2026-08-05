import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../components/chat/__tests__/stripComments';

/**
 * T-16 — the switch has to stay reversible.
 *
 * Appearance › "OpenChamber Workspace Shell" was inert for the whole team
 * track: `Root.tsx` wrote `useOpenChamberShell = true` on mount AND again on
 * persist rehydration, and three consumers OR-ed the setting with
 * `SKIP_ONBOARDING_GATE`. Turning the switch off therefore did nothing, twice
 * over — the write put it back, and the OR ignored it anyway. Because the
 * override was spread across four files, fixing any one of them looked like a
 * fix and wasn't; that is what this scan exists to prevent.
 *
 * Two invariants, matching the two failure shapes:
 *   1. nobody READS the shell choice through the dev flag, and
 *   2. nobody WRITES the preference except the switch the user clicks.
 *
 * `SKIP_ONBOARDING_GATE` itself stays `true` and keeps its own job (skipping
 * detection/login). Flipping it to `false` is NOT how reversibility is
 * achieved — that would drag the onboarding gate back in with it.
 */

const RENDERER_DIR = join(process.cwd(), 'src/renderer');

function listRendererSources(): string[] {
  return (readdirSync(RENDERER_DIR, { recursive: true }) as string[])
    .map(String)
    .filter((p) => (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('__tests__'))
    .map((p) => join(RENDERER_DIR, p));
}

function code(path: string): string {
  return stripComments(readFileSync(path, 'utf8'), path);
}

function rel(path: string): string {
  return path.slice(RENDERER_DIR.length + 1);
}

describe('the OpenChamber shell switch is reversible (T-16)', () => {
  it('no file decides the shell from the onboarding dev flag', () => {
    const offenders = listRendererSources()
      .filter((path) => {
        const source = code(path);
        return source.includes('SKIP_ONBOARDING_GATE') && source.includes('useOpenChamberShell');
      })
      .map(rel);

    expect(
      offenders,
      'Read `settings.useOpenChamberShell` on its own. OR-ing it with ' +
        'SKIP_ONBOARDING_GATE pins the new shell on and makes the Appearance ' +
        'switch a no-op.'
    ).toEqual([]);
  });

  it('nothing calls the setter on the user behalf', () => {
    const writers = listRendererSources()
      .filter((path) => /setUseOpenChamberShell\s*\(/.test(code(path)))
      .map(rel);

    // The store's own setter definition is a declaration, not a call, so it is
    // not in this list; `AppearanceSettings.tsx` passes the setter to <Switch>
    // by reference, which is likewise not a call.
    expect(
      writers,
      'Programmatic writes overwrite whatever the user chose. If a migration ' +
        'genuinely needs one, it belongs in the persist `migrate`, not in a ' +
        'component effect.'
    ).toEqual([]);
  });

  it('App renders the shell straight off the setting', () => {
    const app = code(join(RENDERER_DIR, 'App.tsx')).replace(/\s+/g, ' ');
    expect(app).toContain(
      'const useOpenChamberShell = useSettingsStore((s) => s.useOpenChamberShell);'
    );
    expect(app).toContain('{useOpenChamberShell ? (');
  });

  it('the gate skip mounts App without touching settings', () => {
    const root = code(join(RENDERER_DIR, 'Root.tsx')).replace(/\s+/g, ' ');
    expect(root).toContain('if (SKIP_ONBOARDING_GATE) { return <SkippedOnboardingApp />; }');
    expect(root).not.toContain('useSettingsStore');
  });

  it('a fresh profile gets the new shell, read synchronously', () => {
    // Flipping the default was safe precisely because the forced write above
    // had already persisted `true` into every existing profile; without it a
    // new profile would open in the legacy tab shell, which is the fallback.
    // The read goes through the mirror, or the async rehydration shows the
    // wrong shell for a frame — see `shellPreferenceMirror.ts`.
    const store = code(join(RENDERER_DIR, 'stores/settings/index.ts'));
    expect(store).toContain('useOpenChamberShell: readShellPreference(),');
    expect(store).not.toMatch(/useOpenChamberShell:\s*(true|false),/);
  });
});
