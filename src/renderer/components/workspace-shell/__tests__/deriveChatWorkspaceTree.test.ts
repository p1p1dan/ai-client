import { describe, expect, it } from 'vitest';
import type { Repository } from '@/App/constants';
import {
  deriveChatWorkspaceTree,
  resolvePreferredWorkspaceId,
  workspaceIdFor,
  workspaceTreeSignature,
} from '../deriveChatWorkspaceTree';

describe('deriveChatWorkspaceTree', () => {
  const repo: Repository = {
    id: 'repo-ai',
    name: 'ai-client',
    path: 'D:/Code/projects/ai-client',
    kind: 'local',
  };

  it('maps main + linked worktrees under a project', () => {
    const { projects, workspaces } = deriveChatWorkspaceTree({
      repositories: [repo],
      worktreesByRepoPath: {
        [repo.path]: [
          {
            path: 'D:/Code/projects/ai-client',
            head: 'abc',
            branch: 'main',
            isMainWorktree: true,
            isLocked: false,
            prunable: false,
          },
          {
            path: 'D:/Code/projects/ai-client-wt',
            head: 'def',
            branch: 'refs/heads/feat/demo',
            isMainWorktree: false,
            isLocked: false,
            prunable: false,
          },
        ],
      },
      tempItems: [],
    });

    expect(projects).toEqual([{ id: 'repo-ai', name: 'ai-client' }]);
    // T-26 (D21-A): the main workspace carries its actual branch so the
    // sidebar chip can show main/master instead of the display name "Main".
    expect(
      workspaces.map((ws) => ({ kind: ws.kind, name: ws.name, path: ws.path, branch: ws.branch }))
    ).toEqual([
      { kind: 'main', name: 'Main', path: 'D:/Code/projects/ai-client', branch: 'main' },
      {
        kind: 'worktree',
        name: 'feat/demo',
        path: 'D:/Code/projects/ai-client-wt',
        branch: 'feat/demo',
      },
    ]);
  });

  it('adds temp workspaces under a Temp project', () => {
    const { projects, workspaces } = deriveChatWorkspaceTree({
      repositories: [],
      worktreesByRepoPath: {},
      tempItems: [
        {
          id: 'tmp-1',
          path: 'D:/tmp/session-a',
          folderName: 'session-a',
          title: 'Scratch',
          createdAt: 1,
        },
      ],
    });

    expect(projects[0]?.name).toBe('Temp');
    expect(workspaces[0]).toMatchObject({
      kind: 'temp',
      name: 'Scratch',
      path: 'D:/tmp/session-a',
    });
  });

  it('prefers active worktree path for preferred workspace', () => {
    const workspaces = [
      {
        id: workspaceIdFor('main', 'D:/repo'),
        projectId: 'p1',
        name: 'Main',
        kind: 'main' as const,
        path: 'D:/repo',
      },
      {
        id: workspaceIdFor('worktree', 'D:/repo-wt'),
        projectId: 'p1',
        name: 'feat',
        kind: 'worktree' as const,
        path: 'D:/repo-wt',
      },
    ];

    expect(
      resolvePreferredWorkspaceId(workspaces, {
        selectedRepoPath: 'D:/repo',
        activeWorktreePath: 'D:/repo-wt',
      })
    ).toBe(workspaceIdFor('worktree', 'D:/repo-wt'));
  });

  it('signature changes when only a workspace branch changes (T-26 review blocker)', () => {
    // Cold-start shape for a repo without linked worktrees: the tree derived
    // before `worktree.list` resolves differs from the loaded tree only in
    // `branch`. The sync-bridge guard must treat that as a change, or the
    // store never learns the branch and the sidebar chip stays empty.
    const base = {
      id: workspaceIdFor('main', 'D:/repo'),
      projectId: 'p1',
      name: 'Main',
      kind: 'main' as const,
      path: 'D:/repo',
    };
    const projects = [{ id: 'p1', name: 'repo' }];
    const before = workspaceTreeSignature(projects, [base], base.id);
    const after = workspaceTreeSignature(projects, [{ ...base, branch: 'main' }], base.id);
    expect(before).not.toBe(after);
  });

  it('signature changes when only gitEnabled changes (T-27 review blocker — same failure mode as T-26 branch)', () => {
    // Same cold-start shape as above: `worktree.list` resolving late flips
    // `gitEnabled` on an otherwise identical tree. Dropping it from the
    // signature would leave the Composer branch dropdown gated off forever.
    const base = {
      id: workspaceIdFor('main', 'D:/repo'),
      projectId: 'p1',
      name: 'Main',
      kind: 'main' as const,
      path: 'D:/repo',
    };
    const projects = [{ id: 'p1', name: 'repo' }];
    const before = workspaceTreeSignature(projects, [base], base.id);
    const after = workspaceTreeSignature(projects, [{ ...base, gitEnabled: true }], base.id);
    expect(before).not.toBe(after);
  });

  it('sets gitEnabled on main/worktree entries only when worktree.list returned data', () => {
    const { workspaces } = deriveChatWorkspaceTree({
      repositories: [repo],
      worktreesByRepoPath: {
        [repo.path]: [
          {
            path: 'D:/Code/projects/ai-client',
            head: 'abc',
            branch: 'main',
            isMainWorktree: true,
            isLocked: false,
            prunable: false,
          },
          {
            path: 'D:/Code/projects/ai-client-wt',
            head: 'def',
            branch: 'refs/heads/feat/demo',
            isMainWorktree: false,
            isLocked: false,
            prunable: false,
          },
        ],
      },
      tempItems: [],
    });
    expect(workspaces.map((ws) => ws.gitEnabled)).toEqual([true, true]);

    const { workspaces: loadingWorkspaces } = deriveChatWorkspaceTree({
      repositories: [repo],
      worktreesByRepoPath: {},
      tempItems: [],
    });
    expect(loadingWorkspaces[0]?.gitEnabled).toBe(false);
  });
});
