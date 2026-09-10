import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

const source = stripComments(
  readFileSync(path.join(__dirname, '..', 'LeftNav.tsx'), 'utf8'),
  'LeftNav.tsx'
);

/**
 * H/18 S1/S2 added two more context menus to this file (the partition menus and
 * the project-row menu), and both are declared ABOVE `SessionRow`. Scanning the
 * whole file for "the first context-menu trigger" therefore stopped meaning
 * "the session row's" — every assertion below is scoped to the row component
 * instead, and `sidebarSectionMenus.test.ts` covers the other two.
 */
const sessionRowSource = source.slice(source.indexOf('function SessionRow('));

function between(start: string, end: string): string {
  const from = sessionRowSource.indexOf(start);
  const to = sessionRowSource.indexOf(end, from + start.length);
  expect(from, `missing start token: ${start}`).toBeGreaterThan(-1);
  expect(to, `missing end token: ${end}`).toBeGreaterThan(from);
  return sessionRowSource.slice(from, to);
}

describe('T13 session context menu wiring', () => {
  it('scopes these assertions to SessionRow, which is not the file s first context menu', () => {
    expect(sessionRowSource.length).toBeGreaterThan(0);
    // Non-vacuity: if the row ever became the first trigger again, the scoping
    // above would be silently pointless.
    expect(source.indexOf('<ContextMenuPrimitive.Trigger')).toBeLessThan(
      source.indexOf('function SessionRow(')
    );
  });

  it('right-click is owned by a context-menu trigger and has no direct archive handler', () => {
    const trigger = between('<ContextMenuPrimitive.Trigger', '</ContextMenuPrimitive.Trigger>');

    // U31 made the click target mode-dependent: in selection mode it toggles
    // the checkbox instead of activating the session. `onSelect()` is still the
    // only thing that activates, and it is still reached from this one handler.
    expect(trigger).toContain('onToggleSelect(row.sessionId) : onSelect()');
    expect(trigger).not.toContain('onContextMenu=');
    expect(trigger).not.toContain('onArchive()');
  });

  it('offers Rename and Archive, with no permanent Delete action', () => {
    const menu = between('</ContextMenuPrimitive.Trigger>', '</MenuPopup>');

    expect(menu).toContain('onClick={beginRename}');
    expect(menu).toContain("{t('Rename')}");
    expect(menu).toContain('onClick={requestArchive}');
    expect(menu).toContain("{t('Archive')}");
    expect(menu).not.toContain("{t('Delete')}");
  });

  it('routes both menu and hover Archive through confirmation', () => {
    expect(source).toContain('const requestArchive = () => {');
    expect(source).toContain('setArchiveConfirmOpen(true)');
    expect(source).toContain('const confirmArchive = () => {');
    expect(source).toContain('onArchive();');
    expect(source).toContain('onClick={confirmArchive}');

    const actionButtons = between('aria-label="Archive session"', '<DeleteTempButton');
    expect(actionButtons).toContain('requestArchive()');
    expect(actionButtons).not.toContain('onArchive()');
  });

  it('uses the semantic Base UI context-menu trigger and preserves row keyboard focus', () => {
    expect(source).toContain('<ContextMenuPrimitive.Root>');
    expect(sessionRowSource).toContain('<ContextMenuPrimitive.Trigger');
    const trigger = between('<ContextMenuPrimitive.Trigger', '</ContextMenuPrimitive.Trigger>');
    expect(trigger).toContain('role="button"');
    expect(trigger).toContain('tabIndex={0}');
    expect(trigger).toContain("event.key === 'Enter'");
  });
});
