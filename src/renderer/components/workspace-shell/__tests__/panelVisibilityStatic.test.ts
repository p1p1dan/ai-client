import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * T-32 S4, risk R1 — the single most likely way this area regresses.
 *
 * Before T-32, `activeSurfaceId !== null` meant two things at once: "the user
 * wants the panel" and "the panel is on screen". D27's level ladder split them,
 * round-11 deleted the ladder, and D08 finished the job: with the surfaces in
 * the left dock and no width able to hide a column, intent and visibility are
 * the same fact again. What survives is the rule that produced fewer bugs
 * either way — ONE place derives it, everyone else receives it.
 *
 * The scan is therefore still a fence, with a shorter allow-list.
 */

const SHELL_DIR = join(process.cwd(), 'src/renderer/components/workspace-shell');

/**
 * The composition point, the pure models that define it, and the dock itself.
 *
 * `shellLayoutModel.ts` is on the list because its uses are the `toggle-panel`
 * reducer branch and the persistence sanitiser — both operate on INTENT.
 * `LeftDock.tsx` joined it under D08: the dock IS the panel, so "is a surface
 * active" is its own state, not a second reading of someone else's. Adding a
 * file here is a decision: only do it if the read is about intent, never if it
 * decides what some OTHER column renders.
 */
const ALLOWED = new Set([
  'WorkspaceShell.tsx',
  'LeftDock.tsx',
  'centerLayoutModel.ts',
  'shellLayoutModel.ts',
]);

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
      'Take the composed state as a prop instead — a second reading of ' +
        '`activeSurfaceId` is how two columns end up disagreeing about whether ' +
        'the dock is open.'
    ).toEqual([]);
  });

  it('WorkspaceShell composes chrome through the pure model rather than inline', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    expect(shell).toContain('resolveShellChrome({');
    // D08: the collapsed state is DERIVED from the active surface rather than
    // stored beside it. `sidebarCollapsed` used to be its own persisted boolean,
    // which let "collapsed" and "a surface is active" disagree.
    expect(shell).toContain('const dockCollapsed = activeSurfaceId === null;');
    expect(shell).toContain('const chatVisible = isTui ? true : chrome.chatVisible;');
    // D08 retires the allocator's panel term: the surfaces moved into the
    // column the allocator satisfies FIRST, so the last one is simply not
    // requested. Passing 0/false rather than deleting the parameter keeps the
    // allocator's own tests and its compression maths untouched.
    expect(shell).toContain('panelVisible: false');
    expect(shell).toContain('panelWidth: 0');
  });

  it('LeftDock receives its width and derives openness from the active surface', () => {
    const dock = code(join(SHELL_DIR, 'LeftDock.tsx'));
    expect(dock).toContain('dockWidth: number');
    // The rail is permanent; only the panel beside it collapses.
    expect(dock).toContain('const panelWidth = Math.max(0, dockWidth - DOCK_RAIL_WIDTH);');
    expect(dock).toContain('const isOpen = panelWidth > 0 && activeSurfaceId !== null;');
  });

  it('the empty editor column costs no layout box, yet a pending intent still mounts it (m6 + round-10 ⑥)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // m6: `EditorColumn` returns null with no file open, but an unconditional
    // `flex-1` wrapper still claimed half the center row — chat was laid out at
    // half width while looking full width. Round-10 ⑥ found m6's
    // editorOpen-only mount had recreated the fileOpenIntent deadlock (the
    // column is the intent's ONLY consumer — zero tabs meant zero consumer, so
    // tool-row file clicks silently did nothing). Both invariants still hold:
    // a pending intent mounts the column, but only `editorOpen` grants it a
    // layout box.
    //
    // D08 adds a third state to the same expression — `expanded` promotes the
    // column to an overlay — which is why the class list is now composed with
    // `cn()` instead of a ternary.
    expect(shell).toContain('{!isTui && (editorOpen || fileIntentPending) && (');
    expect(shell).toContain("editorOpen && !expanded && 'min-w-0 shrink-0'");
    expect(shell).toContain("!editorOpen && 'hidden'");
    expect(shell).toContain(
      "style={editorOpen && !expanded ? { width: 'var(--shell-editor-w)' } : undefined}"
    );
  });

  it('the expanded editor is an opaque overlay over the center row only (m3, moved by D08)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // The overlay must be opaque or chat shows through it (user round 1,
    // screenshot). It covers the center row, NOT the shell: the dock has to
    // stay reachable, which is the same boundary `ContextPanel`'s overlay used.
    expect(shell).toContain("editorOpen && expanded && 'absolute inset-0 z-20 bg-background'");
    // …and it may not outlive the file that justified it.
    expect(shell).toContain('if (expanded && !editorAllocated) {');
  });

  /**
   * OVERTURNED DESIGN — this replaces the round-10 fences that stood here:
   * `the level ladder judges the panel at its floor` and `the expand buttons
   * are symmetric — the last ask wins`. Both fenced repairs to the T-32
   * degradation ladder, which the user overturned wholesale on 2026-08-05.
   * See `centerLayoutModel.ts`'s OVERTURNED DESIGN note.
   */
  it('no width can hide a column any more — the ladder is gone (round 11)', () => {
    const model = code(join(SHELL_DIR, 'centerLayoutModel.ts'));
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // Visibility takes no width at all: a threshold cannot be written without
    // one, so this is the fence rather than a list of forbidden numbers.
    expect(model).toMatch(
      /export function resolveShellChrome\(input: ResolveShellChromeInput\): ShellChrome \{[^}]*sidebarCollapsed: input\.sidebarUserCollapsed/
    );
    expect(shell).toContain('const chrome = resolveShellChrome({ sidebarUserCollapsed:');
    // The deleted machinery must not creep back under its old names.
    for (const ghost of ['ChromeIntent', 'sidebarAutoCollapsed', 'panelFootprint']) {
      expect(model).not.toContain(ghost);
      expect(shell).not.toContain(ghost);
    }
  });

  it('every column width comes from the one allocator, via CSS variables (round 12)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // `overflow-clip`, not `overflow-hidden`: hidden is still a scroll
    // container, so focusing something inside a clipped column would scroll
    // chat off screen.
    expect(shell).toContain('className="relative flex min-w-0 flex-1 overflow-clip"');
    expect(shell).toContain('const allocation = resolveShellAllocation(allocationInput);');
    // Columns read variables, never numbers: that is what lets a drag repaint
    // all of them by writing one node, with zero React renders.
    expect(shell).toContain(`style={{ width: 'var(--shell-center-w)' }}`);
    expect(shell).toContain(`style={chatVisible ? { width: 'var(--shell-chat-w)' } : undefined}`);
    // The dock takes its width as a prop rather than reading the variable, so
    // its rail/panel split is arithmetic on one allocated number.
    expect(shell).toContain('dockWidth={allocation.sidebarWidth}');
    // …and React publishes those same variables from the same allocation, so
    // the drag path and the commit path cannot drift.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on source text that itself contains a template placeholder
    expect(shell).toContain("'--shell-chat-w': `${allocation.chatWidth}px`");
    // No column may shrink, or it would absorb what compression should handle.
    expect(shell).not.toMatch(/flexShrink: 1/);
  });

  it('a drag repaints through the model and commits once (round 12 perf)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const hook = code(join(SHELL_DIR, 'usePanelDragResize.ts'));
    // Per-frame work is one model call + one variable write on one node.
    expect(shell).toContain('onDragFrame={paintSidebarDrag}');
    expect(shell).toContain('root.style.setProperty(');
    // Pointer moves are coalesced to one paint per animation frame.
    expect(hook).toContain('requestAnimationFrame(');
    expect(hook).toContain('cancelAnimationFrame(');
    // The pointer handler itself must stay a recorder — no clamp, no write.
    expect(hook).toContain('pendingXRef.current = e.clientX;');
    // Transitions are killed for the WHOLE shell while any handle is down.
    // D08 drops `panelResizing` from the list with the panel it named; the dock
    // reports through `sidebarResizing`, which was always the sidebar's flag.
    expect(shell).toContain('data-resizing={sidebarResizing || centerResizing || undefined}');
    expect(shell).toContain('group-data-[resizing]/shell:transition-none');
  });

  it('the surface switcher lives on the dock rail, and nowhere else (D08)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const dock = code(join(SHELL_DIR, 'LeftDock.tsx'));
    const tabs = code(join(SHELL_DIR, 'SessionTabs.tsx'));
    const layoutModel = code(join(SHELL_DIR, 'shellLayoutModel.ts'));
    // History of this one control, because it has moved four times and each
    // move overturned the last: A08 gave the panel a tab strip plus a rail
    // (a08:1430-1432); round-12 replaced both with one permanent vertical rail;
    // D34 moved that rail's four icons into MainHeader's bar; D07 moved them
    // back into the right panel as text tabs; D08 moves them to the LEFT, as a
    // VSCode activity bar, because the whole point of this batch is that
    // navigation belongs in the column the user visits least often.
    expect(shell).not.toContain('ContextPanelRail');
    expect(dock).toContain('derivePanelTabs(railOrder');
    expect(dock).toContain('selectSurface');
    // The center bar must NOT keep a second copy of the switcher: two readings
    // of `railOrder` is exactly how the two lists drift apart.
    expect(tabs).not.toContain('derivePanelTabs');
    expect(tabs).not.toContain('selectSurface');
    // The complement the rail replaced may not creep back under its old name.
    expect(layoutModel).not.toContain('deriveRailVisible');
  });

  it('the retired two/three-column mode leaves no ghosts behind (D08)', () => {
    const offenders = listShellSources()
      .filter((path) => /shellColumnMode|columnModeHasPanel|two-column/.test(code(path)))
      .map((path) => path.slice(SHELL_DIR.length + 1));
    expect(
      offenders,
      'D08 deleted the column mode outright — a surviving reference means a ' +
        'code path is still branching on a layout that no longer exists.'
    ).toEqual([]);
  });

  it('the yield model never writes the surface state it reads', () => {
    // `closeSurface()`/`selectSurface()` from an auto-degradation path would
    // destroy the preference the shell is supposed to compose over — and, for
    // a keep-alive surface, could tear down the pty T-15 guarantees (R2).
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    expect(shell).not.toMatch(/level\s*===[^;]*closeSurface\(\)/);
    expect(shell).not.toContain('closeSurface()');
  });
});
