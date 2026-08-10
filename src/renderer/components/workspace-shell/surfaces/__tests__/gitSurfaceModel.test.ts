import type { FileChange, FileChangesResult } from '@shared/types';
import { describe, expect, it } from 'vitest';
import {
  deriveGitSurfacePresentation,
  type GitSurfaceSelection,
  type GitSurfaceViewState,
  initialGitSurfaceViewState,
  partitionFileChanges,
  reduceGitSurfaceView,
  resolveGitWorkdir,
} from '../gitSurfaceModel';

function change(overrides: Partial<FileChange> & Pick<FileChange, 'path' | 'staged'>): FileChange {
  return { status: 'M', ...overrides };
}

describe('partitionFileChanges', () => {
  it('splits changes into staged and unstaged groups', () => {
    const result: FileChangesResult = {
      changes: [
        change({ path: 'a.ts', staged: true }),
        change({ path: 'b.ts', staged: false }),
        change({ path: 'c.ts', staged: true }),
      ],
    };
    const partitioned = partitionFileChanges(result);
    expect(partitioned.staged.map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
    expect(partitioned.unstaged.map((f) => f.path)).toEqual(['b.ts']);
  });

  it('passes rename originalPath through untouched', () => {
    const result: FileChangesResult = {
      changes: [
        change({ path: 'new-name.ts', staged: true, status: 'R', originalPath: 'old-name.ts' }),
      ],
    };
    const partitioned = partitionFileChanges(result);
    expect(partitioned.staged[0].originalPath).toBe('old-name.ts');
  });

  it('passes truncated / truncatedLimit through', () => {
    const result: FileChangesResult = {
      changes: [],
      truncated: true,
      truncatedLimit: 500,
    };
    const partitioned = partitionFileChanges(result);
    expect(partitioned.truncated).toBe(true);
    expect(partitioned.truncatedLimit).toBe(500);
  });

  it('defaults truncated to false when absent', () => {
    const partitioned = partitionFileChanges({ changes: [] });
    expect(partitioned.truncated).toBe(false);
    expect(partitioned.truncatedLimit).toBeUndefined();
  });

  it('returns both groups empty for undefined input', () => {
    const partitioned = partitionFileChanges(undefined);
    expect(partitioned.staged).toEqual([]);
    expect(partitioned.unstaged).toEqual([]);
    expect(partitioned.truncated).toBe(false);
  });

  it('returns both groups empty for null input', () => {
    const partitioned = partitionFileChanges(null);
    expect(partitioned.staged).toEqual([]);
    expect(partitioned.unstaged).toEqual([]);
  });
});

describe('reduceGitSurfaceView', () => {
  const file: GitSurfaceSelection = { path: 'a.ts', staged: false };
  const selectedState: GitSurfaceViewState = { selection: file };

  it('starts on the list (no selection)', () => {
    expect(initialGitSurfaceViewState).toEqual({ selection: null });
  });

  it('select sets the selection (pushes into diff)', () => {
    const next = reduceGitSurfaceView(initialGitSurfaceViewState, { type: 'select', file });
    expect(next).toEqual({ selection: file });
  });

  it('select replaces a prior selection', () => {
    const other: GitSurfaceSelection = { path: 'b.ts', staged: true };
    const next = reduceGitSurfaceView(selectedState, { type: 'select', file: other });
    expect(next).toEqual({ selection: other });
  });

  it('back clears the selection (returns to list)', () => {
    const next = reduceGitSurfaceView(selectedState, { type: 'back' });
    expect(next).toEqual({ selection: null });
  });

  it('workdir-changed clears the selection', () => {
    const next = reduceGitSurfaceView(selectedState, { type: 'workdir-changed' });
    expect(next).toEqual({ selection: null });
  });

  it('selection-gone clears the selection', () => {
    const next = reduceGitSurfaceView(selectedState, { type: 'selection-gone' });
    expect(next).toEqual({ selection: null });
  });

  it('back / workdir-changed / selection-gone are no-ops on an already-empty list state', () => {
    for (const type of ['back', 'workdir-changed', 'selection-gone'] as const) {
      expect(reduceGitSurfaceView(initialGitSurfaceViewState, { type })).toEqual({
        selection: null,
      });
    }
  });
});

describe('deriveGitSurfacePresentation', () => {
  const file: GitSurfaceSelection = { path: 'a.ts', staged: false };

  it('shows changes (list) when not expanded and nothing is selected', () => {
    expect(deriveGitSurfacePresentation({ expanded: false, selection: null })).toBe('changes');
  });

  it('shows diff when not expanded and a file is selected', () => {
    expect(deriveGitSurfacePresentation({ expanded: false, selection: file })).toBe('diff');
  });

  it('shows split when expanded, regardless of selection', () => {
    expect(deriveGitSurfacePresentation({ expanded: true, selection: null })).toBe('split');
    expect(deriveGitSurfacePresentation({ expanded: true, selection: file })).toBe('split');
  });
});

describe('resolveGitWorkdir', () => {
  it('resolves the workdir for a git-enabled workspace', () => {
    const resolution = resolveGitWorkdir({
      activeSessionId: 's1',
      sessions: [{ id: 's1', workspaceId: 'w1' }],
      workspaces: [{ id: 'w1', path: '/repo', gitEnabled: true }],
    });
    expect(resolution).toEqual({ workdir: '/repo' });
  });

  it('reports no-session when there is no active session', () => {
    const resolution = resolveGitWorkdir({
      activeSessionId: null,
      sessions: [],
      workspaces: [],
    });
    expect(resolution).toEqual({ reason: 'no-session' });
  });

  it('reports no-session when the active session id does not resolve', () => {
    const resolution = resolveGitWorkdir({
      activeSessionId: 'missing',
      sessions: [{ id: 's1', workspaceId: 'w1' }],
      workspaces: [{ id: 'w1', path: '/repo', gitEnabled: true }],
    });
    expect(resolution).toEqual({ reason: 'no-session' });
  });

  it('reports no-path when the workspace cannot be found', () => {
    const resolution = resolveGitWorkdir({
      activeSessionId: 's1',
      sessions: [{ id: 's1', workspaceId: 'missing' }],
      workspaces: [{ id: 'w1', path: '/repo', gitEnabled: true }],
    });
    expect(resolution).toEqual({ reason: 'no-path' });
  });

  it('reports no-path when the workspace path is empty', () => {
    const resolution = resolveGitWorkdir({
      activeSessionId: 's1',
      sessions: [{ id: 's1', workspaceId: 'w1' }],
      workspaces: [{ id: 'w1', path: '', gitEnabled: true }],
    });
    expect(resolution).toEqual({ reason: 'no-path' });
  });

  it('reports not-git when gitEnabled is false', () => {
    const resolution = resolveGitWorkdir({
      activeSessionId: 's1',
      sessions: [{ id: 's1', workspaceId: 'w1' }],
      workspaces: [{ id: 'w1', path: '/repo', gitEnabled: false }],
    });
    expect(resolution).toEqual({ reason: 'not-git', judgedPath: '/repo' });
  });

  it('reports not-git when gitEnabled is undefined (unknown/loading, not assumed yes)', () => {
    const resolution = resolveGitWorkdir({
      activeSessionId: 's1',
      sessions: [{ id: 's1', workspaceId: 'w1' }],
      workspaces: [{ id: 'w1', path: '/repo' }],
    });
    expect(resolution).toEqual({ reason: 'not-git', judgedPath: '/repo' });
  });

  // The not-git verdict has to name the directory it was reached on. Without
  // it the field could only infer WHICH folder the panel judged from unrelated
  // evidence (an EPERM in a log), which is how a temp-workspace misreport was
  // mistaken for a repo misreport.
  it('names the judged directory on not-git, even when several workspaces exist', () => {
    const resolution = resolveGitWorkdir({
      activeSessionId: 's2',
      sessions: [
        { id: 's1', workspaceId: 'w1' },
        { id: 's2', workspaceId: 'w2' },
      ],
      workspaces: [
        { id: 'w1', path: 'D:/other', gitEnabled: true },
        { id: 'w2', path: 'E:\\C1Algorithm', gitEnabled: false },
      ],
    });
    expect(resolution).toEqual({ reason: 'not-git', judgedPath: 'E:\\C1Algorithm' });
  });

  it('has no judged path to name when no session resolves', () => {
    const resolution = resolveGitWorkdir({ activeSessionId: null, sessions: [], workspaces: [] });
    expect('judgedPath' in resolution).toBe(false);
  });
});
