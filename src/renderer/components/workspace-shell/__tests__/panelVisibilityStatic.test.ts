import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * T-32 S4, risk R1 — the single most likely way this task regresses.
 *
 * Before T-32, `activeSurfaceId !== null` meant two things at once: "the user
 * wants the panel" and "the panel is on screen". D27's level ladder split
 * them: the ladder hides the panel at L1 WITHOUT touching `activeSurfaceId`,
 * precisely so that widening the window restores what it collapsed. Any
 * component that keeps reading the raw flag as visibility silently ignores the
 * ladder — the panel would render at L1, overlapping the rail that is also
 * visible there, and the user's preference would be un-restorable if the
 * ladder had instead written it.
 *
 * So: exactly one component composes visibility (`WorkspaceShell`, via
 * `derivePanelVisible`), and everyone else receives it. This scan is the fence.
 */

const SHELL_DIR = join(process.cwd(), 'src/renderer/components/workspace-shell');

/**
 * The composition point, the pure model that defines it, and the intent state
 * machine. `shellLayoutModel.ts` is on the list because its two uses are the
 * `toggle-panel` reducer branch and the persistence sanitiser — both operate
 * on INTENT (is a surface selected), which is exactly what the flag still
 * means. Adding a file here is a decision: only do it if the read is about
 * intent, never if it decides what renders.
 */
const ALLOWED = new Set(['WorkspaceShell.tsx', 'centerLayoutModel.ts', 'shellLayoutModel.ts']);

function listShellSources(): string[] {
  return (readdirSync(SHELL_DIR, { recursive: true }) as string[])
    .map(String)
    .filter((p) => (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('__tests__'))
    .map((p) => join(SHELL_DIR, p));
}

function code(path: string): string {
  return stripComments(readFileSync(path, 'utf8'), path).replace(/\s+/g, ' ');
}

describe('panel visibility has exactly one derivation point (R1)', () => {
  it('no shell component re-derives visibility from `activeSurfaceId !== null`', () => {
    const offenders = listShellSources()
      .filter((path) => !ALLOWED.has(path.split('/').pop() ?? ''))
      .filter((path) => /activeSurfaceId\s*!==\s*null/.test(code(path)))
      .map((path) => path.slice(SHELL_DIR.length + 1));

    expect(
      offenders,
      'Take the composed `visible` as a prop instead — `activeSurfaceId !== null` is ' +
        'intent, not visibility, and ignores the L0/L1/L2 ladder.'
    ).toEqual([]);
  });

  it('WorkspaceShell composes it through the pure model rather than inline', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    expect(shell).toContain('resolveShellChrome({');
    expect(shell).toContain('const { panelVisible, chatVisible, railVisible } = chrome;');
    // m5: the panel must be capped so it can never eat the content floor.
    expect(shell).toContain('maxPanelWidth({');
    // The yield model reads the preference; it must never write it.
    expect(shell).toContain('panelOpen: activeSurfaceId !== null');
  });

  it('ContextPanel receives visibility instead of computing it', () => {
    const panel = code(join(SHELL_DIR, 'ContextPanel.tsx'));
    expect(panel).toContain('visible: boolean');
    expect(panel).toContain('const isOpen = visible;');
  });

  it('the empty editor column costs no layout box (m6)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // `EditorColumn` returns null with no file open, but an unconditional
    // `flex-1` wrapper still claimed half the center row — chat was laid out
    // at half width while looking full width. The gate is the fix; without it
    // the bug is invisible in code review and obvious only in a screenshot.
    expect(shell).toMatch(/\{editorOpen && \( <div className="min-w-0 flex-1"> <EditorColumn/);
  });

  it('the docked cap is not applied to the expanded overlay (m6)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const panel = code(join(SHELL_DIR, 'ContextPanel.tsx'));
    // The cap reserves chat's floor, which is right for a docked column and
    // wrong for an overlay: capped, it could not cover the row and exposed the
    // chat column reflowing beside it.
    expect(shell).toContain('maxDockedWidth={panelWidthCap}');
    expect(panel).toContain('expanded ? availableWidth : (maxDockedWidth ?? availableWidth)');
  });

  it('the expanded panel is opaque — an overlay may not be see-through (m3)', () => {
    const panel = code(join(SHELL_DIR, 'ContextPanel.tsx'));
    // The docked column keeps its tint; the overlay must not, or chat and the
    // open file show through it (user round 1, screenshot).
    expect(panel).toMatch(/expanded\s*\?\s*'absolute[^']*bg-background'/);
  });

  it('the yield model never writes the surface state it reads', () => {
    // `closeSurface()`/`selectSurface()` from an auto-degradation path would
    // destroy the preference the ladder is supposed to compose over — and, for
    // a keep-alive surface, could tear down the pty T-15 guarantees (R2).
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    expect(shell).not.toMatch(/level\s*===[^;]*closeSurface\(\)/);
    expect(shell).not.toContain('closeSurface()');
  });
});
