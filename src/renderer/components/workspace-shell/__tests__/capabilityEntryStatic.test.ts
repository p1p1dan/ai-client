import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * The sidebar's capability entry — shape claims about the dock that no pure
 * function can answer, pinned against the source the way `deadControlsStatic`
 * pins its own.
 *
 * U04 put a Plugins entry here and D08 moved it from `LeftNav`'s footer to
 * `LeftDock`'s rail. cutover-03 changed what it shows: pi extensions have had
 * no loader since P6-5, so the panel now projects this app's OWN capabilities
 * (MCP servers, skills, sub-agents) and says in words where installed pi
 * extensions do apply. Replaces `pluginEntryStatic.test.ts`.
 */
const dockPath = path.join(process.cwd(), 'src/renderer/components/workspace-shell/LeftDock.tsx');
const dock = stripComments(readFileSync(dockPath, 'utf8'), dockPath);
const navPath = path.join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const nav = stripComments(readFileSync(navPath, 'utf8'), navPath);

describe('sidebar capability entry', () => {
  it('offers the entry wired to the per-session capability projection', () => {
    expect(dock).toContain('useSessionCapabilities(activeSessionId)');
    expect(dock).toContain('deriveSessionCapabilities(capabilities)');
    expect(dock).toContain("{t('Capabilities')}");
    expect(dock).toContain('<Blocks');
  });

  /**
   * cutover-03 — the panel must not be fed by the retired producers.
   *
   * `useSessionExtensions` read a pi extension list nothing writes, and the MCP
   * badge was parsed out of `ui.setStatus` status lines that no native session
   * emits. Either one coming back would make the panel silently empty again.
   */
  it('reads neither the pi extension list nor extension status lines', () => {
    expect(dock).not.toContain('useSessionExtensions');
    expect(dock).not.toContain('derivePluginInventory');
    expect(dock).not.toContain('mcpReadiness');
  });

  it('projects MCP readiness from the session’s own servers', () => {
    expect(dock).toContain("{t('MCP servers')}");
    expect(dock).toContain('view.mcp');
    expect(dock).toContain('view.mcpServers');
  });

  it('says where installed pi extensions actually apply', () => {
    // The sentence that stops someone reinstalling a working extension because
    // this panel never names it.
    expect(dock).toContain(
      "t('Pi extensions you install are loaded only by the built-in terminal.')"
    );
  });

  it('adds no Resources entry — Q03 ruled it names the same extensions twice', () => {
    expect(dock).not.toContain("t('Resources')");
    expect(dock).not.toContain('nav-resources');
    expect(nav).not.toContain("t('Resources')");
  });

  it('keeps the entry as app-scoped chrome beside Settings, not a surface of its own', () => {
    // evidence-u09 #6 ruled against adopting pix's one-level primary nav, and
    // that still holds: this opens a dialog, and sits in the rail's bottom
    // group with Settings, below the `flex-1` spacer that separates navigation
    // from chrome.
    expect(dock).toContain('<div className="flex-1" />');
    expect(dock.indexOf('<div className="flex-1" />')).toBeLessThan(
      dock.indexOf("label={t('Capabilities')}")
    );
    expect(dock).not.toMatch(/id: 'plugins'/);
  });

  it('the session list no longer carries a second copy of the entry', () => {
    expect(nav).not.toContain("{t('Plugins')}");
    expect(nav).not.toContain('derivePluginInventory');
  });

  it('U23: refreshes on resume, not only on create', () => {
    // The reported bug: an already-started chat opened from the sidebar sat on
    // "send a message to start this chat" forever. Opening an existing session
    // is a RESUME, which emits `session.resumed`; only `session.created` was
    // subscribed, and the one eager fetch fired before any worker existed. The
    // hook therefore never got a second chance to ask. Carried over to the
    // replacement hook, which has the same one-shot fetch.
    const hookPath = path.join(
      process.cwd(),
      'src/renderer/components/workspace-shell/useSessionCapabilities.ts'
    );
    const hook = stripComments(readFileSync(hookPath, 'utf8'), hookPath);
    expect(hook).toContain("event.type === 'session.created'");
    expect(hook).toContain("event.type === 'session.resumed'");
  });

  it('renders words rather than a zero when nothing has reported', () => {
    // A `0` beside a capability name reads as "your setup is broken"; an absent
    // worker has simply not reported.
    expect(dock).toContain('{!view.reported ? (');
    expect(dock).toContain("{t('Send a message to start this chat and see what it brings up.')}");
    expect(dock).toContain("t('Not reported')");
  });
});
