import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * T-15 risk R2, the half no pure function can hold.
 *
 * `deriveMountedSurfaceIds` (covered in `shellLayoutModel.test.ts`) proves the
 * SHELL keeps the terminal view mounted across a surface switch and a panel
 * close. It says nothing about what the view then does with that guarantee, and
 * that is where the pty actually dies:
 *
 * - a conditional `{ready && <TerminalPanel/>}` unmounts the panel — with it
 *   every `ShellTerminal`, and `useXterm`'s teardown detaches the pty, which
 *   destroys a local session created with `persistOnDisconnect: false`
 *   (`SessionManager.detach` → `localPtyManager.destroy`). It also drops
 *   `WorktreeGroupStates`, so Workspace A → B → A no longer restores A's tabs;
 * - `display: none` (or `hidden`, or dropping the group from the render) sizes
 *   the container to 0×0, and xterm's `FitAddon` floors at `cols: 2` and
 *   forwards that to the pty, permanently re-wrapping whatever runs in it;
 * - binding `isActive` to "the panel is open" instead of "this surface is
 *   active" makes a keep-alive terminal call `terminal.focus()` while the user
 *   is looking at git or the editor.
 *
 * All three are one-token edits that no unit test would notice, so they are
 * pinned here. Scans read CODE, not prose (shared parser-backed strip): the doc
 * comments above have to spell the banned techniques in order to explain them.
 */

const ROOT = process.cwd();

function code(relativePath: string): { raw: string; flat: string } {
  const file = join(ROOT, relativePath);
  const raw = readFileSync(file, 'utf8');
  // Whitespace-flattened so the assertions survive any re-formatting.
  return { raw, flat: stripComments(raw, file).replace(/\s+/g, ' ') };
}

const VIEW = code('src/renderer/components/workspace-shell/surfaces/TerminalSurfaceView.tsx');
const PANEL = code('src/renderer/components/terminal/TerminalPanel.tsx');
const GROUP = code('src/renderer/components/terminal/TerminalGroup.tsx');

describe('TerminalSurfaceView keeps the pty alive', () => {
  it('renders TerminalPanel exactly once', () => {
    expect(VIEW.flat.match(/<TerminalPanel/g)).toHaveLength(1);
  });

  it('never renders TerminalPanel behind a conditional', () => {
    // `{ready && <TerminalPanel/>}` / `cond ? <TerminalPanel/> : <Empty/>` are
    // both unmounts of every running shell.
    expect(VIEW.flat).not.toMatch(/[&?:]\s*<TerminalPanel/);
  });

  it('layers the empty state over the still-mounted panel', () => {
    expect(VIEW.flat).toContain("status === 'unavailable'");
    expect(VIEW.flat).toContain('<Empty');
  });

  it('hides the panel layer with visibility, not layout removal', () => {
    expect(VIEW.flat).toContain('invisible pointer-events-none');
    expect(VIEW.flat).toContain('inert={!ready}');
    expect(VIEW.flat).not.toMatch(/display\s*:\s*['"]?\s*none/i);
  });

  it('binds isActive to the active surface, not to the panel being open', () => {
    expect(VIEW.flat).toContain('isActive={activeSurfaceId === surfaceId');
    expect(VIEW.flat).not.toContain('activeSurfaceId !== null');
  });

  it('holds Escape on the terminal container', () => {
    expect(VIEW.flat).toContain('SURFACE_ESCAPE_HOLD_ATTR');
  });

  it('derives the presentation instead of hard-coding one', () => {
    expect(VIEW.flat).toContain('deriveTerminalPresentation({ expanded })');
  });

  it('keeps the reason in the source, where the next edit will read it', () => {
    // Asserted on RAW: this one is about the comment surviving, not the code.
    expect(VIEW.raw).toContain('persistOnDisconnect');
    expect(VIEW.raw).toMatch(/cols:\s*2/);
  });
});

describe('TerminalPanel compact presentation', () => {
  it('hides a compact-hidden group instead of dropping it from the tree', () => {
    expect(PANEL.flat).toContain('HIDDEN_TERMINAL_GROUP_BOX');
    expect(PANEL.flat).toContain('opacity-0 pointer-events-none');
    // The legacy `if (!position) return null` was an unmount of that group's
    // terminals; the fallback box replaced it.
    expect(PANEL.flat).not.toContain('if (!position) return null');
    expect(PANEL.flat).not.toMatch(/display\s*:\s*['"]?\s*none/i);
  });

  it('gates every split entry on the same predicate', () => {
    expect(PANEL.flat).toContain('canManageTerminalSplits(presentation)');
    expect(PANEL.flat).toContain('canSplit={canManageSplits}');
    expect(PANEL.flat).toContain('canMerge={canManageSplits && state.groups.length > 1}');
    expect(PANEL.flat).toContain('onTabMoveToGroup={canManageSplits ? handleTabMoveToGroup');
  });

  it("defaults presentation to the legacy layout so existing hosts don't change", () => {
    expect(PANEL.flat).toContain("presentation = 'full'");
  });

  it('carries the expand-to-split reason in a tooltip', () => {
    expect(PANEL.flat).toContain('Expand the panel to manage terminal splits');
    expect(PANEL.flat).toContain('<TooltipPopup');
    // `disabled` on a button swallows the pointer events the tooltip needs.
    expect(PANEL.flat).toContain('aria-disabled="true"');
  });
});

describe('TerminalGroup tab strip stays usable at panel width', () => {
  it('scrolls horizontally rather than compressing tabs', () => {
    // ~380px is narrower than two tabs; without the scroll container the tabs
    // would shrink past a clickable size instead of overflowing.
    expect(GROUP.flat).toContain('overflow-x-auto');
    expect(GROUP.flat).toContain('min-w-[120px]');
  });

  it('keeps the new-tab and close-tab controls in the strip', () => {
    expect(GROUP.flat).toContain('handleNewTab');
    expect(GROUP.flat).toContain('handleCloseTab');
  });
});
