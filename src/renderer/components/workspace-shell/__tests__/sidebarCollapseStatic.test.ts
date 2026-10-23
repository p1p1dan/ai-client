import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * Was `railCollapseStatic` (H/18 S4: the collapse control moved onto the
 * permanent rail so it stayed reachable). Design system v2 / layout 5a
 * (ruling L1) removed the rail: the sidebar collapses to nothing, so the
 * control lives in two places — the sidebar's own top row while it is open,
 * and the title bar while it is collapsed. Same intent: whichever state the
 * sidebar is in, one click (or Ctrl+B) brings it to the other.
 */
const read = (relative: string) => {
  const file = path.join(process.cwd(), relative);
  return stripComments(readFileSync(file, 'utf8'), file);
};
const dock = read('src/renderer/components/workspace-shell/LeftDock.tsx');
const bar = read('src/renderer/components/workspace-shell/SessionBar.tsx');
const shell = read('src/renderer/components/workspace-shell/WorkspaceShell.tsx');
const shortcuts = read('src/renderer/components/workspace-shell/useShellShortcuts.ts');
const card = read('src/renderer/components/workspace-shell/PaneCard.tsx');

describe('the sidebar collapse control (layout 5a)', () => {
  it('sits in the sidebar`s top row while it is open', () => {
    const start = dock.indexOf(
      '<div className="flex h-9 shrink-0 items-center gap-0.5 px-2 drag-region select-none">'
    );
    expect(start).toBeGreaterThan(-1);
    const topRow = dock.slice(start);
    expect(topRow).toContain("t('Collapse sidebar')} (Ctrl+B)");
    expect(topRow).toContain('onClick={onToggleCollapsed}');
    expect(topRow.indexOf('PanelLeftClose')).toBeLessThan(topRow.indexOf('<LeftNav'));
    // Layout 5b: collapse first, then back / forward (the screenshot's order).
    expect(topRow.indexOf('PanelLeftClose')).toBeLessThan(topRow.indexOf('<ArrowLeft'));
    expect(topRow.indexOf('<ArrowLeft')).toBeLessThan(topRow.indexOf('<ArrowRight'));
    expect(topRow).toContain('disabled={!visits.canGoBack}');
    expect(topRow).toContain('disabled={!visits.canGoForward}');
  });

  it('appears on the title bar only while the sidebar is collapsed', () => {
    expect(bar).toContain('{sidebarCollapsed && onExpandSidebar && (');
    expect(bar).toContain("t('Expand sidebar')} (Ctrl+B)");
    expect(bar).toContain('<PanelLeftOpen');
  });

  it('both run the same store action Ctrl+B runs, so they cannot drift apart', () => {
    expect(shell).toContain('onToggleCollapsed={toggleSidebar}');
    expect(shell).toContain('onExpandSidebar={toggleSidebar}');
    expect(shortcuts).toContain('toggleSidebar();');
  });

  it('a collapsed sidebar takes no width and no focus', () => {
    expect(dock).toContain('inert={collapsed}');
    expect(dock).not.toContain('DOCK_RAIL_WIDTH');
  });

  it('Escape closes the focused pane now (layout 5d) — the dock`s Escape moved with the surfaces', () => {
    expect(card).toContain('shouldCloseOnEscape');
    expect(card).toContain('onClose(kind);');
    expect(dock).not.toContain('shouldCloseOnEscape');
  });
});
