import type { GitStatus } from '@shared/types/git';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_SURFACES,
  type ContextSurfaceId,
  countChangedFiles,
  DEFAULT_SURFACE_ORDER,
  firstAlwaysSurfaceId,
  isContextSurfaceId,
  isRailSelectableSurface,
  railSurfaces,
  shouldShowActivityDot,
  sortSurfaces,
} from '../surfaceRegistry';

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
const WIRED: ContextSurfaceId[] = ['chat', 'context', 'editor', 'git', 'run', 'terminal'];

describe('CONTEXT_SURFACES', () => {
  // 12 since U06-a added `run`, which openchamber never had: the registry is
  // this app's surface list, not a frozen copy of that one.
  it('registers every surface exactly once so later rounds only flip flags', () => {
    expect(CONTEXT_SURFACES).toHaveLength(12);
    expect(new Set(CONTEXT_SURFACES.map((s) => s.id)).size).toBe(12);
    expect(DEFAULT_SURFACE_ORDER).toHaveLength(12);
  });

  // 2026-09-04: terminal left this set when its rail button was removed. It is
  // still WIRED (the view exists and has no pendingTask) — `registeredOnly`
  // here means "not offered on the rail", which for terminal is now a product
  // decision rather than a missing implementation.
  it('marks exactly chat/editor/git/context/run as the rail-offered surfaces', () => {
    const thisRound = CONTEXT_SURFACES.filter((s) => !s.registeredOnly)
      .map((s) => s.id)
      .sort();
    expect(thisRound).toEqual(['chat', 'context', 'editor', 'git', 'run']);
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
    expect(isContextSurfaceId('chat')).toBe(true);
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

describe('sortSurfaces', () => {
  it('returns the default order for an empty persisted order', () => {
    expect(sortSurfaces([]).map((s) => s.id)).toEqual(DEFAULT_SURFACE_ORDER);
  });

  it('applies a persisted reorder', () => {
    const result = sortSurfaces(['terminal', 'editor']).map((s) => s.id);
    expect(result[0]).toBe('terminal');
    expect(result[1]).toBe('editor');
  });

  it('drops ids the registry no longer knows', () => {
    const result = sortSurfaces(['bogus', 'git']).map((s) => s.id);
    expect(result).not.toContain('bogus');
    expect(result[0]).toBe('git');
    expect(result).toHaveLength(DEFAULT_SURFACE_ORDER.length);
  });

  it('dedupes a repeated id', () => {
    const result = sortSurfaces(['git', 'git', 'editor']).map((s) => s.id);
    expect(result[0]).toBe('git');
    expect(result[1]).toBe('editor');
    expect(result.filter((id) => id === 'git')).toHaveLength(1);
    expect(result).toHaveLength(DEFAULT_SURFACE_ORDER.length);
  });

  it('appends surfaces missing from the persisted order in default order', () => {
    const result = sortSurfaces(['terminal']).map((s) => s.id);
    const expectedTail = DEFAULT_SURFACE_ORDER.filter((id) => id !== 'terminal');
    expect(result).toEqual(['terminal', ...expectedTail]);
  });
});

describe('railSurfaces', () => {
  // T-32 (D27): the order IS A08's tab order — `git | files | context`
  // (a08:1259-1262). `terminal` used to be appended for exemption ①; it was
  // taken off the rail on 2026-09-04. This list is also what Ctrl/Cmd+1..4
  // binds to, so it is a two-for-one pin.
  it('shows chat first, then git/files/context/run (D08 dock order)', () => {
    expect(railSurfaces(DEFAULT_SURFACE_ORDER).map((s) => s.id)).toEqual([
      'chat',
      'git',
      'editor',
      'context',
      'run',
    ]);
  });

  it('never shows terminal — it has no entry point since 2026-09-04', () => {
    expect(
      railSurfaces(DEFAULT_SURFACE_ORDER, { hasContent: () => true }).map((s) => s.id)
    ).not.toContain('terminal');
    expect(isRailSelectableSurface('terminal')).toBe(false);
  });

  // D08 moved `chat` from a deferred 'has-content' slot to the dock's first
  // always-available entry — the session list is not content-driven.
  it('always shows chat, with no content signal (D08)', () => {
    expect(railSurfaces(DEFAULT_SURFACE_ORDER).map((s) => s.id)).toContain('chat');
  });

  it('reveals a content-driven surface once hasContent reports true', () => {
    const result = railSurfaces(DEFAULT_SURFACE_ORDER, { hasContent: (id) => id === 'preview' });
    // `preview` is still registeredOnly, so hasContent alone must not surface
    // it — the flag, not the signal, is what keeps an unbuilt surface off the rail.
    expect(result.map((s) => s.id)).not.toContain('preview');
  });

  it('never shows registry-only surfaces (pr/diff/plan/notes/browser/preview)', () => {
    const result = railSurfaces(DEFAULT_SURFACE_ORDER, { hasContent: () => true }).map((s) => s.id);
    for (const id of ['pr', 'diff', 'plan', 'notes', 'browser', 'preview'] as const) {
      expect(result).not.toContain(id);
    }
  });

  it('respects the rail order for the visible subset', () => {
    // `terminal` leads the persisted order and is dropped anyway — a stale
    // railOrder from before it was removed must not resurrect the button.
    // `run` is absent from this persisted order — `sortSurfaces` appends it,
    // which is exactly what an existing profile sees after the U06-a upgrade.
    // D08: `chat` is likewise absent from this pre-D08 order and appended.
    const result = railSurfaces(['terminal', 'git', 'context', 'editor']).map((s) => s.id);
    expect(result).toEqual(['git', 'context', 'editor', 'chat', 'run']);
  });

  // D08 retires `columnMode` entirely: there is one layout, so the rail always
  // offers the same five entries and `chat` leads them.
  it("offers the dock's five entries, chat first (D08)", () => {
    expect(railSurfaces(DEFAULT_SURFACE_ORDER).map((s) => s.id)).toEqual([
      'chat',
      'git',
      'editor',
      'context',
      'run',
    ]);
  });
});

describe('isRailSelectableSurface', () => {
  it('accepts a rail-visible surface', () => {
    expect(isRailSelectableSurface('git')).toBe(true);
  });

  it('rejects a registry-only surface', () => {
    expect(isRailSelectableSurface('pr')).toBe(false);
  });

  // D08 repurposed `chat` from a deferred 'has-content' slot into the dock's
  // always-available session list, so it is selectable with no content signal.
  it('accepts chat unconditionally now that it is the session list (D08)', () => {
    expect(isRailSelectableSurface('chat')).toBe(true);
  });

  it('still rejects a content-driven surface without content', () => {
    expect(isRailSelectableSurface('preview')).toBe(false);
  });
});

describe('firstAlwaysSurfaceId', () => {
  it("returns the dock's first entry as the bare-open fallback", () => {
    // D08: `chat` leads the registry now, so an "open the dock" with nothing
    // remembered lands on the session list.
    expect(firstAlwaysSurfaceId()).toBe('chat');
    expect(firstAlwaysSurfaceId({ hasContent: () => true })).toBe('chat');
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
