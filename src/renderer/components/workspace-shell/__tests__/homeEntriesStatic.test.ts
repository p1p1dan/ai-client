import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * Decision 174 (GitHub issue #6, second wave; user rulings 2026-10-10): the
 * wiring of the home page that no unit test mounts — the rail entry, the
 * session bar, the shell handing the view to the chat column, and the column
 * keeping ONE composer for the home page and every conversation. Pinned
 * against source, like this directory's other static tests.
 */

const read = (relative: string) => {
  const file = path.join(process.cwd(), relative);
  return stripComments(readFileSync(file, 'utf8'), file);
};

const dock = read('src/renderer/components/workspace-shell/LeftDock.tsx');
const bar = read('src/renderer/components/workspace-shell/SessionBar.tsx');
const shell = read('src/renderer/components/workspace-shell/WorkspaceShell.tsx');
const nav = read('src/renderer/components/workspace-shell/LeftNav.tsx');
const workspace = read('src/renderer/components/chat/ChatWorkspace.tsx');
const composer = read('src/renderer/components/chat/ChatComposer.tsx');

describe('the home entry on the rail (entry (a))', () => {
  it('sits above the five panels, set off by a short rule, and opens the home page', () => {
    const entry = dock.indexOf(
      "<RailIconButton label={t('Home')} icon={House} onClick={() => openHome()} />"
    );
    expect(entry).toBeGreaterThan(-1);
    const rule = dock.indexOf('data-rail-separator=""');
    expect(rule).toBeGreaterThan(entry);
    expect(rule).toBeLessThan(dock.indexOf('{tabs.map((tab) => ('));
    // After the title-row spacer, so it lines up with the panel's first row.
    expect(dock.indexOf('<div aria-hidden className="h-9 shrink-0" />')).toBeLessThan(entry);
  });

  it('is a 32px icon button with no pressed state', () => {
    const iconButton = dock.slice(dock.indexOf('function RailIconButton('));
    expect(iconButton).toContain('h-8 w-8');
    expect(iconButton).not.toContain('aria-pressed');
  });
});

describe('the session bar', () => {
  it('names the home page when no conversation is open', () => {
    expect(bar).toContain(
      "{activeSession ? displaySessionTitle(activeSession.title, t) : t('Home')}"
    );
    expect(bar).not.toContain("t('No conversation open')");
  });

  it('「＋」 opens the home page with the conversation’s folder, or hands the home page the keyboard', () => {
    const start = bar.indexOf('const startNewChat = () => {');
    const handler = bar.slice(start, bar.indexOf('\n  };', start));
    expect(handler).toContain('requestComposerFocus(null)');
    expect(handler).toContain("openHome(path ? { kind: 'path', path } : undefined)");
    expect(bar).not.toContain('createOrReuse');
  });
});

describe('the temporary chats region', () => {
  it('「新建临时对话」 opens the home page with no repository picked', () => {
    expect(nav).toContain("<MenuItem onClick={() => openHome({ kind: 'unbound' })}>");
  });
});

describe('the chat column', () => {
  it('the shell hands it the home page', () => {
    expect(shell).toContain('home={<HomeView />}');
  });

  it('shows the home page while no conversation is open, and no timeline', () => {
    expect(workspace).toContain('const onHome = activeSessionId === null;');
    expect(workspace).toContain(
      '{onHome && (home ?? <div aria-hidden className="min-h-0 flex-1" />)}'
    );
    expect(workspace).toContain("{!onHome && renderedMode === 'session' && (");
  });

  it('keeps ONE composer for the home page and every conversation, so the first send moves nothing', () => {
    expect(workspace.match(/<ChatComposer\b/g) ?? []).toHaveLength(1);
    // And the home page docks it in the conversation geometry: the mode is
    // derived, never forced to `empty` for "no session".
    expect(workspace).toContain('mode={renderedMode}');
  });

  it('picks nothing when the open conversation goes away', () => {
    expect(workspace).not.toContain('isStartupSeedSession');
    expect(workspace).toContain('selectSession(null);');
    expect(workspace).not.toContain('sessions[0]');
  });
});

describe('the composer on the home page', () => {
  it('renders the session-mode work bar below the card, as in a conversation', () => {
    const card = composer.indexOf('<div className={composerCardClass(mode, { hasProtrusion })}');
    const sessionBar = composer.indexOf("{mode === 'session' && (\n        <ComposerTargetBar");
    expect(card).toBeGreaterThan(-1);
    expect(sessionBar).toBeGreaterThan(card);
  });

  it('puts the locked-checkout notice above the card, where the model-missing card sits', () => {
    const noticeAt = composer.indexOf('<HomeSendBlockedNotice');
    expect(noticeAt).toBeGreaterThan(composer.indexOf('<ModelMissingNotice'));
    expect(noticeAt).toBeLessThan(
      composer.indexOf('<div className={composerCardClass(mode, { hasProtrusion })}')
    );
  });
});
