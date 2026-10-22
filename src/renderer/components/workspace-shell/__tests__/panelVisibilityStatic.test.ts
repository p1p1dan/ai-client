import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
      .filter((path) => !ALLOWED.has(basename(path)))
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
    // D08 derived "collapsed" from "no surface active", because the dock held
    // the surfaces. Design system v2 / layout 5a moved the surfaces to the
    // work panel, so the sidebar's collapse is its own (persisted) fact again
    // and there is no second field it could disagree with.
    expect(shell).toContain('sidebarUserCollapsed: sidebarCollapsed,');
    expect(shell).not.toContain('activeSurfaceId');
    // dsh-rebase P1-11 (decision 127): no TUI override any more; the chrome
    // model alone decides whether the chat column shows.
    expect(shell).toContain('const chatVisible = chrome.chatVisible;');
    // D08 retires the allocator's panel term: the surfaces moved into the
    // column the allocator satisfies FIRST, so the last one is simply not
    // requested. Passing 0/false rather than deleting the parameter keeps the
    // allocator's own tests and its compression maths untouched.
    expect(shell).toContain('panelVisible: false');
    expect(shell).toContain('panelWidth: 0');
  });

  it('LeftDock receives its width and its collapsed state, and derives nothing', () => {
    const dock = code(join(SHELL_DIR, 'LeftDock.tsx'));
    expect(dock).toContain('dockWidth: number');
    expect(dock).toContain('collapsed: boolean');
    // Layout 5a: no rail to subtract, no surface to read.
    expect(dock).not.toContain('DOCK_RAIL_WIDTH');
    expect(dock).not.toContain('activeSurfaceId');
  });

  it('the pane area receives what it shows; the shell derives it once (layout 5d)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const area = code(join(SHELL_DIR, 'PaneArea.tsx'));
    const card = code(join(SHELL_DIR, 'PaneCard.tsx'));
    expect(shell).toContain('const paneView = resolvePaneView(');
    expect(shell).toContain('view={paneView}');
    expect(area).toContain('const open = view.panes.length > 0;');
    expect(area).not.toContain('useShellLayoutStore');
    expect(card).not.toContain('useShellLayoutStore');
  });

  it('the empty editor costs no layout box, yet a pending intent still mounts it (m6 + round-10 ⑥)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // m6: an empty editor claimed half the center row. Round-10 ⑥: the editor
    // is the fileOpenIntent's ONLY consumer, so a pending intent must mount it
    // even with zero tabs (zero consumer = tool-row file clicks did nothing).
    // Layout 5d: the editor is a pane card, absolutely placed, so it never
    // claims row width; off screen (another pane expanded, nothing open) it is
    // an invisible card, never unmounted.
    const area = code(join(SHELL_DIR, 'PaneArea.tsx'));
    expect(area).toContain("if (kind === 'editor') return editorOpen || fileIntentPending;");
    expect(area).toContain('<GuardedEditorColumn />');
    expect(shell).toContain('editorOpen: editorOpen || fileIntentPending,');
    expect(shell).toContain('fileIntentPending={fileIntentPending}');
  });

  it('an expanded pane is an opaque overlay over the center row only (m3, moved by D08, 5a, 5d)', () => {
    const area = code(join(SHELL_DIR, 'PaneArea.tsx'));
    // The overlay must be opaque or chat shows through it (user round 1,
    // screenshot). It covers the row under the title bar, NOT the shell: the
    // sidebar and the title bar stay reachable.
    expect(area).toContain("'flex min-h-0 flex-col bg-surface-1 pt-0 pr-2 pb-2 pl-2'");
    expect(area).toContain("open && view.expanded && 'absolute inset-0 z-20'");
    // …and it cannot outlive its pane: `resolvePaneView` drops an expanded
    // pane that is not on screen, so there is no flag left to reset.
    const model = code(join(SHELL_DIR, 'workPanelModel.ts'));
    expect(model).toContain(
      'const expanded = state.expanded && panes.includes(state.expanded) ? state.expanded : null;'
    );
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
    // Layout 5a: the chat grip became the work panel's left-edge grip;
    // layout 5d: the pane area's.
    expect(shell).toContain('data-resizing={sidebarResizing || panelResizing || undefined}');
    expect(shell).toContain('onDragFrame: paintPanelDrag,');
    expect(shell).toContain('group-data-[resizing]/shell:transition-none');
  });

  it('there is no surface switcher any more: panes are cards, opened from the title bar (layout 5d)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const dock = code(join(SHELL_DIR, 'LeftDock.tsx'));
    const area = code(join(SHELL_DIR, 'PaneArea.tsx'));
    const layoutModel = code(join(SHELL_DIR, 'shellLayoutModel.ts'));
    // History of this one control, because it has moved six times: A08 gave
    // the panel a tab strip plus a rail; round-12 one permanent vertical rail;
    // D34 the header bar; D07 text tabs in the right panel; D08 the left
    // rail; layout 5a a tab strip on the right work panel. Layout 5d (user,
    // 2026-10-22: 「双层标题」) dropped the strip: each view is a card with one
    // header, opened and closed by the title bar's buttons.
    expect(shell).not.toContain('ContextPanelRail');
    expect(shell).toContain('const availablePanes = deriveAvailablePanes({');
    expect(area).not.toContain('role="tablist"');
    expect(area).not.toContain('role="tab"');
    // The sidebar keeps no copy of the switcher.
    expect(dock).not.toContain('derivePanelTabs');
    expect(dock).not.toContain('RailButton');
    expect(dock).not.toContain('SURFACE_VIEWS');
    // The retired helpers may not creep back under their old names.
    expect(layoutModel).not.toContain('deriveRailVisible');
    expect(layoutModel).not.toContain('railOrder:');
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
