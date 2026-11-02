import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * Decision 174 (GitHub issue #6, second wave; user rulings 2026-10-10): the
 * wiring of the home page that no unit test mounts — the sidebar entry, the
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

describe('the home entry (entry (a)), after the rail (design system v2 / layout 5a)', () => {
  it('the rail and its Home button are gone; the sidebar shows the chat list directly', () => {
    expect(dock).not.toContain('RailIconButton');
    expect(dock).not.toContain('data-rail-separator');
    expect(dock).not.toContain("t('Home')");
    expect(dock).toContain('<LeftNav');
  });

  it('the chat list`s own 「新建对话」 opens the home page instead', () => {
    const start = nav.indexOf('const handleNewSession = () => {');
    const handler = nav.slice(start, nav.indexOf('\n  };', start));
    expect(handler).toContain('openHome();');
    expect(handler).toContain(
      "openHome(preselect ? { kind: 'path', path: preselect.path } : undefined)"
    );
    expect(nav).toContain('onClick={handleNewSession}');
  });
});

describe('the session bar', () => {
  it('names the home page when no conversation is open', () => {
    expect(bar).toContain(
      "const titleText = activeSession ? displaySessionTitle(activeSession.title, t) : t('Home');"
    );
    expect(bar).not.toContain("t('No conversation open')");
  });

  it('「新建对话」 (title menu) opens the home page with the conversation’s folder, or hands the home page the keyboard', () => {
    const start = bar.indexOf('const startNewChat = () => {');
    const handler = bar.slice(start, bar.indexOf('\n  };', start));
    expect(handler).toContain('requestComposerFocus(null)');
    expect(handler).toContain("openHome(path ? { kind: 'path', path } : undefined)");
    expect(bar).not.toContain('createOrReuse');
  });
});

describe('the temporary chats group', () => {
  it('「新建临时对话」 opens the home page with no repository picked', () => {
    expect(nav).toContain("<MenuItem onClick={() => openHome({ kind: 'unbound' })}>");
    // Decision 183 §2.9: the header's hover 「＋」 does the same.
    expect(nav).toContain("onClick={() => openHome({ kind: 'unbound' })}\n");
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

// PiLab R2: the card's class also lights it up while a file is dragged over it.
const CARD_OPEN =
  "className={cn(composerCardClass(mode, { hasProtrusion }), fileDragOver && 'drop-target')}";

describe('the composer on the home page', () => {
  it('renders the session-mode work bar below the card, as in a conversation', () => {
    const card = composer.indexOf(CARD_OPEN);
    const sessionBar = composer.indexOf("{mode === 'session' && (\n        <ComposerTargetBar");
    expect(card).toBeGreaterThan(-1);
    expect(sessionBar).toBeGreaterThan(card);
  });

  it('puts the locked-checkout notice above the card, where the model-missing card sits', () => {
    const noticeAt = composer.indexOf('<HomeSendBlockedNotice');
    expect(noticeAt).toBeGreaterThan(composer.indexOf('<ModelMissingNotice'));
    expect(noticeAt).toBeLessThan(composer.indexOf(CARD_OPEN));
  });
});
