import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileChange, FileChangesResult } from '@shared/types';
import { describe, expect, it } from 'vitest';
import {
  deriveGitSurfacePresentation,
  formatCommitTooltip,
  type GitSurfaceCommitFile,
  type GitSurfaceSelection,
  type GitSurfaceViewState,
  gitHistoryPanelClass,
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
  const selectedState: GitSurfaceViewState = {
    selection: file,
    historyExpanded: true,
    expandedCommitHash: null,
    selectedCommitFile: null,
  };

  it('starts on the list (no selection), history expanded, no commit expanded/selected', () => {
    expect(initialGitSurfaceViewState).toEqual({
      selection: null,
      historyExpanded: true,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
  });

  it('select sets the selection (pushes into diff)', () => {
    const next = reduceGitSurfaceView(initialGitSurfaceViewState, { type: 'select', file });
    expect(next).toEqual({
      selection: file,
      historyExpanded: true,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
  });

  it('select replaces a prior selection', () => {
    const other: GitSurfaceSelection = { path: 'b.ts', staged: true };
    const next = reduceGitSurfaceView(selectedState, { type: 'select', file: other });
    expect(next).toEqual({
      selection: other,
      historyExpanded: true,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
  });

  it('workdir-changed clears the selection', () => {
    const next = reduceGitSurfaceView(selectedState, { type: 'workdir-changed' });
    expect(next).toEqual({
      selection: null,
      historyExpanded: true,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
  });

  it('selection-gone clears the selection', () => {
    const next = reduceGitSurfaceView(selectedState, { type: 'selection-gone' });
    expect(next).toEqual({
      selection: null,
      historyExpanded: true,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
  });

  it('workdir-changed / selection-gone are no-ops on an already-empty list state', () => {
    for (const type of ['workdir-changed', 'selection-gone'] as const) {
      expect(reduceGitSurfaceView(initialGitSurfaceViewState, { type })).toEqual({
        selection: null,
        historyExpanded: true,
        expandedCommitHash: null,
        selectedCommitFile: null,
      });
    }
  });

  // D30(a): the History section's collapse state, orthogonal to `selection`.
  it('toggle-history flips historyExpanded from true to false', () => {
    const next = reduceGitSurfaceView(initialGitSurfaceViewState, { type: 'toggle-history' });
    expect(next).toEqual({
      selection: null,
      historyExpanded: false,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
  });

  it('toggle-history flips historyExpanded from false back to true', () => {
    const collapsed: GitSurfaceViewState = {
      selection: null,
      historyExpanded: false,
      expandedCommitHash: null,
      selectedCommitFile: null,
    };
    const next = reduceGitSurfaceView(collapsed, { type: 'toggle-history' });
    expect(next).toEqual({
      selection: null,
      historyExpanded: true,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
  });

  it('toggle-history leaves an active selection untouched', () => {
    const next = reduceGitSurfaceView(selectedState, { type: 'toggle-history' });
    expect(next).toEqual({
      selection: file,
      historyExpanded: false,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
  });

  it('select / workdir-changed / selection-gone leave historyExpanded untouched when collapsed', () => {
    const collapsedWithSelection: GitSurfaceViewState = {
      selection: file,
      historyExpanded: false,
      expandedCommitHash: null,
      selectedCommitFile: null,
    };
    expect(reduceGitSurfaceView(collapsedWithSelection, { type: 'workdir-changed' })).toEqual({
      selection: null,
      historyExpanded: false,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
    expect(
      reduceGitSurfaceView(collapsedWithSelection, {
        type: 'select',
        file: { path: 'b.ts', staged: true },
      })
    ).toEqual({
      selection: { path: 'b.ts', staged: true },
      historyExpanded: false,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
    expect(reduceGitSurfaceView(collapsedWithSelection, { type: 'selection-gone' })).toEqual({
      selection: null,
      historyExpanded: false,
      expandedCommitHash: null,
      selectedCommitFile: null,
    });
  });

  // D34: click-to-expand a History row + per-commit file selection.
  describe('D34 commit row expand / file select', () => {
    const commitFile: GitSurfaceCommitFile = { hash: 'abc123', path: 'src/a.ts', status: 'M' };

    it('toggle-commit expands a row from the empty state', () => {
      const next = reduceGitSurfaceView(initialGitSurfaceViewState, {
        type: 'toggle-commit',
        hash: 'abc123',
      });
      expect(next).toEqual({
        selection: null,
        historyExpanded: true,
        expandedCommitHash: 'abc123',
        selectedCommitFile: null,
      });
    });

    it('toggle-commit on the same hash again collapses it and clears selectedCommitFile', () => {
      const expandedWithFile: GitSurfaceViewState = {
        selection: null,
        historyExpanded: true,
        expandedCommitHash: 'abc123',
        selectedCommitFile: commitFile,
      };
      const next = reduceGitSurfaceView(expandedWithFile, {
        type: 'toggle-commit',
        hash: 'abc123',
      });
      expect(next).toEqual({
        selection: null,
        historyExpanded: true,
        expandedCommitHash: null,
        selectedCommitFile: null,
      });
    });

    it('toggle-commit on a different hash replaces the expansion and clears selectedCommitFile', () => {
      const expandedWithFile: GitSurfaceViewState = {
        selection: null,
        historyExpanded: true,
        expandedCommitHash: 'abc123',
        selectedCommitFile: commitFile,
      };
      const next = reduceGitSurfaceView(expandedWithFile, {
        type: 'toggle-commit',
        hash: 'def456',
      });
      expect(next).toEqual({
        selection: null,
        historyExpanded: true,
        expandedCommitHash: 'def456',
        selectedCommitFile: null,
      });
    });

    it('select-commit-file sets selectedCommitFile, leaving expandedCommitHash untouched', () => {
      const expanded: GitSurfaceViewState = {
        selection: null,
        historyExpanded: true,
        expandedCommitHash: 'abc123',
        selectedCommitFile: null,
      };
      const next = reduceGitSurfaceView(expanded, { type: 'select-commit-file', file: commitFile });
      expect(next).toEqual({
        selection: null,
        historyExpanded: true,
        expandedCommitHash: 'abc123',
        selectedCommitFile: commitFile,
      });
    });

    it('select-commit-file replaces a prior commit file selection', () => {
      const withFile: GitSurfaceViewState = {
        selection: null,
        historyExpanded: true,
        expandedCommitHash: 'abc123',
        selectedCommitFile: commitFile,
      };
      const other: GitSurfaceCommitFile = { hash: 'abc123', path: 'src/b.ts', status: 'A' };
      const next = reduceGitSurfaceView(withFile, { type: 'select-commit-file', file: other });
      expect(next).toEqual({
        selection: null,
        historyExpanded: true,
        expandedCommitHash: 'abc123',
        selectedCommitFile: other,
      });
    });

    // workdir-changed (repo switch) clears both — a hash/file from the old
    // repo is meaningless once the workdir points somewhere else.
    it('workdir-changed clears both expandedCommitHash and selectedCommitFile', () => {
      const withFile: GitSurfaceViewState = {
        selection: file,
        historyExpanded: true,
        expandedCommitHash: 'abc123',
        selectedCommitFile: commitFile,
      };
      const next = reduceGitSurfaceView(withFile, { type: 'workdir-changed' });
      expect(next).toEqual({
        selection: null,
        historyExpanded: true,
        expandedCommitHash: null,
        selectedCommitFile: null,
      });
    });
  });
});

// D34-E: collapsed from a 3-way (changes/diff/split) to a 2-way signature —
// a file click no longer changes which pane shape the docked panel shows
// (it opens a center tab instead), so `selection` dropped out of the input
// entirely. Mutation check: reintroducing a `selection`-driven 'diff' return
// here (the pre-D34-E in-panel push-navigation shape) must turn this red.
describe('deriveGitSurfacePresentation', () => {
  it('shows changes (list) when not expanded', () => {
    expect(deriveGitSurfacePresentation({ expanded: false })).toBe('changes');
  });

  it('shows split when expanded', () => {
    expect(deriveGitSurfacePresentation({ expanded: true })).toBe('split');
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

// D34 static invariants: docked git surface splits 50/50 between the changes
// half and the History half, and History fills its share instead of capping.
// Mutation check: reverting gitHistoryPanelClass() to the pre-D34 `max-h-60`
// cap (or dropping `flex-1`) must turn these red.
describe('gitHistoryPanelClass (D34 half-split)', () => {
  it('lets History fill its half: flex-1 present, no max-height cap', () => {
    const cls = gitHistoryPanelClass();
    expect(cls).toContain('flex-1');
    expect(cls).toContain('min-h-0');
    expect(cls).not.toMatch(/max-h-\d/);
  });

  it('GitSurfaceView gives BOTH halves flex-1 (50/50 split, History non-collapsing)', () => {
    const src = readFileSync(join(__dirname, '..', 'GitSurfaceView.tsx'), 'utf8');
    const changesHalf = src.match(/<div className="flex min-h-0 flex-1 flex-col">/);
    const historyHalf = src.match(/<div className="flex min-h-0 flex-1 flex-col border-t">/);
    expect(changesHalf).not.toBeNull();
    expect(historyHalf).not.toBeNull();
  });
});
