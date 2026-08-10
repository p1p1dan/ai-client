import { describe, expect, it } from 'vitest';
import type { Repository } from '@/App/constants';
import {
  deriveChatWorkspaceTree,
  resolvePreferredWorkspaceId,
  workspaceIdFor,
  workspaceTreeSignature,
} from '../deriveChatWorkspaceTree';
import { resolveNewSessionWorkspaceId } from '../sidebarTree';

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

  // T-31 (round-6 D2): a linked git worktree registered as its own top-level
  // repo (openchamber's `aaa` worktree) was getting zero workspaces because
  // worktree.list for that repo still reports the *parent* repo's full
  // worktree set, whose main entry collides with the parent project's own
  // `ws:main:<root>` id.
  describe('linked-worktree self-registration (T-31 / round-6 D2)', () => {
    const rootPath = 'D:/Code/openchamber';
    const aaaPath = 'D:/Code/openchamber-worktrees/aaa';

    const rootRepo: Repository = {
      id: 'repo-root',
      name: 'openchamber',
      path: rootPath,
      kind: 'local',
    };
    const aaaRepo: Repository = {
      id: 'repo-aaa',
      name: 'aaa',
      path: aaaPath,
      kind: 'local',
    };

    const parentWorktreeList = [
      {
        path: rootPath,
        head: 'root-head',
        branch: 'refs/heads/main',
        isMainWorktree: true,
        isLocked: false,
        prunable: false,
      },
      {
        path: aaaPath,
        head: 'aaa-head',
        branch: 'refs/heads/aaa',
        isMainWorktree: false,
        isLocked: false,
        prunable: false,
      },
    ];

    it('T1: repo registered at a linked worktree path gets exactly one main workspace, no parent-root leak', () => {
      const { workspaces } = deriveChatWorkspaceTree({
        repositories: [aaaRepo],
        worktreesByRepoPath: { [aaaPath]: parentWorktreeList },
        tempItems: [],
      });

      expect(workspaces).toHaveLength(1);
      const [ws] = workspaces;
      expect(ws).toMatchObject({
        id: workspaceIdFor('main', aaaPath),
        projectId: 'repo-aaa',
        kind: 'main',
        path: aaaPath,
        branch: 'aaa',
        gitEnabled: true,
      });
      // No workspace under this project should point at the parent root.
      expect(workspaces.some((w) => w.path === rootPath)).toBe(false);
    });

    it('T9: a symlinked registration (git reports a different realpath root) degrades to a single self workspace — accepted trade-off, never an id collision', () => {
      // Lexical canonical keys cannot see through symlinks (round-6 verify
      // minor 4): the registered link path and git's realpath root compare
      // unequal, so the self short-circuit fires. Pinned so nobody "fixes"
      // this back into the cross-project id collision, and nobody expects
      // sibling worktrees or a branch chip under a symlinked registration.
      const { workspaces } = deriveChatWorkspaceTree({
        repositories: [{ id: 'repo-link', name: 'link', path: '/repo-link', kind: 'local' }],
        worktreesByRepoPath: {
          '/repo-link': [
            {
              path: '/real/repo',
              head: 'real-head',
              branch: 'refs/heads/main',
              isMainWorktree: true,
              isLocked: false,
              prunable: false,
            },
          ],
        },
        tempItems: [],
      });

      expect(workspaces).toEqual([
        {
          id: workspaceIdFor('main', '/repo-link'),
          projectId: 'repo-link',
          name: 'Main',
          kind: 'main',
          path: '/repo-link',
          gitEnabled: true,
        },
      ]);
      // No listed entry matches the registered path lexically → no branch
      // key, and the realpath root is never attached to this project.
      expect(workspaces[0] && 'branch' in workspaces[0]).toBe(false);
    });

    it('T2: root + worktree repos registered together, either order, neither project is starved', () => {
      const worktreesByRepoPath = {
        [rootPath]: parentWorktreeList,
        [aaaPath]: parentWorktreeList,
      };

      for (const repositories of [
        [rootRepo, aaaRepo],
        [aaaRepo, rootRepo],
      ]) {
        const { workspaces } = deriveChatWorkspaceTree({
          repositories,
          worktreesByRepoPath,
          tempItems: [],
        });

        const rootWorkspaces = workspaces.filter((w) => w.projectId === 'repo-root');
        const aaaWorkspaces = workspaces.filter((w) => w.projectId === 'repo-aaa');

        // Root project keeps its own main plus the sibling worktree entry for
        // `aaa` — full shape pinned (round-6 review N2: id/kind alone let a
        // wrong path/branch/gitEnabled slip through unnoticed).
        expect(rootWorkspaces).toEqual([
          {
            id: workspaceIdFor('main', rootPath),
            projectId: 'repo-root',
            name: 'Main',
            kind: 'main',
            path: rootPath,
            branch: 'main',
            gitEnabled: true,
          },
          {
            id: workspaceIdFor('worktree', aaaPath),
            projectId: 'repo-root',
            name: 'aaa',
            kind: 'worktree',
            path: aaaPath,
            branch: 'aaa',
            gitEnabled: true,
          },
        ]);
        // aaa project resolves to its own main workspace, not the parent root.
        expect(aaaWorkspaces).toEqual([
          {
            id: workspaceIdFor('main', aaaPath),
            projectId: 'repo-aaa',
            name: 'Main',
            kind: 'main',
            path: aaaPath,
            branch: 'aaa',
            gitEnabled: true,
          },
        ]);
      }
    });

    it('T3 (regression): ordinary repo where repo.path === main worktree path is unaffected', () => {
      const { workspaces } = deriveChatWorkspaceTree({
        repositories: [rootRepo],
        worktreesByRepoPath: { [rootPath]: parentWorktreeList },
        tempItems: [],
      });

      expect(
        workspaces.map((ws) => ({ id: ws.id, kind: ws.kind, path: ws.path, branch: ws.branch }))
      ).toEqual([
        { id: workspaceIdFor('main', rootPath), kind: 'main', path: rootPath, branch: 'main' },
        { id: workspaceIdFor('worktree', aaaPath), kind: 'worktree', path: aaaPath, branch: 'aaa' },
      ]);
    });

    it('T4: self-registered linked worktree with no branch (detached HEAD) omits the branch key', () => {
      const detachedList = [
        {
          path: rootPath,
          head: 'root-head',
          branch: 'refs/heads/main',
          isMainWorktree: true,
          isLocked: false,
          prunable: false,
        },
        {
          path: aaaPath,
          head: 'aaa-head',
          branch: null,
          isMainWorktree: false,
          isLocked: false,
          prunable: false,
        },
      ];

      const { workspaces } = deriveChatWorkspaceTree({
        repositories: [aaaRepo],
        worktreesByRepoPath: { [aaaPath]: detachedList },
        tempItems: [],
      });

      expect(workspaces).toHaveLength(1);
      expect('branch' in workspaces[0]).toBe(false);
    });

    it('T5: resolveNewSessionWorkspaceId resolves each project to its own main workspace, either registration order', () => {
      const worktreesByRepoPath = {
        [rootPath]: parentWorktreeList,
        [aaaPath]: parentWorktreeList,
      };

      for (const repositories of [
        [rootRepo, aaaRepo],
        [aaaRepo, rootRepo],
      ]) {
        const { workspaces } = deriveChatWorkspaceTree({
          repositories,
          worktreesByRepoPath,
          tempItems: [],
        });

        expect(resolveNewSessionWorkspaceId('repo-aaa', workspaces)).toBe(
          workspaceIdFor('main', aaaPath)
        );
        expect(resolveNewSessionWorkspaceId('repo-root', workspaces)).toBe(
          workspaceIdFor('main', rootPath)
        );
      }
    });

    it('T6: repo registered at a subdirectory of the git root gets exactly one main workspace, no root leak', () => {
      const subRootPath = 'D:/Code/openchamber';
      const subPath = 'D:/Code/openchamber/packages/web';
      const subRepo: Repository = {
        id: 'repo-web',
        name: 'web',
        path: subPath,
        kind: 'local',
      };
      // No linked-worktree entry for `subPath` — the repo root is the only
      // listed worktree, exactly like `git worktree list` run from a plain
      // subdirectory of the repo.
      const rootOnlyList = [
        {
          path: subRootPath,
          head: 'root-head',
          branch: 'refs/heads/main',
          isMainWorktree: true,
          isLocked: false,
          prunable: false,
        },
      ];

      const { workspaces } = deriveChatWorkspaceTree({
        repositories: [subRepo],
        worktreesByRepoPath: { [subPath]: rootOnlyList },
        tempItems: [],
      });

      expect(workspaces).toHaveLength(1);
      const [ws] = workspaces;
      expect(ws).toMatchObject({
        id: workspaceIdFor('main', subPath),
        projectId: 'repo-web',
        kind: 'main',
        path: subPath,
        gitEnabled: true,
      });
      // No matching linked-worktree entry for the subdirectory itself, so no
      // branch chip is guessed.
      expect('branch' in ws).toBe(false);
      // No workspace under this project should point at the git root.
      expect(workspaces.some((w) => w.path === subRootPath)).toBe(false);
    });

    it('T7: a trailing slash on repo.path does not disable the self-registration short-circuit', () => {
      const aaaPathWithSlash = `${aaaPath}/`;
      const trailingSlashRepo: Repository = {
        id: 'repo-aaa-slash',
        name: 'aaa',
        path: aaaPathWithSlash,
        kind: 'local',
      };

      const { workspaces } = deriveChatWorkspaceTree({
        repositories: [trailingSlashRepo],
        worktreesByRepoPath: { [aaaPathWithSlash]: parentWorktreeList },
        tempItems: [],
      });

      expect(workspaces).toHaveLength(1);
      const [ws] = workspaces;
      // path is stored verbatim (with the trailing slash) — canonicalPathKey
      // is a comparison key only, never a stored/displayed path.
      expect(ws.path).toBe(aaaPathWithSlash);
      expect(ws.branch).toBe('aaa');
    });

    it('T8: resolvePreferredWorkspaceId disambiguates the same-path dual identity toward the registered-folder main, either registration order', () => {
      const worktreesByRepoPath = {
        [rootPath]: parentWorktreeList,
        [aaaPath]: parentWorktreeList,
      };

      for (const repositories of [
        [rootRepo, aaaRepo],
        [aaaRepo, rootRepo],
      ]) {
        const { workspaces } = deriveChatWorkspaceTree({
          repositories,
          worktreesByRepoPath,
          tempItems: [],
        });

        expect(
          resolvePreferredWorkspaceId(workspaces, {
            selectedRepoPath: aaaPath,
            activeWorktreePath: null,
          })
        ).toBe(workspaceIdFor('main', aaaPath));
      }
    });

    it('T8b: the disambiguation survives a trailing-slash / case-drifted selectedRepoPath', () => {
      const worktreesByRepoPath = {
        [rootPath]: parentWorktreeList,
        [aaaPath]: parentWorktreeList,
      };
      const { workspaces } = deriveChatWorkspaceTree({
        repositories: [rootRepo, aaaRepo],
        worktreesByRepoPath,
        tempItems: [],
      });

      expect(
        resolvePreferredWorkspaceId(workspaces, {
          selectedRepoPath: `${aaaPath}/`,
          activeWorktreePath: null,
        })
      ).toBe(workspaceIdFor('main', aaaPath));

      expect(
        resolvePreferredWorkspaceId(workspaces, {
          selectedRepoPath: aaaPath.toUpperCase(),
          activeWorktreePath: null,
        })
      ).toBe(workspaceIdFor('main', aaaPath));
    });
  });
});

describe('branch resolution on real Windows path shapes (M4)', () => {
  // Every pre-existing case in this file writes BOTH sides with forward slashes.
  // On a real Windows machine they differ: `repo.path` comes from the folder
  // picker (backslashes) while git prints forward slashes. That mixed shape —
  // the only one that actually occurs — had zero coverage, which is part of why
  // M4 could not be reproduced here.
  const winRepo: Repository = {
    id: 'repo-win',
    name: 'demo',
    path: 'D:\\Code\\demo',
    kind: 'local',
  };
  const wt = (path: string, branch: string | null, isMainWorktree: boolean) => ({
    path,
    head: 'abc',
    branch,
    isMainWorktree,
    isLocked: false,
    prunable: false,
  });

  it('resolves the branch when the repo path and git disagree on separators', () => {
    const { workspaces, diagnostics } = deriveChatWorkspaceTree({
      repositories: [winRepo],
      worktreesByRepoPath: {
        [winRepo.path]: [wt('D:/Code/demo', 'main', true), wt('D:/Code/demo-wt', 'feat/x', false)],
      },
      tempItems: [],
    });

    expect(workspaces.find((w) => w.kind === 'main')?.branch).toBe('main');
    expect(diagnostics).toEqual([]);
  });

  it('reports branch-unresolved with both keys when the repo is a subdirectory', () => {
    // The registered folder is inside the repo, so it is not a worktree entry
    // and no branch can be read. This is by design, but it used to be silent —
    // and silent is why the round could only say "still blank".
    const sub: Repository = { ...winRepo, path: 'D:\\Code\\demo\\packages\\app' };
    const { diagnostics } = deriveChatWorkspaceTree({
      repositories: [sub],
      worktreesByRepoPath: { [sub.path]: [wt('D:/Code/demo', 'main', true)] },
      tempItems: [],
    });

    expect(diagnostics).toEqual([
      {
        kind: 'branch-unresolved',
        repoPath: 'D:\\Code\\demo\\packages\\app',
        repoKey: 'd:/code/demo/packages/app',
        mainWorktreePath: 'D:/Code/demo',
        mainWorktreeKey: 'd:/code/demo',
        listedKeys: ['d:/code/demo'],
      },
    ]);
  });

  it('separates "never queried" from "queried and empty"', () => {
    // `?? []` used to make these identical downstream, so a failed query and a
    // non-git folder produced the same UI and the same (absent) evidence.
    const missing = deriveChatWorkspaceTree({
      repositories: [winRepo],
      worktreesByRepoPath: {},
      tempItems: [],
    });
    const empty = deriveChatWorkspaceTree({
      repositories: [winRepo],
      worktreesByRepoPath: { [winRepo.path]: [] },
      tempItems: [],
    });

    expect(missing.diagnostics).toEqual([
      { kind: 'worktrees-absent', repoPath: winRepo.path, neverQueried: true },
    ]);
    expect(empty.diagnostics).toEqual([
      { kind: 'worktrees-absent', repoPath: winRepo.path, neverQueried: false },
    ]);
  });

  it('stays silent on a healthy tree', () => {
    // Falsifies a diagnostic that fires on every render: noise would be worse
    // than the silence it replaces.
    const { diagnostics } = deriveChatWorkspaceTree({
      repositories: [winRepo],
      worktreesByRepoPath: { [winRepo.path]: [wt('D:/Code/demo', 'main', true)] },
      tempItems: [],
    });
    expect(diagnostics).toEqual([]);
  });
});
