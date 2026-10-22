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

  it('the work panel receives what it shows; the shell derives it once (layout 5a)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const panel = code(join(SHELL_DIR, 'WorkPanel.tsx'));
    expect(shell).toContain('const panelView = resolveWorkPanelView(');
    expect(shell).toContain('view={panelView}');
    expect(panel).toContain('const open = view.open;');
    expect(panel).not.toContain('useShellLayoutStore');
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
    //
    // D13 (U26) drops the `!isTui` term (and P1-11 dropped the pi TUI itself).
    // It was U03-a's, and it made the column unmountable while the terminal was
    // up — which after D08 (files open ONLY here) meant clicking a file in the
    // TUI did nothing at all, the same
    // zero-consumer deadlock round-10 ⑥ found. The two invariants this test
    // exists for are unchanged and still asserted below.
    //
    // dsh-rebase P1-11 (decision 128): the review is no longer the only thing
    // that can cover the files — the folder's terminal can too. Covered means
    // `hidden`, never unmounted: the column still consumes file intents.
    // Design system v2 / layout 5a: the editor is a layer of the work panel,
    // absolutely placed, so it never claims row width; covered (another tab,
    // or the panel closed) means `hidden`, never unmounted.
    const panel = code(join(SHELL_DIR, 'WorkPanel.tsx'));
    expect(panel).toContain('{(editorOpen || fileIntentPending) && (');
    expect(panel).toContain("className={cn('absolute inset-0', showEditor ? 'z-10' : 'hidden')}");
    expect(panel).toContain("const showEditor = shownTab === 'editor' && editorOpen;");
    expect(shell).toContain('fileIntentPending={fileIntentPending}');
  });

  it('the expanded panel is an opaque overlay over the center row only (m3, moved by D08 and 5a)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const panel = code(join(SHELL_DIR, 'WorkPanel.tsx'));
    // The overlay must be opaque or chat shows through it (user round 1,
    // screenshot). It covers the row under the title bar, NOT the shell: the
    // sidebar and the title bar stay reachable.
    expect(panel).toContain("'flex min-h-0 flex-col bg-surface-1'");
    expect(panel).toContain("open && expanded && 'absolute inset-0 z-20'");
    // …and it may not outlive the open panel that justified it.
    expect(shell).toContain('if (expanded && !panelView.open) {');
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
    // Layout 5a: the chat grip became the work panel's left-edge grip.
    expect(shell).toContain('data-resizing={sidebarResizing || panelResizing || undefined}');
    expect(shell).toContain('onDragFrame: paintPanelDrag,');
    expect(shell).toContain('group-data-[resizing]/shell:transition-none');
  });

  it('the surface switcher is the work panel`s tab strip, and nowhere else (layout 5a)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const dock = code(join(SHELL_DIR, 'LeftDock.tsx'));
    const panel = code(join(SHELL_DIR, 'WorkPanel.tsx'));
    const layoutModel = code(join(SHELL_DIR, 'shellLayoutModel.ts'));
    // History of this one control, because it has moved five times: A08 gave
    // the panel a tab strip plus a rail; round-12 one permanent vertical rail;
    // D34 the header bar; D07 text tabs in the right panel; D08 the left
    // rail; layout 5a (ruling L1) a tab strip on the right work panel again,
    // the reference's shape, with the title bar's buttons as shortcuts to it.
    expect(shell).not.toContain('ContextPanelRail');
    expect(shell).toContain('const panelTabs = deriveWorkPanelTabs({');
    expect(panel).toContain('role="tablist"');
    expect(panel).toContain('tabs.map((tab) => (');
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
