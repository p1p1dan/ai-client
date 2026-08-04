import type { GitStatus } from '@shared/types/git';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_SURFACES,
  type ContextSurfaceId,
  countChangedFiles,
  DEFAULT_SURFACE_ORDER,
  firstAlwaysSurfaceId,
  getSurfaceWidthFraction,
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
const WIRED: ContextSurfaceId[] = [];

describe('CONTEXT_SURFACES', () => {
  it('registers all 11 openchamber surfaces so later rounds only flip flags', () => {
    expect(CONTEXT_SURFACES).toHaveLength(11);
    expect(new Set(CONTEXT_SURFACES.map((s) => s.id)).size).toBe(11);
    expect(DEFAULT_SURFACE_ORDER).toHaveLength(11);
  });

  it("marks exactly chat/editor/git/terminal/context as this round's five", () => {
    const thisRound = CONTEXT_SURFACES.filter((s) => !s.registeredOnly)
      .map((s) => s.id)
      .sort();
    expect(thisRound).toEqual(['chat', 'context', 'editor', 'git', 'terminal']);
  });

  it('keeps every defaultWidthFraction inside (0, 1]', () => {
    for (const surface of CONTEXT_SURFACES) {
      expect(surface.defaultWidthFraction).toBeGreaterThan(0);
      expect(surface.defaultWidthFraction).toBeLessThanOrEqual(1);
    }
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

describe('getSurfaceWidthFraction', () => {
  it('returns the registry fraction for a known surface', () => {
    expect(getSurfaceWidthFraction('git')).toBe(2 / 5);
  });

  it('falls back to 0.5 for null / unknown ids', () => {
    expect(getSurfaceWidthFraction(null)).toBe(0.5);
    expect(getSurfaceWidthFraction(undefined)).toBe(0.5);
    expect(getSurfaceWidthFraction('bogus' as ContextSurfaceId)).toBe(0.5);
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
  it('shows exactly context/git/editor/terminal by default', () => {
    expect(railSurfaces(DEFAULT_SURFACE_ORDER).map((s) => s.id)).toEqual([
      'context',
      'git',
      'editor',
      'terminal',
    ]);
  });

  it('hides chat because it is content-driven and MVP has no split sessions', () => {
    expect(railSurfaces(DEFAULT_SURFACE_ORDER).map((s) => s.id)).not.toContain('chat');
  });

  it('reveals a content-driven surface once hasContent reports true', () => {
    const result = railSurfaces(DEFAULT_SURFACE_ORDER, { hasContent: (id) => id === 'chat' });
    expect(result.map((s) => s.id)).toContain('chat');
  });

  it('never shows registry-only surfaces (pr/diff/plan/notes/browser/preview)', () => {
    const result = railSurfaces(DEFAULT_SURFACE_ORDER, { hasContent: () => true }).map((s) => s.id);
    for (const id of ['pr', 'diff', 'plan', 'notes', 'browser', 'preview'] as const) {
      expect(result).not.toContain(id);
    }
  });

  it('respects the rail order for the visible subset', () => {
    const result = railSurfaces(['terminal', 'git', 'context', 'editor']).map((s) => s.id);
    expect(result).toEqual(['terminal', 'git', 'context', 'editor']);
  });
});

describe('isRailSelectableSurface', () => {
  it('accepts a rail-visible surface', () => {
    expect(isRailSelectableSurface('git')).toBe(true);
  });

  it('rejects a registry-only surface', () => {
    expect(isRailSelectableSurface('pr')).toBe(false);
  });

  it('rejects a content-driven surface without content', () => {
    expect(isRailSelectableSurface('chat')).toBe(false);
    expect(isRailSelectableSurface('chat', { hasContent: () => true })).toBe(true);
  });
});

describe('firstAlwaysSurfaceId', () => {
  it('returns the first rail-visible surface as the header toggle fallback', () => {
    expect(firstAlwaysSurfaceId()).toBe('context');
    expect(firstAlwaysSurfaceId({ hasContent: () => true })).toBe('context');
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
