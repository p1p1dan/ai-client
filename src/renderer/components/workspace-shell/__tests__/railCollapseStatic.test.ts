import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * H/18 S4 — the collapse control moved from the panel's title row to the rail.
 *
 * The point of the move is reachability: the title row is INSIDE the panel, so
 * the button that hid the panel went away with it and only Ctrl+B could bring
 * it back. The rail is permanent (see `LeftDock`'s header comment), so a
 * control that lives there is always clickable.
 */
const dockPath = path.join(process.cwd(), 'src/renderer/components/workspace-shell/LeftDock.tsx');
const dock = stripComments(readFileSync(dockPath, 'utf8'), dockPath);

const railSource = dock.slice(dock.indexOf('<nav'), dock.indexOf('</nav>'));
const titleSource = (() => {
  const start = dock.indexOf('function DockTitle(');
  return dock.slice(start, dock.indexOf('\n}', start));
})();

describe('S4 collapse control on the rail', () => {
  it('the rail carries it, and it toggles rather than only closing', () => {
    expect(railSource).toContain('onClick={toggleDock}');
    // The same store action Ctrl+B runs, so the two cannot come to mean
    // different things. `closeSurface` here would leave the button dead
    // whenever the panel is already collapsed — which is exactly when the rail
    // is the only thing on screen.
    expect(dock).toContain(
      'const toggleDock = useShellLayoutStore((state) => state.toggleContextPanel);'
    );
    expect(railSource).not.toContain('onClick={closeSurface}');
  });

  it('names and draws itself after what the click will do', () => {
    expect(railSource).toContain("t('Collapse sidebar') : t('Expand sidebar')");
    expect(railSource).toContain('(Ctrl+B)');
    expect(railSource).toContain('icon={isOpen ? PanelLeftClose : PanelLeftOpen}');
  });

  it('the panel title row no longer holds a duplicate', () => {
    expect(titleSource).not.toContain('Collapse sidebar');
    expect(titleSource).not.toContain('PanelLeftClose');
    // The row still names the surface — that is the reason it exists at all.
    expect(titleSource).toContain('{t(labelKey)}');
  });

  it('Escape still closes the panel — that path was not part of the move', () => {
    expect(dock).toContain('closeSurface();');
    expect(dock).toContain('shouldCloseOnEscape');
  });
});
