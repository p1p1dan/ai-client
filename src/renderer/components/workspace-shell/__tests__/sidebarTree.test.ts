import { describe, expect, it } from 'vitest';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import {
  buildSidebarFolders,
  chipForWorkspace,
  deriveRecentRows,
  formatRelativeAge,
  RECENT_DEFAULT_LIMIT,
  RECENT_WINDOW_MS,
  resolveNewSessionTarget,
  resolveNewSessionWorkspaceId,
} from '../sidebarTree';

const NOW = 1_800_000_000_000;

const projects: ChatProject[] = [
  { id: 'p-ai', name: 'ai-client' },
  { id: 'p-empty', name: 'newhp' },
];

const workspaces: ChatWorkspace[] = [
  { id: 'ws-main', projectId: 'p-ai', name: 'Main', kind: 'main', path: '/repo', branch: 'main' },
  {
    id: 'ws-wt',
    projectId: 'p-ai',
    name: 'feat/x',
    kind: 'worktree',
    path: '/repo-wt',
    branch: 'feat/x',
  },
  { id: 'ws-empty', projectId: 'p-empty', name: 'Main', kind: 'main', path: '/newhp' },
  { id: 'ws-temp', projectId: 'p-temp', name: 'Scratch', kind: 'temp', path: '/tmp/scratch' },
];

function session(overrides: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    projectId: 'p-ai',
    workspaceId: 'ws-main',
    title: `Session ${overrides.id}`,
    status: 'idle',
    updatedAt: NOW,
    ...overrides,
  };
}

describe('buildSidebarFolders', () => {
  it('merges sessions across worktrees of one project into the same folder node', () => {
    const folders = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [
        session({ id: 's-main', workspaceId: 'ws-main', updatedAt: NOW - 1000 }),
        session({ id: 's-wt', workspaceId: 'ws-wt', updatedAt: NOW }),
      ],
    });

    const aiFolder = folders.find((folder) => folder.projectId === 'p-ai');
    expect(aiFolder?.rows.map((row) => row.sessionId)).toEqual(['s-wt', 's-main']);
  });

  it('drops orphan sessions without crashing or fabricating folders', () => {
    const folders = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [
        session({ id: 's-orphan', workspaceId: 'ws-gone' }),
        // Workspace exists but points at an unregistered project: also orphan.
        session({ id: 's-temp', workspaceId: 'ws-temp' }),
      ],
    });

    expect(folders.map((folder) => folder.projectId)).toEqual(['p-ai', 'p-empty']);
    expect(folders.every((folder) => folder.rows.length === 0)).toBe(true);
  });

  it('filters by session title only — folder and branch names never match', () => {
    const folders = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [
        session({ id: 's-hit', title: 'refactor sidebar' }),
        // Title misses; its branch (feat/x) and folder (ai-client) must not hit.
        session({ id: 's-miss', title: 'other work', workspaceId: 'ws-wt' }),
      ],
      query: 'ai-client',
    });

    expect(folders.flatMap((folder) => folder.rows)).toEqual([]);

    const byTitle = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [
        session({ id: 's-hit', title: 'refactor sidebar' }),
        session({ id: 's-miss', title: 'other work', workspaceId: 'ws-wt' }),
      ],
      query: 'SIDEBAR',
    });
    expect(byTitle.flatMap((folder) => folder.rows.map((row) => row.sessionId))).toEqual(['s-hit']);
  });

  it('keeps empty folders visible with a usable new-session target', () => {
    const folders = buildSidebarFolders({ projects, workspaces, sessions: [] });
    const empty = folders.find((folder) => folder.projectId === 'p-empty');
    expect(empty).toBeDefined();
    expect(empty?.rows).toEqual([]);
    expect(empty?.newSessionWorkspaceId).toBe('ws-empty');
  });

  it('groups by the workspace project, not a stale session.projectId', () => {
    const folders = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [session({ id: 's-stale', projectId: 'p-empty', workspaceId: 'ws-main' })],
    });
    expect(folders.find((f) => f.projectId === 'p-ai')?.rows).toHaveLength(1);
    expect(folders.find((f) => f.projectId === 'p-empty')?.rows).toHaveLength(0);
  });
});

describe('chipForWorkspace', () => {
  it('shows the actual branch for main and worktree workspaces (main/master included)', () => {
    expect(chipForWorkspace(workspaces[0])).toEqual({ variant: 'branch', label: 'main' });
    expect(chipForWorkspace(workspaces[1])).toEqual({ variant: 'branch', label: 'feat/x' });
  });

  it('never guesses: unknown branch renders no chip', () => {
    expect(chipForWorkspace(workspaces[2])).toBeNull();
    expect(chipForWorkspace(undefined)).toBeNull();
  });

  it('shows the kind label for temp and remote workspaces', () => {
    expect(chipForWorkspace(workspaces[3])).toEqual({ variant: 'kind', label: 'temp' });
    expect(
      chipForWorkspace({
        id: 'ws-r',
        projectId: 'p-r',
        name: 'srv',
        kind: 'remote',
        path: '/srv',
      })
    ).toEqual({ variant: 'kind', label: 'remote' });
  });
});

describe('resolveNewSessionWorkspaceId', () => {
  it('prefers the main workspace, skipping unusable empty-path seeds', () => {
    const seeded: ChatWorkspace[] = [
      { id: 'ws-seed', projectId: 'p-x', name: 'Main', kind: 'main', path: '' },
      { id: 'ws-real', projectId: 'p-x', name: 'feat/y', kind: 'worktree', path: '/wt' },
    ];
    expect(resolveNewSessionWorkspaceId('p-x', seeded)).toBe('ws-real');
    expect(resolveNewSessionWorkspaceId('p-x', workspaces)).toBeNull();
    expect(resolveNewSessionWorkspaceId('p-ai', workspaces)).toBe('ws-main');
  });
});

describe('resolveNewSessionTarget', () => {
  const folders = buildSidebarFolders({ projects, workspaces, sessions: [] });

  it('prefers the focused folder over the active session', () => {
    const target = resolveNewSessionTarget({
      focusedProjectId: 'p-empty',
      folders,
      activeSession: { workspaceId: 'ws-main' },
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-empty', folderName: 'newhp' });
  });

  it('falls back to the active session workspace when nothing is focused', () => {
    const target = resolveNewSessionTarget({
      focusedProjectId: null,
      folders,
      activeSession: { workspaceId: 'ws-wt' },
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-wt', folderName: 'ai-client' });
  });

  it('falls back to the first usable workspace when both focus and active session are absent', () => {
    const target = resolveNewSessionTarget({
      focusedProjectId: null,
      folders,
      activeSession: undefined,
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-main', folderName: 'ai-client' });
  });

  it('self-heals when the focused folder was deleted, falling through to the next tier', () => {
    const target = resolveNewSessionTarget({
      focusedProjectId: 'p-deleted',
      folders,
      activeSession: { workspaceId: 'ws-wt' },
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-wt', folderName: 'ai-client' });
  });

  // R5 round-2 (B1): every fallback target must still be reachable in the nav.
  it('skips an active session whose workspace no longer exists', () => {
    const target = resolveNewSessionTarget({
      focusedProjectId: null,
      folders,
      activeSession: { workspaceId: 'ws-deleted' },
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-main', folderName: 'ai-client' });
  });

  it('skips an active session whose project has no folder row (orphan workspace)', () => {
    // `ws-temp` belongs to `p-temp`, which is not in `projects` — creating a
    // chat there would land in a folder the sidebar never renders.
    const target = resolveNewSessionTarget({
      focusedProjectId: null,
      folders,
      activeSession: { workspaceId: 'ws-temp' },
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-main', folderName: 'ai-client' });
  });

  it('disables the button (null target) when the focused folder has no usable workspace', () => {
    const seedProjects: ChatProject[] = [...projects, { id: 'p-seed', name: 'seed-repo' }];
    const seedWorkspaces: ChatWorkspace[] = [
      ...workspaces,
      { id: 'ws-seed', projectId: 'p-seed', name: 'Main', kind: 'main', path: '' },
    ];
    const seedFolders = buildSidebarFolders({
      projects: seedProjects,
      workspaces: seedWorkspaces,
      sessions: [],
    });

    const target = resolveNewSessionTarget({
      focusedProjectId: 'p-seed',
      folders: seedFolders,
      activeSession: { workspaceId: 'ws-main' },
      workspaces: seedWorkspaces,
    });

    // Falling through to `ws-main` would create the chat in a different folder
    // than the button's own title names — a silent redirect (D1).
    expect(target).toEqual({ workspaceId: null, folderName: 'seed-repo' });
  });

  it('skips orphan workspaces in the last-resort scan instead of taking the first one', () => {
    const orphanFirst: ChatWorkspace[] = [
      { id: 'ws-temp', projectId: 'p-temp', name: 'Scratch', kind: 'temp', path: '/tmp/scratch' },
      ...workspaces.filter((ws) => ws.id !== 'ws-temp'),
    ];

    const target = resolveNewSessionTarget({
      focusedProjectId: null,
      folders,
      activeSession: undefined,
      workspaces: orphanFirst,
    });

    expect(target).toEqual({ workspaceId: 'ws-main', folderName: 'ai-client' });
  });
});

describe('deriveRecentRows', () => {
  it('keeps busy sessions and sessions touched within 48h, newest first', () => {
    const { rows } = deriveRecentRows({
      sessions: [
        session({ id: 's-old-busy', status: 'running', updatedAt: NOW - RECENT_WINDOW_MS * 2 }),
        session({ id: 's-fresh', updatedAt: NOW - 1000 }),
        session({ id: 's-stale', updatedAt: NOW - RECENT_WINDOW_MS - 1 }),
      ],
      workspaces,
      now: NOW,
    });
    expect(rows.map((row) => row.sessionId)).toEqual(['s-fresh', 's-old-busy']);
    expect(rows[1]?.busy).toBe(true);
  });

  it('caps at 7 with a hidden count until showAll', () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      session({ id: `s-${i}`, updatedAt: NOW - i })
    );
    const capped = deriveRecentRows({ sessions, workspaces, now: NOW });
    expect(capped.rows).toHaveLength(RECENT_DEFAULT_LIMIT);
    expect(capped.hiddenCount).toBe(3);

    const all = deriveRecentRows({ sessions, workspaces, now: NOW, showAll: true });
    expect(all.rows).toHaveLength(10);
    expect(all.hiddenCount).toBe(0);
  });

  it('excludes orphan sessions like the folder tree does', () => {
    const { rows } = deriveRecentRows({
      sessions: [session({ id: 's-orphan', workspaceId: 'ws-gone' })],
      workspaces,
      now: NOW,
    });
    expect(rows).toEqual([]);
  });
});

describe('formatRelativeAge', () => {
  it('formats compact ages per range', () => {
    expect(formatRelativeAge(NOW - 5_000, NOW)).toBe('now');
    expect(formatRelativeAge(NOW + 5_000, NOW)).toBe('now');
    expect(formatRelativeAge(NOW - 90_000, NOW)).toBe('1m');
    expect(formatRelativeAge(NOW - 3 * 60 * 60_000, NOW)).toBe('3h');
    expect(formatRelativeAge(NOW - 5 * 24 * 60 * 60_000, NOW)).toBe('5d');
    expect(formatRelativeAge(NOW - 2 * 7 * 24 * 60 * 60_000, NOW)).toBe('2w');
    expect(formatRelativeAge(NOW - 3 * 30 * 24 * 60 * 60_000, NOW)).toBe('3mo');
    expect(formatRelativeAge(NOW - 2 * 365 * 24 * 60 * 60_000, NOW)).toBe('2y');
  });
});
