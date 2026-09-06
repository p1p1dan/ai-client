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
    expect(nav).toContain('createUnboundChatSession');
  });

  it('falls back to an unbound session instead of returning early', () => {
    // Sliced to the function's closing brace rather than a character budget:
    // `stripComments` blanks comments in place, so a fixed window would be
    // mostly whitespace and would silently stop covering the body.
    const start = nav.indexOf('const handleNewSession');
    const handler = nav.slice(start, nav.indexOf('\n  };', start));
    expect(handler).toContain('createUnboundChatSession()');
    // The bound path must still win when a workspace IS available, or every
    // chat would land in a scratch directory.
    expect(handler).toContain('createChatSessionOnWorkspace(effectiveWorkspaceId)');
    expect(handler.indexOf('createUnboundChatSession()')).toBeLessThan(
      handler.indexOf('createChatSessionOnWorkspace(effectiveWorkspaceId)')
    );
  });

  it('the welcome card offers the temporary chat only when there is no session', () => {
    expect(card).toContain('onStartTemporaryChat');
    expect(card).toContain("{t('Just start chatting')}");
    // With a session already active the composer below is live, so a second
    // "start chatting" control would create a stray session instead.
    expect(workspace).toContain(
      'activeSessionId ? {} : { onStartTemporaryChat: createUnboundChatSession }'
    );
  });
});
