import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

const renderer = join(process.cwd(), 'src/renderer');

function source(relative: string): string {
  const full = join(renderer, relative);
  return stripComments(readFileSync(full, 'utf8'), full);
}

/**
 * F09 — the two halves the field request named: a bell that shows announcements,
 * and a title bar that no longer carries the `...` menu.
 *
 * Both are statements about `.tsx` files, which the node-env vitest can never
 * render, so they are asserted statically — the same shape
 * `App/__tests__/legacyShellAbsence.test.ts` uses for the shell it deleted.
 */
describe('F09 announcement bell wiring', () => {
  it('mounts the bell in the footer that exists on every platform', () => {
    // NOT in `WindowTitleBar`: that component returns null on macOS, so a bell
    // living only there would leave one shipped platform unable to re-read an
    // announcement after dismissing the startup dialog.
    const footer = source('components/workspace-shell/UserFooterPill.tsx');
    expect(footer).toContain('<AnnouncementBell />');
    expect(source('components/layout/WindowTitleBar.tsx')).not.toContain('AnnouncementBell');
  });

  it('reads the cache before the network, so an offline launch still shows a message', () => {
    const hook = source('components/announcements/useAnnouncements.ts');
    const snapshotAt = hook.indexOf('announcements.get()');
    const refreshAt = hook.indexOf('announcements.refresh()');
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(snapshotAt);
  });

  it('never awaits announcements on a path the shell depends on', () => {
    // The one hard requirement: a slow or dead endpoint must not delay startup.
    const hook = source('components/announcements/useAnnouncements.ts');
    expect(hook).toContain('void window.electronAPI.announcements.get()');
    expect(hook).toContain('void window.electronAPI.announcements.refresh()');
    expect(hook).not.toMatch(/await\s+window\.electronAPI\.announcements/);
  });

  it('indents the body to the same edge as the title', () => {
    // `DialogPopup` carries no padding of its own — the header and footer each
    // bring `px-6`. A body that forgets it renders 24px left of the title it
    // belongs to, which is how the launch announcement looked in the
    // 2026-09-10 screenshot.
    const dialog = source('components/announcements/AnnouncementDialog.tsx');
    const scroll = dialog.slice(dialog.indexOf('<ScrollArea'));
    expect(scroll.slice(0, scroll.indexOf('>'))).toContain('px-6');
  });

  it('prints announcement bodies as text and never as markup', () => {
    const dialog = source('components/announcements/AnnouncementDialog.tsx');
    expect(dialog).toContain('whitespace-pre-wrap');
    expect(dialog).not.toMatch(/dangerouslySetInnerHTML|ChatMarkdown|<Markdown/);
  });
});

describe('F09 title bar overflow menu removal', () => {
  it('leaves the title bar with identity and window controls only', () => {
    const bar = source('components/layout/WindowTitleBar.tsx');
    expect(bar).toContain('<WindowControls />');
    // The four menu items and the menu itself, none of which may come back
    // under a different name: the ruling was "hidden, not moved".
    expect(bar).not.toMatch(/MoreHorizontal|MenuTrigger|TitleBarMenuPopup|MenuItem/);
    expect(bar).not.toMatch(/Reload|openDevTools|github\.com|window\.close/);
  });

  it('does not reopen those entries anywhere else in the renderer', () => {
    // `openDevTools` had exactly one caller, and hiding a control by moving it
    // is the failure this asserts against.
    for (const file of ['components/workspace-shell/UserFooterPill.tsx', 'App.tsx', 'Root.tsx']) {
      expect(source(file), file).not.toMatch(/openDevTools|window\.location\.reload/);
    }
  });

  it('keeps the bell and its dialog as real files', () => {
    for (const file of [
      'components/announcements/AnnouncementBell.tsx',
      'components/announcements/AnnouncementDialog.tsx',
      'components/announcements/useAnnouncements.ts',
    ])
      expect(existsSync(join(renderer, file)), file).toBe(true);
  });
});
