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
    // Round-12: `railVisible` is gone — the rail is permanent, so the
    // complement it used to express no longer exists.
    expect(shell).toContain('const { panelVisible, chatVisible } = chrome;');
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

  it('the empty editor column costs no layout box, yet a pending intent still mounts it (m6 + round-10 ⑥)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // m6: `EditorColumn` returns null with no file open, but an unconditional
    // `flex-1` wrapper still claimed half the center row — chat was laid out
    // at half width while looking full width. Round-10 ⑥ found m6's
    // editorOpen-only mount had recreated the fileOpenIntent deadlock (the
    // column is the intent's ONLY consumer — zero tabs meant zero consumer,
    // so tool-row file clicks silently did nothing). Both invariants now hold
    // at once: a pending intent mounts the column, but only `editorOpen`
    // grants it the `flex-1` layout box — otherwise the wrapper is `hidden`
    // and costs nothing.
    //
    // Round-11: the granted box is now an ALLOCATED width + `shrink-0` rather
    // than `flex-1` — a growable/shrinkable editor would absorb the overflow
    // the right edge is supposed to clip. Both original invariants are
    // unchanged: mounted on a pending intent, laid out only when open.
    expect(shell).toMatch(
      /\{\(editorOpen \|\| fileIntentPending\) && \( <div className=\{editorOpen \? 'min-w-0 shrink-0' : 'hidden'\}/
    );
    expect(shell).toContain("style={editorOpen ? { width: 'var(--shell-editor-w)' } : undefined}");
  });

  it('the docked cap is not applied to the expanded overlay (m6)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const model = code(join(SHELL_DIR, 'shellLayoutModel.ts'));
    // The cap reserves chat's floor, which is right for a docked column and
    // wrong for an overlay: capped, it could not cover the row and exposed the
    // chat column reflowing beside it.
    //
    // Round-10 ②: the branch moved out of `ContextPanel.tsx` into
    // `resolveDockedPanelBudget` so the render and the drag handle cannot
    // disagree about it (they did). The exemption itself is unchanged and is
    // now truth-tabled in `shellLayoutModel.test.ts` rather than only scanned.
    expect(shell).toContain('maxDockedWidth={panelWidthCap}');
    expect(model).toContain('if (expanded) { return availableWidth; }');
  });

  it('the panel drag clamps to the same budget the render uses (round 10 ②)', () => {
    const panel = code(join(SHELL_DIR, 'ContextPanel.tsx'));
    // The defect: the render capped the docked panel at `maxDockedWidth` while
    // the resize handle clamped against the raw `availableWidth`. A drag could
    // therefore commit a width the panel was never allowed to render at — the
    // edge snapped back, and the oversized stored value walked the level
    // ladder until the panel disappeared. Both must read one budget.
    expect(panel).toContain('resolveDockedPanelBudget({');
    expect(panel).toContain(
      'clamp={(candidate) => clampContextPanelWidth(candidate, widthBudget)}'
    );
    expect(panel).toContain('onCommit={(next) => setPanelWidth(next, widthBudget)}');
    // The raw row width must not reach the handle again.
    expect(panel).not.toContain('clampContextPanelWidth(candidate, availableWidth)');
    expect(panel).not.toContain('setPanelWidth(next, availableWidth)');
  });

  /**
   * OVERTURNED DESIGN — these two replace the round-10 fences that stood here:
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
    expect(shell).toContain(
      'ref={contentRowRef} className="relative flex min-w-0 flex-1 overflow-clip"'
    );
    expect(shell).toContain('const allocation = resolveShellAllocation(allocationInput);');
    // Columns read variables, never numbers: that is what lets a drag repaint
    // all of them by writing one node, with zero React renders.
    expect(shell).toContain(`style={{ width: 'var(--shell-sidebar-w)' }}`);
    expect(shell).toContain(`style={{ width: 'var(--shell-center-w)' }}`);
    expect(shell).toContain(`style={chatVisible ? { width: 'var(--shell-chat-w)' } : undefined}`);
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
    expect(shell).toContain('onDragFrame={paintPanelDrag}');
    expect(shell).toContain('root.style.setProperty(');
    // Pointer moves are coalesced to one paint per animation frame.
    expect(hook).toContain('requestAnimationFrame(');
    expect(hook).toContain('cancelAnimationFrame(');
    // The pointer handler itself must stay a recorder — no clamp, no write.
    expect(hook).toContain('pendingXRef.current = e.clientX;');
    // Transitions are killed for the WHOLE shell while any handle is down.
    expect(shell).toContain(
      'data-resizing={sidebarResizing || panelResizing || centerResizing || undefined}'
    );
    expect(shell).toContain('group-data-[resizing]/shell:transition-none');
  });

  it('the rail is permanent and the panel`s tab strip is gone (round 12)', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const panel = code(join(SHELL_DIR, 'ContextPanel.tsx'));
    const layoutModel = code(join(SHELL_DIR, 'shellLayoutModel.ts'));
    // OVERTURNED A08「展开时右缘无图标」(a08:1430-1432): one always-present
    // vertical switcher replaces both the conditional rail and the in-panel
    // horizontal tabs.
    expect(shell).toContain('<ContextPanelRail />');
    expect(shell).not.toMatch(/railVisible && <ContextPanelRail/);
    expect(panel).not.toContain('role="tablist"');
    expect(panel).not.toContain('derivePanelTabs');
    // The complement it replaced may not creep back under its old name — a
    // callable `deriveRailVisible` would let a caller re-hide the switcher
    // the zero-width panel depends on to be recoverable.
    expect(layoutModel).not.toContain('deriveRailVisible');
    // The panel takes the width the shell allocated it — compressed, not cut.
    expect(panel).toContain('allocatedWidth: number');
    expect(shell).toContain('allocatedWidth={allocation.panelWidth}');
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
