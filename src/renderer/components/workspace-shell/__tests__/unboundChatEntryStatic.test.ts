import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * U22 — there must be a reachable way to start a chat with no repository.
 *
 * The behaviour itself is covered by `chatSessionActions.test.ts`. What cannot
 * be reached from a pure function is whether the UI actually OFFERS it, and
 * that is precisely where this broke: `createUnboundChatSession`'s equivalent
 * state was already sendable (U05), the composer's only remaining gate was
 * `activeSessionId`, and both entry points that could produce one bailed out on
 * a machine with no workspace — `+ new` was `disabled` and returned early, and
 * the welcome card offered nothing but "add a repository".
 *
 * Pinned against source the same way `pluginEntryStatic` pins U04's shape.
 */
const navPath = path.join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const nav = stripComments(readFileSync(navPath, 'utf8'), navPath);
const cardPath = path.join(process.cwd(), 'src/renderer/components/chat/ChatWelcomeCard.tsx');
const card = stripComments(readFileSync(cardPath, 'utf8'), cardPath);
const workspacePath = path.join(process.cwd(), 'src/renderer/components/chat/ChatWorkspace.tsx');
const workspace = stripComments(readFileSync(workspacePath, 'utf8'), workspacePath);

describe('U22 unbound chat entry points', () => {
  it('the New button is never disabled — no workspace is a case, not a dead end', () => {
    // The regression this guards: `disabled={!canStartNewSession}` made the one
    // entry point on a fresh install unclickable, so the welcome card's promise
    // ("without one, this chat runs in a private temporary folder") had no path
    // behind it and the composer stayed permanently greyed out.
    expect(nav).not.toContain('disabled={!canStartNewSession}');
    expect(nav).not.toMatch(/onClick=\{handleNewSession\}[^>]*disabled/);
  });

  it('opens the home page instead of making a chat (decision 174)', () => {
    // Decision 174 (issue #6, second wave; user ruling 2026-10-10): 「＋新建」
    // opens the home page with the corresponding repository picked, and the
    // conversation is made by the first send there — on that repository, or as
    // a temporary chat when none is picked or none exists. Nothing is made on
    // the click, bound or unbound. Sliced to the function's closing brace.
    const start = nav.indexOf('const handleNewSession');
    const handler = nav.slice(start, nav.indexOf('\n  };', start));
    expect(handler).toContain('openHome(');
    expect(handler).toContain('resolveHomePreselect(');
    expect(handler).not.toContain('createOrReuseUnboundChatSession');
    expect(handler).not.toContain('createOrReuseChatSessionOnWorkspace');
    expect(nav).not.toContain('createOrReuse');
  });

  it('U28: the start screen has no button — the composer itself is the entry', () => {
    // U22 put a "just start chatting" button on the card because the composer
    // below was disabled without a session. That was a workaround for the gate,
    // not a fix: `canSend` still required a session, and the button handed its
    // click event straight to `createUnboundChatSession` as a title, which
    // React then tried to render as a child (the reported crash).
    //
    // U28 removes the gate instead. The button is gone with it.
    expect(card).not.toContain('onStartTemporaryChat');
    expect(card).not.toContain('Just start chatting');
    expect(workspace).not.toContain('onStartTemporaryChat');
  });

  it('U28: the send gate no longer requires a session', () => {
    const composerPath = path.join(process.cwd(), 'src/renderer/components/chat/ChatComposer.tsx');
    const composer = stripComments(readFileSync(composerPath, 'utf8'), composerPath);
    // The first send is what creates the conversation, the way pix does it.
    // Decision 174: on the home page the send makes it on the work bar's draft
    // target (`sendFromHome`) and hands it to `runSend`; the unbound fallback
    // stays for a caller with nothing selected and no such conversation.
    expect(composer).toContain(
      'const sessionId = options.home?.sessionId ?? activeSessionId ?? createUnboundChatSession();'
    );
    expect(composer).not.toContain('if (!canSend || !activeSessionId) {');
  });
});
