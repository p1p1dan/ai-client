import { describe, expect, it } from 'vitest';
import type { Repository } from '@/App/constants';
import {
  deriveChatWorkspaceTree,
  resolvePreferredWorkspaceId,
  workspaceIdFor,
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
    expect(workspaces.map((ws) => ({ kind: ws.kind, name: ws.name, path: ws.path }))).toEqual([
      { kind: 'main', name: 'Main', path: 'D:/Code/projects/ai-client' },
      { kind: 'worktree', name: 'feat/demo', path: 'D:/Code/projects/ai-client-wt' },
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
});
