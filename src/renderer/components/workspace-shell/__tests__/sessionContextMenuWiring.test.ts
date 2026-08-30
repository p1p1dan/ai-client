import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

const source = stripComments(
  readFileSync(path.join(__dirname, '..', 'LeftNav.tsx'), 'utf8'),
  'LeftNav.tsx'
);
function between(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `missing start token: ${start}`).toBeGreaterThan(-1);
  expect(to, `missing end token: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('T13 session context menu wiring', () => {
  it('right-click is owned by a context-menu trigger and has no direct archive handler', () => {
    const trigger = between('<ContextMenuPrimitive.Trigger', '</ContextMenuPrimitive.Trigger>');

    expect(trigger).toContain('onClick={onSelect}');
    expect(trigger).not.toContain('onContextMenu=');
    expect(trigger).not.toContain('onArchive()');
  });

  it('offers Rename and Archive, with no permanent Delete action', () => {
    const menu = between('<MenuPopup', '</MenuPopup>');

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
    expect(source).toContain('<ContextMenuPrimitive.Trigger');
    const trigger = between('<ContextMenuPrimitive.Trigger', '</ContextMenuPrimitive.Trigger>');
    expect(trigger).toContain('role="button"');
    expect(trigger).toContain('tabIndex={0}');
    expect(trigger).toContain("event.key === 'Enter'");
  });
});
