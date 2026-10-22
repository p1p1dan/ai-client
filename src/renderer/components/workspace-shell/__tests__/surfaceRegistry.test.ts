import type { GitStatus } from '@shared/types/git';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_SURFACES,
  type ContextSurfaceId,
  countChangedFiles,
  DEFAULT_SURFACE_ORDER,
  isContextSurfaceId,
  shouldShowActivityDot,
} from '../surfaceRegistry';
import { tabForIntent } from '../workPanelModel';

function gitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isClean: true,
    current: 'main',
    tracking: 'origin/main',
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    deleted: [],
    untracked: [],
    conflicted: [],
    ...overrides,
  };
}

/**
 * Surfaces with a real view wired in `surfaceViews.tsx`. The pendingTask
 * assertion below is an IFF against this list, so the honest empty state can
 * neither outlive its wiring nor be dropped before it: the task that lands a
 * surface adds exactly one id here and nulls exactly one `pendingTask`, and
 * either edit alone fails.
 *
 * Empty at S0 (shell prerequisite only); T-12~T-15 each add one line.
 */
const WIRED: ContextSurfaceId[] = ['context', 'editor', 'git', 'run', 'terminal'];

describe('CONTEXT_SURFACES', () => {
  // 12 since U06-a added `run`, which openchamber never had; 11 since layout
  // 5a (design system v2) retired the dock's `chat` slot — the sidebar is the
  // chat list itself now, not a surface.
  it('registers every surface exactly once so later rounds only flip flags', () => {
    expect(CONTEXT_SURFACES).toHaveLength(11);
    expect(new Set(CONTEXT_SURFACES.map((s) => s.id)).size).toBe(11);
    expect(DEFAULT_SURFACE_ORDER).toHaveLength(11);
    expect(isContextSurfaceId('chat')).toBe(false);
  });

  // 2026-09-04: terminal left this set when its rail button was removed. It is
  // still WIRED (the view exists and has no pendingTask) — `registeredOnly`
  // means "not offered as navigation"; only the init script opens it.
  it('marks exactly editor/git/context/run as navigable, each with a work panel tab (layout 5a)', () => {
    const navigable = CONTEXT_SURFACES.filter((s) => !s.registeredOnly)
      .map((s) => s.id)
      .sort();
    expect(navigable).toEqual(['context', 'editor', 'git', 'run']);
    for (const id of navigable) {
      expect(tabForIntent({ type: 'surface', surfaceId: id })).not.toBeNull();
    }
    expect(tabForIntent({ type: 'surface', surfaceId: 'terminal' })).toBeNull();
  });

  it('names a pendingTask for exactly the surfaces that are not wired yet', () => {
    for (const surface of CONTEXT_SURFACES) {
      if (WIRED.includes(surface.id)) {
        expect(surface.pendingTask).toBeNull();
      } else {
        expect(surface.pendingTask).not.toBeNull();
      }
    }
  });
});

describe('isContextSurfaceId', () => {
  it('accepts a registered id', () => {
    expect(isContextSurfaceId('git')).toBe(true);
  });

  it('rejects unknown strings, null, numbers and objects', () => {
    expect(isContextSurfaceId('bogus')).toBe(false);
    expect(isContextSurfaceId(null)).toBe(false);
    expect(isContextSurfaceId(42)).toBe(false);
    expect(isContextSurfaceId({})).toBe(false);
  });
});

describe('panel width is not per-surface (T-32 m1)', () => {
  it('no descriptor carries a width fraction', () => {
    // The per-surface `defaultWidthFraction` made every tab click resize the
    // panel — A08 gives all three tabs one 380 default (a08:1550), and the
    // user reported the resizing as a bug. Reintroducing a per-surface width
    // is a decision, not a tidy-up: it belongs in a ledger row first.
    for (const surface of CONTEXT_SURFACES) {
      expect(surface).not.toHaveProperty('defaultWidthFraction');
    }
  });
});

describe('countChangedFiles', () => {
  it('sums staged, modified, deleted, untracked and conflicted paths', () => {
    const status = gitStatus({
      staged: ['a.ts'],
      modified: ['b.ts'],
      deleted: ['c.ts'],
      untracked: ['d.ts'],
      conflicted: ['e.ts'],
    });
    expect(countChangedFiles(status)).toBe(5);
  });

  it('counts a path staged and modified again only once', () => {
    const status = gitStatus({ staged: ['a.ts'], modified: ['a.ts', 'b.ts'] });
    expect(countChangedFiles(status)).toBe(2);
  });

  it('returns 0 for a clean tree', () => {
    expect(countChangedFiles(gitStatus())).toBe(0);
  });

  it('returns 0 for null / undefined status', () => {
    expect(countChangedFiles(null)).toBe(0);
    expect(countChangedFiles(undefined)).toBe(0);
  });
});

describe('shouldShowActivityDot', () => {
  it('lights the dot for git when changed files exist', () => {
    expect(shouldShowActivityDot('git', { changedFilesCount: 1 })).toBe(true);
  });

  it('keeps the dot dark for git on a clean tree', () => {
    expect(shouldShowActivityDot('git', { changedFilesCount: 0 })).toBe(false);
  });

  it('never lights the dot for editor / terminal / context even with changes', () => {
    expect(shouldShowActivityDot('editor', { changedFilesCount: 5 })).toBe(false);
    expect(shouldShowActivityDot('terminal', { changedFilesCount: 5 })).toBe(false);
    expect(shouldShowActivityDot('context', { changedFilesCount: 5 })).toBe(false);
  });
});
