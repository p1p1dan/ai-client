import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * U04 acceptance ② and ③ are shape claims about the sidebar, not behaviours a
 * pure function can answer, so they are pinned against the source the way
 * `deadControlsStatic` and `extensionUiInlineStatic` pin theirs.
 *
 * D08 moved the entry from `LeftNav`'s footer row to `LeftDock`'s rail — the
 * footer row is gone, and Settings/Plugins are the rail's bottom group. The
 * inventory itself (D06: what the worker actually loaded, per session) did not
 * change, so those pins move file rather than being rewritten.
 */
const dockPath = path.join(process.cwd(), 'src/renderer/components/workspace-shell/LeftDock.tsx');
const dock = stripComments(readFileSync(dockPath, 'utf8'), dockPath);
const navPath = path.join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const nav = stripComments(readFileSync(navPath, 'utf8'), navPath);

describe('U04 plugin entry', () => {
  it('offers a Plugins entry wired to the per-session inventory', () => {
    expect(dock).toContain('useSessionExtensions(activeSessionId)');
    expect(dock).toContain('derivePluginInventory({');
    expect(dock).toContain("{t('Plugins')}");
    expect(dock).toContain('<Blocks');
  });

  it('adds no Resources entry — Q03 ruled it names the same extensions twice', () => {
    expect(dock).not.toContain("t('Resources')");
    expect(dock).not.toContain('nav-resources');
    expect(nav).not.toContain("t('Resources')");
  });

  it('keeps the entry as app-scoped chrome beside Settings, not a surface of its own', () => {
    // evidence-u09 #6 ruled against adopting pix's one-level primary nav, and
    // that still holds: Plugins is NOT a rail surface (it opens a dialog), it
    // sits in the rail's bottom group with Settings, below the `flex-1` spacer
    // that separates navigation from chrome.
    expect(dock).toContain('<div className="flex-1" />');
    expect(dock.indexOf('<div className="flex-1" />')).toBeLessThan(
      dock.indexOf("label={t('Plugins')}")
    );
    expect(dock).not.toMatch(/id: 'plugins'/);
  });

  it('the session list no longer carries a second copy of the entry', () => {
    expect(nav).not.toContain("{t('Plugins')}");
    expect(nav).not.toContain('derivePluginInventory');
  });

  it('renders no badge when there is nothing to count', () => {
    // A `0` beside a plugin name reads as "your plugins are broken"; an absent
    // worker has simply not reported. The dialog says so in words instead.
    expect(dock).toContain('{!inventory.reported ? (');
    expect(dock).toContain("{t('Send a message to start this chat and see what it loads.')}");
  });
});
