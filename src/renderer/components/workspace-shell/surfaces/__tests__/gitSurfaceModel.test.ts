import type { FileChange, FileChangesResult } from '@shared/types';
import { describe, expect, it } from 'vitest';
import {
  deriveGitSurfacePresentation,
  formatCommitTooltip,
  type GitSurfaceSelection,
  type GitSurfaceViewState,
  initialGitSurfaceViewState,
  parseRefBadges,
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
  const selectedState: GitSurfaceViewState = { selection: file, historyExpanded: true };

  it('starts on the list (no selection), history expanded', () => {
    expect(initialGitSurfaceViewState).toEqual({ selection: null, historyExpanded: true });
  });

  it('select sets the selection (pushes into diff)', () => {
    const next = reduceGitSurfaceView(initialGitSurfaceViewState, { type: 'select', file });
    expect(next).toEqual({ selection: file, historyExpanded: true });
  });

  it('select replaces a prior selection', () => {
    const other: GitSurfaceSelection = { path: 'b.ts', staged: true };
    const next = reduceGitSurfaceView(selectedState, { type: 'select', file: other });
    expect(next).toEqual({ selection: other, historyExpanded: true });
  });

  it('back clears the selection (returns to list)', () => {
    const next = reduceGitSurfaceView(selectedState, { type: 'back' });
    expect(next).toEqual({ selection: null, historyExpanded: true });
  });

  it('workdir-changed clears the selection', () => {
    const next = reduceGitSurfaceView(selectedState, { type: 'workdir-changed' });
    expect(next).toEqual({ selection: null, historyExpanded: true });
  });

  it('selection-gone clears the selection', () => {
    const next = reduceGitSurfaceView(selectedState, { type: 'selection-gone' });
    expect(next).toEqual({ selection: null, historyExpanded: true });
  });

  it('back / workdir-changed / selection-gone are no-ops on an already-empty list state', () => {
    for (const type of ['back', 'workdir-changed', 'selection-gone'] as const) {
      expect(reduceGitSurfaceView(initialGitSurfaceViewState, { type })).toEqual({
        selection: null,
        historyExpanded: true,
      });
    }
  });

  // D30(a): the History section's collapse state, orthogonal to `selection`.
  it('toggle-history flips historyExpanded from true to false', () => {
    const next = reduceGitSurfaceView(initialGitSurfaceViewState, { type: 'toggle-history' });
    expect(next).toEqual({ selection: null, historyExpanded: false });
  });

  it('toggle-history flips historyExpanded from false back to true', () => {
    const collapsed: GitSurfaceViewState = { selection: null, historyExpanded: false };
    const next = reduceGitSurfaceView(collapsed, { type: 'toggle-history' });
    expect(next).toEqual({ selection: null, historyExpanded: true });
  });

  it('toggle-history leaves an active selection untouched', () => {
    const next = reduceGitSurfaceView(selectedState, { type: 'toggle-history' });
    expect(next).toEqual({ selection: file, historyExpanded: false });
  });

  it('select / back / workdir-changed / selection-gone leave historyExpanded untouched when collapsed', () => {
    const collapsedWithSelection: GitSurfaceViewState = { selection: file, historyExpanded: false };
    expect(reduceGitSurfaceView(collapsedWithSelection, { type: 'back' })).toEqual({
      selection: null,
      historyExpanded: false,
    });
    expect(
      reduceGitSurfaceView(collapsedWithSelection, {
        type: 'select',
        file: { path: 'b.ts', staged: true },
      })
    ).toEqual({ selection: { path: 'b.ts', staged: true }, historyExpanded: false });
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

describe('parseRefBadges', () => {
  it('returns an empty array for undefined', () => {
    expect(parseRefBadges(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseRefBadges('')).toEqual([]);
  });

  // Real shape: `gitLogFormat.ts` already strips a leading "HEAD -> " before
  // this reaches the renderer.
  it('splits a plain refs string into badge labels', () => {
    expect(parseRefBadges('main, origin/main')).toEqual(['main', 'origin/main']);
  });

  it('strips a leftover "HEAD -> " prefix defensively', () => {
    expect(parseRefBadges('HEAD -> main, origin/main')).toEqual(['main', 'origin/main']);
  });

  it('strips the "tag: " prefix from annotated tag refs', () => {
    expect(parseRefBadges('main, origin/main, tag: v1')).toEqual(['main', 'origin/main', 'v1']);
  });

  it('handles a single ref with no comma', () => {
    expect(parseRefBadges('main')).toEqual(['main']);
  });
});

describe('formatCommitTooltip', () => {
  it('joins an 8-char short hash, the author, and the date with middle dots', () => {
    expect(
      formatCommitTooltip({
        hash: '0123456789abcdef',
        author_name: 'Ada Lovelace',
        date: '2026-08-11',
      })
    ).toBe('01234567 · Ada Lovelace · 2026-08-11');
  });

  it('does not truncate a hash already shorter than 8 chars', () => {
    expect(formatCommitTooltip({ hash: 'abc', author_name: 'A', date: '2026-01-01' })).toBe(
      'abc · A · 2026-01-01'
    );
  });
});
