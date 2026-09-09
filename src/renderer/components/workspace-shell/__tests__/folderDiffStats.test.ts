import { describe, expect, it } from 'vitest';
import {
  collectBusyWorkspacePaths,
  sumFolderDiffTotals,
  withRecentlyBusy,
} from '../folderDiffStats';
import type { SidebarFolder, SidebarSessionRow } from '../sidebarTree';

function row(overrides: Partial<SidebarSessionRow> & { workspaceId: string }): SidebarSessionRow {
  return {
    sessionId: `s-${overrides.workspaceId}`,
    title: 'chat',
    chip: null,
    updatedAt: 0,
    busy: false,
    failed: false,
    status: 'idle',
    ...overrides,
  } as SidebarSessionRow;
}

function folder(projectId: string, rows: SidebarSessionRow[]): SidebarFolder {
  return { projectId, name: projectId, rows, newSessionWorkspaceId: null };
}

const workspaces = [
  { id: 'w1', projectId: 'p1', name: 'main', kind: 'local' as const, path: '/repo/a' },
  { id: 'w2', projectId: 'p1', name: 'feat', kind: 'local' as const, path: '/repo/a-feat' },
  { id: 'w3', projectId: 'p2', name: 'main', kind: 'local' as const, path: '/repo/b' },
  // The seeded placeholder a fresh install starts on: a real workspace row with
  // no directory behind it.
  { id: 'w4', projectId: 'p3', name: 'seed', kind: 'local' as const, path: '' },
];

describe('collectBusyWorkspacePaths', () => {
  it('returns only the paths of workspaces that have a busy session', () => {
    const folders = [
      folder('p1', [row({ workspaceId: 'w1', busy: true }), row({ workspaceId: 'w2' })]),
      folder('p2', [row({ workspaceId: 'w3' })]),
    ];

    expect(collectBusyWorkspacePaths(folders, workspaces)).toEqual(['/repo/a']);
  });

  it('deduplicates when several busy sessions share one workspace', () => {
    const folders = [
      folder('p1', [
        row({ sessionId: 's-1', workspaceId: 'w1', busy: true }),
        row({ sessionId: 's-2', workspaceId: 'w1', busy: true }),
      ]),
    ];

    expect(collectBusyWorkspacePaths(folders, workspaces)).toEqual(['/repo/a']);
  });

  it('skips rows whose workspace has no directory behind it', () => {
    // An empty path would become `git diff` in whatever the process cwd happens
    // to be — the one case where guessing produces a plausible-looking number
    // for the wrong directory.
    const folders = [folder('p3', [row({ workspaceId: 'w4', busy: true })])];

    expect(collectBusyWorkspacePaths(folders, workspaces)).toEqual([]);
  });

  it('skips rows pointing at a workspace that no longer exists', () => {
    const folders = [folder('p1', [row({ workspaceId: 'gone', busy: true })])];

    expect(collectBusyWorkspacePaths(folders, workspaces)).toEqual([]);
  });

  it('returns nothing when no session is running', () => {
    const folders = [folder('p1', [row({ workspaceId: 'w1' })])];

    expect(collectBusyWorkspacePaths(folders, workspaces)).toEqual([]);
  });
});

describe('sumFolderDiffTotals', () => {
  const target = folder('p1', []);

  it('sums every measured workspace under the folder', () => {
    const stats = {
      '/repo/a': { insertions: 10, deletions: 4 },
      '/repo/a-feat': { insertions: 5, deletions: 1 },
      // Belongs to another project and must not leak into p1's total.
      '/repo/b': { insertions: 900, deletions: 900 },
    };

    expect(sumFolderDiffTotals(target, workspaces, stats)).toEqual({
      insertions: 15,
      deletions: 5,
    });
  });

  it('ignores workspaces that have not been measured yet', () => {
    const stats = { '/repo/a': { insertions: 3, deletions: 2 } };

    expect(sumFolderDiffTotals(target, workspaces, stats)).toEqual({
      insertions: 3,
      deletions: 2,
    });
  });

  it('returns null when nothing has been measured', () => {
    expect(sumFolderDiffTotals(target, workspaces, {})).toBeNull();
  });

  it('returns null for a clean folder rather than a permanent "+0 -0" column', () => {
    const stats = {
      '/repo/a': { insertions: 0, deletions: 0 },
      '/repo/a-feat': { insertions: 0, deletions: 0 },
    };

    expect(sumFolderDiffTotals(target, workspaces, stats)).toBeNull();
  });

  it('keeps a folder with only deletions visible', () => {
    const stats = { '/repo/a': { insertions: 0, deletions: 7 } };

    expect(sumFolderDiffTotals(target, workspaces, stats)).toEqual({
      insertions: 0,
      deletions: 7,
    });
  });
});

describe('withRecentlyBusy', () => {
  it('includes paths that just went idle so they get one final reading', () => {
    expect(withRecentlyBusy(['/repo/a'], ['/repo/b'])).toEqual(['/repo/a', '/repo/b']);
  });

  it('does not repeat a path that is busy in both passes', () => {
    expect(withRecentlyBusy(['/repo/a'], ['/repo/a'])).toEqual(['/repo/a']);
  });

  it('still fetches the last busy path after everything goes idle', () => {
    expect(withRecentlyBusy([], ['/repo/a'])).toEqual(['/repo/a']);
  });

  it('is empty when nothing is or was running', () => {
    expect(withRecentlyBusy([], [])).toEqual([]);
  });
});
