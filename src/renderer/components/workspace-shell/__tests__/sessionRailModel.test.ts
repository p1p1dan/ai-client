/**
 * Layout 5e (ui-cohesion §6, ruling L5): the session rail's pure rules —
 * when it shows, which cards it draws, and what each card derives.
 */
import { describe, expect, it } from 'vitest';
import {
  CHANGES_CARD_FILES,
  deriveChangesCardView,
  deriveContextCardView,
  deriveEnvironmentRows,
  type EnvironmentInput,
  formatLineCount,
  resolveCardOpen,
  resolveKnownEngine,
  resolveSessionRailVisibility,
  SESSION_RAIL_MIN_CHAT_WIDTH,
  SESSION_RAIL_WIDTH,
  sanitizeCardOpen,
  sessionRailToggleEnabled,
  truncateMiddle,
  visibleRailCards,
} from '../sessionRail/sessionRailModel';
import type { SessionReviewEntry } from '../sessionReview';

const WIDE = SESSION_RAIL_WIDTH + SESSION_RAIL_MIN_CHAT_WIDTH;

describe('resolveSessionRailVisibility', () => {
  const base = { userShown: true, sessionOpen: true, panesOpen: 0, chatWidth: 1200 };

  it('shows beside an open chat that is wide enough, with no pane open', () => {
    expect(resolveSessionRailVisibility(base)).toEqual({ visible: true, hidden: null });
  });

  it('never shows on the home page, whatever else holds', () => {
    expect(resolveSessionRailVisibility({ ...base, sessionOpen: false }).hidden).toBe('no-session');
  });

  it('the user can hide it', () => {
    expect(resolveSessionRailVisibility({ ...base, userShown: false })).toEqual({
      visible: false,
      hidden: 'user',
    });
  });

  it('yields to any open pane, however wide the window', () => {
    expect(resolveSessionRailVisibility({ ...base, panesOpen: 1, chatWidth: 4000 })).toEqual({
      visible: false,
      hidden: 'panes',
    });
  });

  it('hides when the chat would get narrower than its floor', () => {
    expect(resolveSessionRailVisibility({ ...base, chatWidth: WIDE }).visible).toBe(true);
    expect(resolveSessionRailVisibility({ ...base, chatWidth: WIDE - 1 })).toEqual({
      visible: false,
      hidden: 'narrow',
    });
    // Chat column hidden (a diff tab took the row): width 0.
    expect(resolveSessionRailVisibility({ ...base, chatWidth: 0 }).hidden).toBe('narrow');
  });

  it('the toggle acts only when the user choice is what decides', () => {
    const at = (over: Partial<typeof base>) =>
      sessionRailToggleEnabled(resolveSessionRailVisibility({ ...base, ...over }));
    expect(at({})).toBe(true);
    expect(at({ userShown: false })).toBe(true);
    expect(at({ panesOpen: 2 })).toBe(false);
    expect(at({ chatWidth: 500 })).toBe(false);
  });
});

describe('card folds', () => {
  it('defaults: the context card starts folded, the others open', () => {
    expect(resolveCardOpen(undefined, 'context')).toBe(false);
    expect(resolveCardOpen(undefined, 'environment')).toBe(true);
    expect(resolveCardOpen({ context: true }, 'context')).toBe(true);
    expect(resolveCardOpen({ changes: false }, 'changes')).toBe(false);
  });

  it('sanitizes persisted junk down to known ids with boolean values', () => {
    expect(sanitizeCardOpen({ todo: false, context: 'yes', bogus: true })).toEqual({ todo: false });
    expect(sanitizeCardOpen(null)).toEqual({});
    expect(sanitizeCardOpen('x')).toEqual({});
  });
});

function entry(id: string, path: string, added: number, removed: number): SessionReviewEntry {
  return { id, path, status: 'modified', added, removed } as SessionReviewEntry;
}

describe('deriveChangesCardView', () => {
  it('no card while the review is off or nothing changed', () => {
    expect(deriveChangesCardView(null)).toBeNull();
    expect(deriveChangesCardView([])).toBeNull();
  });

  it('sums the line counts and lists the first files, the rest as a count', () => {
    const entries = [
      entry('a', 'src/app/main.ts', 10, 2),
      entry('b', 'README.md', 1, 0),
      entry('c', 'C:\\repo\\lib\\x.ts', 3, 3),
      entry('d', 'docs/y.md', 5, 1),
    ];
    const view = deriveChangesCardView(entries);
    expect(view).toMatchObject({ count: 4, added: 19, removed: 6, more: 1 });
    expect(view?.files).toHaveLength(CHANGES_CARD_FILES);
    expect(view?.files.map((file) => [file.name, file.dir])).toEqual([
      ['main.ts', 'src/app'],
      ['README.md', ''],
      ['x.ts', 'C:/repo/lib'],
    ]);
    expect(view?.files[0]).toMatchObject({ entryId: 'a', path: 'src/app/main.ts' });
  });

  it('formats line counts the way the reference does', () => {
    expect(formatLineCount(10181)).toBe('10,181');
  });
});

describe('truncateMiddle', () => {
  it('keeps short text and both ends of long text', () => {
    expect(truncateMiddle('F:\\ProjectDev', 26)).toBe('F:\\ProjectDev');
    const cut = truncateMiddle('/home/pi/code/some/deep/folder/ai-client', 20);
    expect(cut).toHaveLength(20);
    expect(cut.startsWith('/home/pi/')).toBe(true);
    expect(cut.endsWith('ai-client')).toBe(true);
    expect(cut).toContain('…');
  });
});

describe('deriveEnvironmentRows', () => {
  const none: EnvironmentInput = {
    runLocation: null,
    workspace: null,
    projectName: null,
    unboundPath: null,
    engine: null,
    model: null,
    permission: null,
  };

  it('leaves out every row it has no data for', () => {
    expect(deriveEnvironmentRows(none)).toEqual([]);
  });

  it('a repository chat on a worktree: location, folder, branch tagged worktree, engine, posture', () => {
    const rows = deriveEnvironmentRows({
      runLocation: { text: 'This PC', tone: 'local' },
      workspace: { name: 'wt-1', path: '/repo/.wt/1', kind: 'worktree', branch: 'feat/x' },
      projectName: 'ai-client',
      unboundPath: null,
      engine: 'dsh',
      model: 'DeepSeek V4',
      permission: 'Full auto',
    });
    expect(rows).toEqual([
      { id: 'location', text: 'This PC', tone: 'local' },
      { id: 'folder', name: 'ai-client', path: '/repo/.wt/1' },
      { id: 'branch', text: 'feat/x', worktree: true },
      { id: 'engine', engine: 'dsh', model: 'DeepSeek V4' },
      { id: 'permission', text: 'Full auto' },
    ]);
  });

  it('a main checkout with no branch known shows no branch row', () => {
    const rows = deriveEnvironmentRows({
      ...none,
      workspace: { name: 'Main', path: '/repo', kind: 'main' },
      projectName: 'repo',
    });
    expect(rows.map((row) => row.id)).toEqual(['folder']);
  });

  it('the chat record path comes last, once Main has found it (user, 2026-10-23)', () => {
    expect(
      deriveEnvironmentRows({
        ...none,
        permission: 'Full auto',
        transcriptPath: '/home/u/rec.jsonl',
      })
    ).toEqual([
      { id: 'permission', text: 'Full auto' },
      { id: 'transcript', path: '/home/u/rec.jsonl' },
    ]);
    expect(deriveEnvironmentRows({ ...none, transcriptPath: null })).toEqual([]);
  });

  it('a temporary chat names its scratch folder; a model without a known engine still shows', () => {
    const rows = deriveEnvironmentRows({
      ...none,
      unboundPath: '/tmp/scratch/chat-1',
      model: 'claude-opus-5-5',
    });
    expect(rows).toEqual([
      { id: 'folder', name: 'chat-1', path: '/tmp/scratch/chat-1' },
      { id: 'model', model: 'claude-opus-5-5' },
    ]);
  });
});

describe('resolveKnownEngine', () => {
  it('no engine row before the chat started', () => {
    expect(resolveKnownEngine({ bound: false })).toBeNull();
  });

  it("Main's report, else the identity stub", () => {
    expect(resolveKnownEngine({ bound: true })).toBe('dsh');
    expect(resolveKnownEngine({ bound: true, engine: 'claude-sdk' })).toBe('claude-sdk');
    expect(resolveKnownEngine({ bound: false, runtimeIdentity: 'abc' })).toBe('dsh');
  });
});

describe('deriveContextCardView', () => {
  const usage = {
    input: 100,
    output: 10,
    cacheRead: 300,
    cacheWrite: 100,
    totalTokens: 510,
    context: { tokens: 12_000, contextWindow: 100_000, percent: 12 },
  } as unknown as Parameters<typeof deriveContextCardView>[0]['usage'];

  it('no card with nothing measured and nothing loaded', () => {
    expect(deriveContextCardView({ usage: null, hasMessages: false })).toBeNull();
  });

  it('a loaded chat with no measurement yet keeps the card, without a percentage', () => {
    expect(deriveContextCardView({ usage: null, hasMessages: true })).toEqual({
      percent: null,
      usedTokens: null,
      contextWindow: null,
      cacheHitRate: null,
    });
  });

  it('the measured share, tokens and cache hit rate', () => {
    const view = deriveContextCardView({ usage, hasMessages: true });
    expect(view).toMatchObject({ percent: 12, usedTokens: 12_000, contextWindow: 100_000 });
    expect(view?.cacheHitRate).toBe(60);
  });

  it('an unreported request has no cache rate to show', () => {
    const unreported = { ...usage, unreported: true } as typeof usage;
    expect(
      deriveContextCardView({ usage: unreported, hasMessages: true })?.cacheHitRate
    ).toBeNull();
  });
});

describe('visibleRailCards', () => {
  it('draws only cards with something to say, in rail order', () => {
    expect(
      visibleRailCards({
        environmentRows: 2,
        context: true,
        changes: true,
        todo: true,
        servers: 1,
        running: 1,
      })
    ).toEqual(['environment', 'context', 'changes', 'todo', 'servers', 'running']);
    expect(
      visibleRailCards({
        environmentRows: 1,
        context: false,
        changes: false,
        todo: false,
        servers: 0,
        running: 0,
      })
    ).toEqual(['environment']);
    expect(
      visibleRailCards({
        environmentRows: 0,
        context: true,
        changes: false,
        todo: true,
        servers: 0,
        running: 0,
      })
    ).toEqual(['context', 'todo']);
  });
});
