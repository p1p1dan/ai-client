import { describe, expect, it } from 'vitest';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import {
  buildBranchMenu,
  buildFolderMenu,
  decideTargetChange,
  isTargetableWorkspace,
  matchWorkspaceByPath,
  planTargetChange,
  resolveActiveTarget,
  resolveRuntimeRepoPath,
  resolveSendCwd,
  runLocationLabel,
  shouldShowBranchSelect,
  targetWorktreeLabel,
} from '../composerTarget';

function makeWorkspace(overrides: Partial<ChatWorkspace> = {}): ChatWorkspace {
  return {
    id: 'ws-1',
    projectId: 'project-1',
    name: 'Main',
    kind: 'main',
    path: '/repo',
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    workspaceId: 'ws-1',
    title: 'Session',
    status: 'idle',
    updatedAt: 0,
    ...overrides,
  };
}

function makeProject(overrides: Partial<ChatProject> = {}): ChatProject {
  return { id: 'project-1', name: 'Project 1', ...overrides };
}

describe('decideTargetChange', () => {
  it('blocks while a send is in flight even when status is idle', () => {
    expect(
      decideTargetChange({ status: 'idle', messageCount: 0, hostBound: false, sending: true })
    ).toBe('blocked');
  });

  it('blocks for starting / running / stopping / waiting_permission / waiting_question', () => {
    const statuses = [
      'starting',
      'running',
      'stopping',
      'waiting_permission',
      'waiting_question',
    ] as const;
    for (const status of statuses) {
      expect(decideTargetChange({ status, messageCount: 0, hostBound: false })).toBe('blocked');
    }
  });

  it('retargets an empty, never-host-bound session', () => {
    expect(decideTargetChange({ status: 'idle', messageCount: 0, hostBound: false })).toBe(
      'retarget'
    );
  });

  it('forks when the session already has messages', () => {
    expect(decideTargetChange({ status: 'idle', messageCount: 3, hostBound: false })).toBe('fork');
  });

  it('forks when the session is host-bound even with zero messages', () => {
    expect(decideTargetChange({ status: 'idle', messageCount: 0, hostBound: true })).toBe('fork');
  });

  it('treats undefined status as idle', () => {
    expect(decideTargetChange({ status: undefined, messageCount: 0, hostBound: false })).toBe(
      'retarget'
    );
  });

  it('does not block for idle / failed', () => {
    expect(decideTargetChange({ status: 'idle', messageCount: 0, hostBound: false })).not.toBe(
      'blocked'
    );
    expect(decideTargetChange({ status: 'failed', messageCount: 0, hostBound: false })).not.toBe(
      'blocked'
    );
  });
});

describe('planTargetChange', () => {
  it('noops with unknown-workspace when the id is absent', () => {
    const workspaces = [makeWorkspace({ id: 'ws-a', path: '/a' })];
    const plan = planTargetChange({
      nextWorkspaceId: 'ws-missing',
      activeSession: undefined,
      workspaces,
      messageCount: 0,
      hostBound: false,
    });
    expect(plan).toEqual({ kind: 'noop', reason: 'unknown-workspace' });
  });

  it('noops with unknown-workspace when the target path is empty (DEMO seed)', () => {
    const workspaces = [makeWorkspace({ id: 'ws-seed', path: '' })];
    const plan = planTargetChange({
      nextWorkspaceId: 'ws-seed',
      activeSession: undefined,
      workspaces,
      messageCount: 0,
      hostBound: false,
    });
    expect(plan).toEqual({ kind: 'noop', reason: 'unknown-workspace' });
  });

  it('noops with same-workspace when the target equals the current one', () => {
    const workspaces = [makeWorkspace({ id: 'ws-a', path: '/a' })];
    const activeSession = { id: 's1', workspaceId: 'ws-a', status: 'idle' as const };
    const plan = planTargetChange({
      nextWorkspaceId: 'ws-a',
      activeSession,
      workspaces,
      messageCount: 0,
      hostBound: false,
    });
    expect(plan).toEqual({ kind: 'noop', reason: 'same-workspace' });
  });

  it('reports blocked before deciding retarget or fork', () => {
    const workspaces = [
      makeWorkspace({ id: 'ws-a', path: '/a' }),
      makeWorkspace({ id: 'ws-b', path: '/b' }),
    ];
    const activeSession = { id: 's1', workspaceId: 'ws-a', status: 'running' as const };
    const plan = planTargetChange({
      nextWorkspaceId: 'ws-b',
      activeSession,
      workspaces,
      messageCount: 0,
      hostBound: false,
    });
    expect(plan).toEqual({ kind: 'blocked' });
  });

  it('forks onto the target when there is no active session', () => {
    const workspaces = [makeWorkspace({ id: 'ws-a', path: '/a' })];
    const plan = planTargetChange({
      nextWorkspaceId: 'ws-a',
      activeSession: undefined,
      workspaces,
      messageCount: 0,
      hostBound: false,
    });
    expect(plan).toEqual({ kind: 'fork', workspaceId: 'ws-a', title: 'New chat' });
  });

  it('carries the target projectId in the retarget plan', () => {
    const workspaces = [
      makeWorkspace({ id: 'ws-a', projectId: 'project-1', path: '/a' }),
      makeWorkspace({ id: 'ws-c', projectId: 'project-2', path: '/c' }),
    ];
    const activeSession = { id: 's1', workspaceId: 'ws-a', status: 'idle' as const };
    const plan = planTargetChange({
      nextWorkspaceId: 'ws-c',
      activeSession,
      workspaces,
      messageCount: 0,
      hostBound: false,
    });
    expect(plan).toEqual({
      kind: 'retarget',
      sessionId: 's1',
      workspaceId: 'ws-c',
      projectId: 'project-2',
    });
  });

  it('forks a restored session (hostBound=true simulating a persisted runtimeIdentity) even with zero messages, not retarget', () => {
    // Simulates useComposerTarget's everHostBound synthesis: a session
    // restored from session-index.json has messageCount=0 (history not yet
    // loaded) and Host isn't currently running for it, but it carries a
    // persisted runtimeIdentity — the caller passes hostBound=true for it.
    // Retargeting in place instead of forking would resume the OLD
    // conversation into the NEW cwd via the first-send preamble.
    const workspaces = [
      makeWorkspace({ id: 'ws-a', path: '/a' }),
      makeWorkspace({ id: 'ws-b', path: '/b' }),
    ];
    const activeSession = { id: 's1', workspaceId: 'ws-a', status: 'idle' as const };
    const plan = planTargetChange({
      nextWorkspaceId: 'ws-b',
      activeSession,
      workspaces,
      messageCount: 0,
      hostBound: true,
    });
    expect(plan).toEqual({ kind: 'fork', workspaceId: 'ws-b', title: 'New chat' });
  });

  it('uses New chat as the default fork title and honours forkTitle', () => {
    const workspaces = [
      makeWorkspace({ id: 'ws-a', path: '/a' }),
      makeWorkspace({ id: 'ws-b', path: '/b' }),
    ];
    const activeSession = { id: 's1', workspaceId: 'ws-a', status: 'idle' as const };

    const defaultPlan = planTargetChange({
      nextWorkspaceId: 'ws-b',
      activeSession,
      workspaces,
      messageCount: 5,
      hostBound: false,
    });
    expect(defaultPlan).toEqual({ kind: 'fork', workspaceId: 'ws-b', title: 'New chat' });

    const customPlan = planTargetChange({
      nextWorkspaceId: 'ws-b',
      activeSession,
      workspaces,
      messageCount: 5,
      hostBound: false,
      forkTitle: 'Follow-up',
    });
    expect(customPlan).toEqual({ kind: 'fork', workspaceId: 'ws-b', title: 'Follow-up' });
  });
});

describe('resolveActiveTarget / resolveSendCwd', () => {
  it('returns null cwd when no session is active', () => {
    const cwd = resolveSendCwd({ activeSessionId: null, sessions: [], workspaces: [] });
    expect(cwd).toBeNull();
  });

  it('returns null cwd when the workspace path is empty', () => {
    const workspaces = [makeWorkspace({ id: 'ws-empty', path: '' })];
    const sessions = [makeSession({ id: 's1', workspaceId: 'ws-empty' })];
    const cwd = resolveSendCwd({ activeSessionId: 's1', sessions, workspaces });
    expect(cwd).toBeNull();
  });

  it('returns the workspace path verbatim without normalising', () => {
    const rawPath = 'C:\\Users\\foo\\repo\\';
    const workspaces = [makeWorkspace({ id: 'ws-raw', path: rawPath })];
    const sessions = [makeSession({ id: 's1', workspaceId: 'ws-raw' })];
    const cwd = resolveSendCwd({ activeSessionId: 's1', sessions, workspaces });
    expect(cwd).toBe(rawPath);

    const target = resolveActiveTarget({ activeSessionId: 's1', sessions, workspaces });
    expect(target.cwd).toBe(rawPath);
  });
});

describe('targetWorktreeLabel / shouldShowBranchSelect / isTargetableWorkspace', () => {
  it('prefers the real branch over the display name', () => {
    const ws = makeWorkspace({ branch: 'feature/x', name: 'Worktree 1' });
    expect(targetWorktreeLabel(ws)).toBe('feature/x');
  });

  it('falls back to the workspace name when the branch is unknown', () => {
    const ws = makeWorkspace({ branch: undefined, name: 'Main' });
    expect(targetWorktreeLabel(ws)).toBe('Main');
  });

  it('hides the branch select for temp and remote workspaces', () => {
    expect(shouldShowBranchSelect(makeWorkspace({ kind: 'temp', gitEnabled: true }))).toBe(false);
    expect(shouldShowBranchSelect(makeWorkspace({ kind: 'remote', gitEnabled: true }))).toBe(false);
    expect(shouldShowBranchSelect(makeWorkspace({ kind: 'main', gitEnabled: true }))).toBe(true);
    expect(shouldShowBranchSelect(makeWorkspace({ kind: 'worktree', gitEnabled: true }))).toBe(
      true
    );
  });

  it('hides the branch select for main/worktree when gitEnabled is not exactly true (T-27 blocker)', () => {
    expect(shouldShowBranchSelect(makeWorkspace({ kind: 'main' }))).toBe(false);
    expect(shouldShowBranchSelect(makeWorkspace({ kind: 'main', gitEnabled: false }))).toBe(false);
    expect(shouldShowBranchSelect(makeWorkspace({ kind: 'worktree' }))).toBe(false);
    expect(shouldShowBranchSelect(makeWorkspace({ kind: 'worktree', gitEnabled: false }))).toBe(
      false
    );
  });

  it('treats a whitespace-only path as not targetable', () => {
    expect(isTargetableWorkspace(makeWorkspace({ path: '   ' }))).toBe(false);
    expect(isTargetableWorkspace(makeWorkspace({ path: '/real' }))).toBe(true);
  });
});

describe('buildFolderMenu', () => {
  it('lists at most 5 recents, newest first, deduped by folder (projectId)', () => {
    // Round-3: dedup key moved from workspaceId to projectId (point-check
    // #8) — each workspace here belongs to its OWN project, so this stays a
    // "7 distinct folders, take the 5 newest" case under the new rule too.
    const workspaces = Array.from({ length: 7 }, (_, index) =>
      makeWorkspace({
        id: `ws-${index + 1}`,
        projectId: `project-${index + 1}`,
        path: `/repo-${index + 1}`,
      })
    );
    const sessions = [
      makeSession({ id: 's-1a', workspaceId: 'ws-1', projectId: 'project-1', updatedAt: 100 }),
      // duplicate SESSION on the same workspace/folder, older — still one row.
      makeSession({ id: 's-1b', workspaceId: 'ws-1', projectId: 'project-1', updatedAt: 90 }),
      makeSession({ id: 's-2', workspaceId: 'ws-2', projectId: 'project-2', updatedAt: 80 }),
      makeSession({ id: 's-3', workspaceId: 'ws-3', projectId: 'project-3', updatedAt: 70 }),
      makeSession({ id: 's-4', workspaceId: 'ws-4', projectId: 'project-4', updatedAt: 60 }),
      makeSession({ id: 's-5', workspaceId: 'ws-5', projectId: 'project-5', updatedAt: 50 }),
      makeSession({ id: 's-6', workspaceId: 'ws-6', projectId: 'project-6', updatedAt: 40 }),
      makeSession({ id: 's-7', workspaceId: 'ws-7', projectId: 'project-7', updatedAt: 30 }),
    ];
    const menu = buildFolderMenu({ projects: [], workspaces, sessions, activeWorkspaceId: null });
    expect(menu.recents.map((entry) => entry.workspaceId)).toEqual([
      'ws-1',
      'ws-2',
      'ws-3',
      'ws-4',
      'ws-5',
    ]);
  });

  it('drops recents whose workspace no longer exists', () => {
    const workspaces = [makeWorkspace({ id: 'ws-1', path: '/repo-1' })];
    const sessions = [
      makeSession({ id: 's-ghost', workspaceId: 'ws-ghost', updatedAt: 100 }),
      makeSession({ id: 's-1', workspaceId: 'ws-1', updatedAt: 50 }),
    ];
    const menu = buildFolderMenu({ projects: [], workspaces, sessions, activeWorkspaceId: null });
    expect(menu.recents.map((entry) => entry.workspaceId)).toEqual(['ws-1']);
  });

  it('splits repos into local and remote by the default workspace kind', () => {
    const projects = [
      makeProject({ id: 'proj-local', name: 'Local Repo' }),
      makeProject({ id: 'proj-remote', name: 'Remote Repo' }),
    ];
    const workspaces = [
      makeWorkspace({ id: 'ws-local-main', projectId: 'proj-local', kind: 'main', path: '/local' }),
      makeWorkspace({
        id: 'ws-remote-main',
        projectId: 'proj-remote',
        kind: 'remote',
        path: 'remote://host',
      }),
    ];
    const menu = buildFolderMenu({ projects, workspaces, sessions: [], activeWorkspaceId: null });
    expect(menu.local.map((entry) => entry.projectId)).toEqual(['proj-local']);
    expect(menu.remote.map((entry) => entry.projectId)).toEqual(['proj-remote']);
  });

  it('drops a project that has no targetable workspace', () => {
    const projects = [makeProject({ id: 'proj-empty', name: 'Empty' })];
    const workspaces = [makeWorkspace({ id: 'ws-empty', projectId: 'proj-empty', path: '' })];
    const menu = buildFolderMenu({ projects, workspaces, sessions: [], activeWorkspaceId: null });
    expect(menu.local).toEqual([]);
    expect(menu.remote).toEqual([]);
  });

  it('keeps a project in Repos even when it also appears in Recents', () => {
    const projects = [makeProject({ id: 'proj-a', name: 'Proj A' })];
    const workspaces = [
      makeWorkspace({ id: 'ws-a', projectId: 'proj-a', kind: 'main', path: '/a', branch: 'main' }),
    ];
    const sessions = [
      makeSession({ id: 's1', workspaceId: 'ws-a', projectId: 'proj-a', updatedAt: 10 }),
    ];
    const menu = buildFolderMenu({ projects, workspaces, sessions, activeWorkspaceId: null });
    expect(menu.recents.map((entry) => entry.workspaceId)).toContain('ws-a');
    expect(menu.local.map((entry) => entry.workspaceId)).toContain('ws-a');
  });

  // Round-3 (point-check #8): the folder dropdown must show folders only —
  // Recents entries for the same folder on different branches/worktrees
  // merge into a single row, carrying no branch text at all.
  it('merges same-folder, different-branch sessions into a single Recents row with no branch suffix', () => {
    const projects = [makeProject({ id: 'proj-b', name: 'Proj B' })];
    const workspaces = [
      makeWorkspace({
        id: 'ws-branch',
        projectId: 'proj-b',
        kind: 'worktree',
        path: '/b1',
        branch: 'feature/y',
        name: 'wsBranchName',
      }),
      makeWorkspace({
        id: 'ws-main',
        projectId: 'proj-b',
        kind: 'main',
        path: '/b2',
        branch: 'main',
        name: 'wsMainName',
      }),
    ];
    const sessions = [
      makeSession({ id: 's1', workspaceId: 'ws-branch', projectId: 'proj-b', updatedAt: 20 }),
      makeSession({ id: 's2', workspaceId: 'ws-main', projectId: 'proj-b', updatedAt: 10 }),
    ];
    const menu = buildFolderMenu({ projects, workspaces, sessions, activeWorkspaceId: null });
    expect(menu.recents).toHaveLength(1);
    // The newer session's workspace (feature/y) wins the merge; label is the
    // project name only — no branch text anywhere on the entry.
    expect(menu.recents[0]).toEqual({
      workspaceId: 'ws-branch',
      projectId: 'proj-b',
      label: 'Proj B',
      current: false,
    });
    expect(menu.recents[0]).not.toHaveProperty('secondary');
  });

  it('keeps a non-branch-suffixed label unchanged for a folder with a single branch', () => {
    const projects = [makeProject({ id: 'proj-c', name: 'Proj C' })];
    const workspaces = [makeWorkspace({ id: 'ws-c', projectId: 'proj-c', path: '/c' })];
    const sessions = [
      makeSession({ id: 's1', workspaceId: 'ws-c', projectId: 'proj-c', updatedAt: 10 }),
    ];
    const menu = buildFolderMenu({ projects, workspaces, sessions, activeWorkspaceId: null });
    expect(menu.recents[0]?.label).toBe('Proj C');
  });

  it('keeps the active workspace locatable even when it is not the most recently touched branch', () => {
    const projects = [makeProject({ id: 'proj-d', name: 'Proj D' })];
    const workspaces = [
      makeWorkspace({ id: 'ws-d-main', projectId: 'proj-d', kind: 'main', path: '/d1' }),
      makeWorkspace({ id: 'ws-d-feat', projectId: 'proj-d', kind: 'worktree', path: '/d2' }),
    ];
    const sessions = [
      // ws-d-feat is the newest session (would normally win the merge)...
      makeSession({ id: 's1', workspaceId: 'ws-d-feat', projectId: 'proj-d', updatedAt: 20 }),
      // ...but ws-d-main is the one actually targeted right now.
      makeSession({ id: 's2', workspaceId: 'ws-d-main', projectId: 'proj-d', updatedAt: 10 }),
    ];
    const menu = buildFolderMenu({
      projects,
      workspaces,
      sessions,
      activeWorkspaceId: 'ws-d-main',
    });
    expect(menu.recents).toHaveLength(1);
    expect(menu.recents[0].workspaceId).toBe('ws-d-main');
    expect(menu.recents[0].current).toBe(true);
  });

  it('keeps Recents order stable — a folder keeps its first (most recent) position when merged', () => {
    const projects = [
      makeProject({ id: 'proj-a', name: 'A' }),
      makeProject({ id: 'proj-b', name: 'B' }),
    ];
    const workspaces = [
      makeWorkspace({ id: 'ws-a1', projectId: 'proj-a', path: '/a1' }),
      makeWorkspace({ id: 'ws-a2', projectId: 'proj-a', path: '/a2' }),
      makeWorkspace({ id: 'ws-b', projectId: 'proj-b', path: '/b' }),
    ];
    const sessions = [
      makeSession({ id: 's1', workspaceId: 'ws-a1', projectId: 'proj-a', updatedAt: 30 }),
      makeSession({ id: 's2', workspaceId: 'ws-b', projectId: 'proj-b', updatedAt: 20 }),
      // Older session on proj-a's OTHER branch — must not bump proj-a's
      // already-claimed (newer) position, nor add a second proj-a row.
      makeSession({ id: 's3', workspaceId: 'ws-a2', projectId: 'proj-a', updatedAt: 10 }),
    ];
    const menu = buildFolderMenu({ projects, workspaces, sessions, activeWorkspaceId: null });
    expect(menu.recents.map((entry) => entry.projectId)).toEqual(['proj-a', 'proj-b']);
  });

  it('returns empty sections for an empty store', () => {
    const menu = buildFolderMenu({
      projects: [],
      workspaces: [],
      sessions: [],
      activeWorkspaceId: null,
    });
    expect(menu).toEqual({ recents: [], local: [], remote: [] });
  });

  // R1 fix: the active PROJECT's Recents row must always point at
  // activeWorkspaceId, never at whichever sibling branch happened to own the
  // most recent session — previously this only "won" the merge when a
  // session on activeWorkspaceId ITSELF was encountered.
  describe('R1: active project row correctness', () => {
    it('① points the row at activeWorkspaceId (and marks it current) even when the active workspace has no session of its own but a sibling branch does', () => {
      const projects = [makeProject({ id: 'proj-d', name: 'Proj D' })];
      const workspaces = [
        makeWorkspace({ id: 'ws-d-main', projectId: 'proj-d', kind: 'main', path: '/d1' }),
        makeWorkspace({ id: 'ws-d-feat', projectId: 'proj-d', kind: 'worktree', path: '/d2' }),
      ];
      // Only the SIBLING branch (ws-d-feat) has a session — ws-d-main (the
      // active workspace, e.g. just created/switched to) has none at all.
      const sessions = [
        makeSession({ id: 's1', workspaceId: 'ws-d-feat', projectId: 'proj-d', updatedAt: 20 }),
      ];
      const menu = buildFolderMenu({
        projects,
        workspaces,
        sessions,
        activeWorkspaceId: 'ws-d-main',
      });
      expect(menu.recents).toHaveLength(1);
      expect(menu.recents[0]).toMatchObject({
        workspaceId: 'ws-d-main',
        projectId: 'proj-d',
        current: true,
      });
    });

    it('② keeps the active project row even when it would otherwise fall outside recentsLimit', () => {
      const projects = Array.from({ length: 6 }, (_, index) =>
        makeProject({ id: `project-${index + 1}`, name: `Project ${index + 1}` })
      );
      const workspaces = Array.from({ length: 6 }, (_, index) =>
        makeWorkspace({
          id: `ws-${index + 1}`,
          projectId: `project-${index + 1}`,
          path: `/repo-${index + 1}`,
        })
      );
      // 6 distinct-project sessions, newest first — with the DEFAULT limit
      // of 5, project-6's session would normally be cut entirely.
      const sessions = Array.from({ length: 6 }, (_, index) =>
        makeSession({
          id: `s-${index + 1}`,
          workspaceId: `ws-${index + 1}`,
          projectId: `project-${index + 1}`,
          updatedAt: 100 - index * 10,
        })
      );
      const menu = buildFolderMenu({
        projects,
        workspaces,
        sessions,
        activeWorkspaceId: 'ws-6',
      });
      expect(menu.recents).toHaveLength(6);
      const activeEntry = menu.recents.find((entry) => entry.projectId === 'project-6');
      expect(activeEntry).toMatchObject({ workspaceId: 'ws-6', current: true });
    });

    it('③ leaves a non-active project row pointed at that project’s own most-recent session workspace (semantics unchanged)', () => {
      const projects = [
        makeProject({ id: 'proj-active', name: 'Active' }),
        makeProject({ id: 'proj-other', name: 'Other' }),
      ];
      const workspaces = [
        makeWorkspace({ id: 'ws-active', projectId: 'proj-active', path: '/active' }),
        makeWorkspace({ id: 'ws-other-a', projectId: 'proj-other', path: '/other-a' }),
        makeWorkspace({ id: 'ws-other-b', projectId: 'proj-other', path: '/other-b' }),
      ];
      const sessions = [
        makeSession({
          id: 's-active',
          workspaceId: 'ws-active',
          projectId: 'proj-active',
          updatedAt: 30,
        }),
        // proj-other's newest session sits on ws-other-a — that must still
        // win the merge since proj-other is not the active project.
        makeSession({
          id: 's-other-a',
          workspaceId: 'ws-other-a',
          projectId: 'proj-other',
          updatedAt: 20,
        }),
        makeSession({
          id: 's-other-b',
          workspaceId: 'ws-other-b',
          projectId: 'proj-other',
          updatedAt: 10,
        }),
      ];
      const menu = buildFolderMenu({
        projects,
        workspaces,
        sessions,
        activeWorkspaceId: 'ws-active',
      });
      const otherEntry = menu.recents.find((entry) => entry.projectId === 'proj-other');
      expect(otherEntry).toMatchObject({ workspaceId: 'ws-other-a', current: false });
    });

    it('adds a fallback row for the active project when it has NO session anywhere (not even on a sibling branch), without duplicating an existing row', () => {
      const projects = [
        makeProject({ id: 'proj-empty', name: 'Empty Active' }),
        makeProject({ id: 'proj-with-session', name: 'Has Session' }),
      ];
      const workspaces = [
        makeWorkspace({ id: 'ws-empty', projectId: 'proj-empty', path: '/empty' }),
        makeWorkspace({ id: 'ws-with-session', projectId: 'proj-with-session', path: '/has' }),
      ];
      const sessions = [
        makeSession({
          id: 's1',
          workspaceId: 'ws-with-session',
          projectId: 'proj-with-session',
          updatedAt: 10,
        }),
      ];
      const menu = buildFolderMenu({
        projects,
        workspaces,
        sessions,
        activeWorkspaceId: 'ws-empty',
      });
      const activeRows = menu.recents.filter((entry) => entry.projectId === 'proj-empty');
      expect(activeRows).toHaveLength(1);
      expect(activeRows[0]).toMatchObject({ workspaceId: 'ws-empty', current: true });
    });
  });
});

describe('buildBranchMenu', () => {
  const PROJECT_ID = 'proj-1';
  const branchWorkspaces: ChatWorkspace[] = [
    makeWorkspace({
      id: 'main-1',
      projectId: PROJECT_ID,
      kind: 'main',
      name: 'Main',
      branch: 'main',
      path: '/repo',
    }),
    makeWorkspace({
      id: 'wt-a',
      projectId: PROJECT_ID,
      kind: 'worktree',
      name: 'wt-a',
      branch: 'feature/a',
      path: '/repo-a',
    }),
    makeWorkspace({
      id: 'wt-b',
      projectId: PROJECT_ID,
      kind: 'worktree',
      name: 'wt-b',
      branch: 'feature/b',
      path: '/repo-b',
    }),
    makeWorkspace({
      id: 'wt-c',
      projectId: PROJECT_ID,
      kind: 'worktree',
      name: 'wt-c',
      branch: 'bugfix/c',
      path: '/repo-c',
    }),
    makeWorkspace({
      id: 'wt-d',
      projectId: PROJECT_ID,
      kind: 'worktree',
      name: 'wt-d',
      branch: 'alpha/d',
      path: '/repo-d',
    }),
    makeWorkspace({
      id: 'remote-1',
      projectId: PROJECT_ID,
      kind: 'remote',
      name: 'remote-1',
      path: 'remote://x',
    }),
    makeWorkspace({
      id: 'temp-1',
      projectId: PROJECT_ID,
      kind: 'temp',
      name: 'temp-1',
      path: '/tmp/x',
    }),
  ];
  const branchSessions: ChatSession[] = [
    makeSession({ id: 's-main', workspaceId: 'main-1', projectId: PROJECT_ID, updatedAt: 500 }),
    makeSession({ id: 's-a', workspaceId: 'wt-a', projectId: PROJECT_ID, updatedAt: 200 }),
    makeSession({ id: 's-b', workspaceId: 'wt-b', projectId: PROJECT_ID, updatedAt: 100 }),
  ];

  it('pins main first and never repeats it under recent or others', () => {
    const menu = buildBranchMenu({
      projectId: PROJECT_ID,
      workspaces: branchWorkspaces,
      sessions: branchSessions,
      activeWorkspaceId: null,
    });
    expect(menu.main?.workspaceId).toBe('main-1');
    expect(menu.recent.some((entry) => entry.workspaceId === 'main-1')).toBe(false);
    expect(menu.others.some((entry) => entry.workspaceId === 'main-1')).toBe(false);
  });

  it('orders recent by the newest session updatedAt on that worktree', () => {
    const menu = buildBranchMenu({
      projectId: PROJECT_ID,
      workspaces: branchWorkspaces,
      sessions: branchSessions,
      activeWorkspaceId: null,
    });
    expect(menu.recent.map((entry) => entry.workspaceId)).toEqual(['wt-a', 'wt-b']);
  });

  it('excludes worktrees with no sessions from recent', () => {
    const menu = buildBranchMenu({
      projectId: PROJECT_ID,
      workspaces: branchWorkspaces,
      sessions: branchSessions,
      activeWorkspaceId: null,
    });
    expect(menu.recent.some((entry) => entry.workspaceId === 'wt-c')).toBe(false);
    expect(menu.recent.some((entry) => entry.workspaceId === 'wt-d')).toBe(false);
    expect(menu.others.some((entry) => entry.workspaceId === 'wt-c')).toBe(true);
    expect(menu.others.some((entry) => entry.workspaceId === 'wt-d')).toBe(true);
  });

  it('sorts others by label', () => {
    const menu = buildBranchMenu({
      projectId: PROJECT_ID,
      workspaces: branchWorkspaces,
      sessions: branchSessions,
      activeWorkspaceId: null,
    });
    expect(menu.others.map((entry) => entry.label)).toEqual(['alpha/d', 'bugfix/c']);
  });

  it('keeps the remotes/ prefix untouched', () => {
    const workspaces: ChatWorkspace[] = [
      makeWorkspace({
        id: 'main-x',
        projectId: 'proj-x',
        kind: 'main',
        name: 'Main',
        branch: 'main',
        path: '/repo-x',
      }),
      makeWorkspace({
        id: 'wt-remote-branch',
        projectId: 'proj-x',
        kind: 'worktree',
        name: 'wt',
        branch: 'remotes/origin/feature',
        path: '/repo-x-wt',
      }),
    ];
    const sessions: ChatSession[] = [
      makeSession({
        id: 's1',
        workspaceId: 'wt-remote-branch',
        projectId: 'proj-x',
        updatedAt: 10,
      }),
    ];
    const menu = buildBranchMenu({
      projectId: 'proj-x',
      workspaces,
      sessions,
      activeWorkspaceId: null,
    });
    expect(menu.recent[0]?.label).toBe('remotes/origin/feature');
  });

  it('returns total 0 for a project with no git worktrees', () => {
    const workspaces: ChatWorkspace[] = [
      makeWorkspace({
        id: 'remote-only',
        projectId: 'proj-y',
        kind: 'remote',
        name: 'remote',
        path: 'remote://y',
      }),
      makeWorkspace({
        id: 'temp-only',
        projectId: 'proj-y',
        kind: 'temp',
        name: 'temp',
        path: '/tmp/y',
      }),
    ];
    const menu = buildBranchMenu({
      projectId: 'proj-y',
      workspaces,
      sessions: [],
      activeWorkspaceId: null,
    });
    expect(menu).toEqual({ main: null, recent: [], others: [], total: 0 });
  });

  it('excludes temp and remote workspaces', () => {
    const menu = buildBranchMenu({
      projectId: PROJECT_ID,
      workspaces: branchWorkspaces,
      sessions: branchSessions,
      activeWorkspaceId: null,
    });
    const allIds = [
      ...(menu.main ? [menu.main.workspaceId] : []),
      ...menu.recent.map((entry) => entry.workspaceId),
      ...menu.others.map((entry) => entry.workspaceId),
    ];
    expect(allIds).not.toContain('remote-1');
    expect(allIds).not.toContain('temp-1');
  });
});

describe('resolveRuntimeRepoPath', () => {
  it('maps a worktree workspace to its project main path', () => {
    const workspaces = [
      makeWorkspace({ id: 'main-1', projectId: 'proj-1', kind: 'main', path: '/repo' }),
      makeWorkspace({ id: 'wt-1', projectId: 'proj-1', kind: 'worktree', path: '/repo-wt' }),
    ];
    expect(resolveRuntimeRepoPath('wt-1', workspaces)).toBe('/repo');
  });

  it('falls back to the workspace path when the project has no main', () => {
    const workspaces = [
      makeWorkspace({
        id: 'wt-only',
        projectId: 'proj-2',
        kind: 'worktree',
        path: '/repo-wt-only',
      }),
    ];
    expect(resolveRuntimeRepoPath('wt-only', workspaces)).toBe('/repo-wt-only');
  });
});

describe('runLocationLabel', () => {
  it('hides when repoPath is missing', () => {
    expect(
      runLocationLabel({ context: { kind: 'local' }, profiles: [], repoPath: null })
    ).toBeNull();
    expect(runLocationLabel({ context: { kind: 'local' }, profiles: [], repoPath: '' })).toBeNull();
  });

  it('hides when the context query has no data', () => {
    expect(runLocationLabel({ context: undefined, profiles: [], repoPath: '/repo' })).toBeNull();
  });

  it('shows This PC for local', () => {
    expect(
      runLocationLabel({ context: { kind: 'local' }, profiles: [], repoPath: '/repo' })
    ).toEqual({ text: 'This PC', tone: 'local' });
  });

  it('resolves the remote connection name from profiles', () => {
    expect(
      runLocationLabel({
        context: { kind: 'remote', connectionId: 'c1' },
        profiles: [{ id: 'c1', name: 'My Server' }],
        repoPath: '/repo',
      })
    ).toEqual({ text: 'My Server', tone: 'remote' });
  });

  it('hides when remote connection metadata is missing (T-27 blocker — no generic Remote fallback)', () => {
    // connectionId present, profiles loaded, but no matching profile.
    expect(
      runLocationLabel({
        context: { kind: 'remote', connectionId: 'unknown' },
        profiles: [{ id: 'c1', name: 'My Server' }],
        repoPath: '/repo',
      })
    ).toBeNull();

    // profiles query has not resolved yet.
    expect(
      runLocationLabel({
        context: { kind: 'remote', connectionId: 'c1' },
        profiles: undefined,
        repoPath: '/repo',
      })
    ).toBeNull();

    // profiles loaded but empty (query failed / nothing configured).
    expect(
      runLocationLabel({
        context: { kind: 'remote', connectionId: 'c1' },
        profiles: [],
        repoPath: '/repo',
      })
    ).toBeNull();

    // connectionId itself is missing from the context.
    expect(
      runLocationLabel({
        context: { kind: 'remote' },
        profiles: [{ id: 'c1', name: 'My Server' }],
        repoPath: '/repo',
      })
    ).toBeNull();
  });
});

describe('matchWorkspaceByPath', () => {
  it('matches case-insensitively and across separator styles', () => {
    const workspaces = [makeWorkspace({ id: 'ws-1', path: 'C:\\Users\\Foo\\Repo' })];
    const match = matchWorkspaceByPath('c:/users/foo/repo', workspaces);
    expect(match?.id).toBe('ws-1');
  });

  // Round-6 review M3: one directory can back two workspaces — the parent
  // repo's `worktree` entry and the registered folder's own `main` (D2's
  // deliberate dual identity). Path-only lookups must prefer main
  // deterministically instead of inheriting array order.
  it('prefers the main workspace over a worktree entry at the same path (worktree listed first)', () => {
    const workspaces = [
      makeWorkspace({
        id: 'ws-worktree',
        projectId: 'proj-parent',
        kind: 'worktree',
        path: '/aaa',
      }),
      makeWorkspace({ id: 'ws-main', projectId: 'proj-aaa', kind: 'main', path: '/aaa' }),
    ];
    const match = matchWorkspaceByPath('/aaa', workspaces);
    expect(match?.kind).toBe('main');
    expect(match?.id).toBe('ws-main');
  });

  it('still prefers main when the array order is reversed (main listed first)', () => {
    const workspaces = [
      makeWorkspace({ id: 'ws-main', projectId: 'proj-aaa', kind: 'main', path: '/aaa' }),
      makeWorkspace({
        id: 'ws-worktree',
        projectId: 'proj-parent',
        kind: 'worktree',
        path: '/aaa',
      }),
    ];
    const match = matchWorkspaceByPath('/aaa', workspaces);
    expect(match?.kind).toBe('main');
    expect(match?.id).toBe('ws-main');
  });

  it('disambiguates the same-path pair for a trailing-slash / case-drifted query too', () => {
    const workspaces = [
      makeWorkspace({
        id: 'ws-worktree',
        projectId: 'proj-parent',
        kind: 'worktree',
        path: '/aaa',
      }),
      makeWorkspace({ id: 'ws-main', projectId: 'proj-aaa', kind: 'main', path: '/aaa' }),
    ];
    expect(matchWorkspaceByPath('/aaa/', workspaces)?.id).toBe('ws-main');
    expect(matchWorkspaceByPath('/AAA', workspaces)?.id).toBe('ws-main');
  });
});
