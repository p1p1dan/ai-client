import { describe, expect, it } from 'vitest';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import {
  planHomeBranchSwitch,
  resolveHomeDefaultWorkspace,
  resolveHomeDraftBranch,
  resolveHomeTarget,
} from '../homeTarget';

/**
 * Decision 174 (GitHub issue #6, second wave; user rulings 2026-10-10): the
 * home page's draft target — the repository the title names, the work bar
 * shows, and the send makes the conversation on — and the branch switched to
 * at send time.
 */

const projects: ChatProject[] = [
  { id: 'p-alpha', name: 'alpha' },
  { id: 'p-beta', name: 'beta' },
  { id: 'p-temp', name: 'Temp' },
];

const workspaces: ChatWorkspace[] = [
  {
    id: 'ws-alpha',
    projectId: 'p-alpha',
    name: 'Main',
    kind: 'main',
    path: '/repo/alpha',
    branch: 'main',
    gitEnabled: true,
  },
  {
    id: 'ws-alpha-wt',
    projectId: 'p-alpha',
    name: 'feat/x',
    kind: 'worktree',
    path: '/repo/alpha-wt',
    branch: 'feat/x',
    gitEnabled: true,
  },
  {
    id: 'ws-beta',
    projectId: 'p-beta',
    name: 'Main',
    kind: 'main',
    path: '/repo/beta',
    branch: 'develop',
    gitEnabled: true,
  },
  { id: 'ws-temp', projectId: 'p-temp', name: 'scratch', kind: 'temp', path: '/tmp/scratch' },
];

function chat(id: string, workspaceId: string, updatedAt: number): ChatSession {
  return { id, projectId: '', workspaceId, title: id, status: 'idle', updatedAt };
}

describe('the home page default target (most recently active repository)', () => {
  it('is the repository whose newest chat is newest — a worktree chat counts for its repository', () => {
    const sessions = [chat('a', 'ws-beta', 10), chat('b', 'ws-alpha-wt', 30)];
    expect(resolveHomeDefaultWorkspace({ projects, workspaces, sessions })?.id).toBe('ws-alpha');
  });

  it('ignores temporary chats and the Temp Session project', () => {
    const sessions = [chat('a', 'ws-beta', 10), chat('t', 'ws-temp', 99), chat('u', '', 100)];
    expect(resolveHomeDefaultWorkspace({ projects, workspaces, sessions })?.id).toBe('ws-beta');
  });

  it('with no chat anywhere, is the first repository in the order they were added', () => {
    expect(resolveHomeDefaultWorkspace({ projects, workspaces, sessions: [] })?.id).toBe(
      'ws-alpha'
    );
  });

  it('is nothing when there is no repository', () => {
    expect(
      resolveHomeDefaultWorkspace({
        projects: [{ id: 'p-temp', name: 'Temp' }],
        workspaces: [workspaces[3] as ChatWorkspace],
        sessions: [],
      })
    ).toBeNull();
  });
});

describe('resolveHomeTarget', () => {
  const sessions = [chat('a', 'ws-beta', 10)];

  it('follows the default until something is picked, naming the repository', () => {
    expect(
      resolveHomeTarget({ pick: { kind: 'default' }, projects, workspaces, sessions })
    ).toEqual({ workspace: workspaces[2], repositoryName: 'beta', hasRepositories: true });
  });

  it('a picked path is the target — the title follows the pick', () => {
    const target = resolveHomeTarget({
      pick: { kind: 'path', path: '/repo/alpha' },
      projects,
      workspaces,
      sessions,
    });
    expect(target.workspace?.id).toBe('ws-alpha');
    expect(target.repositoryName).toBe('alpha');
  });

  it('a picked path matches whatever spelling the platform wrote it in', () => {
    const target = resolveHomeTarget({
      pick: { kind: 'path', path: '/repo/alpha/' },
      projects,
      workspaces,
      sessions,
    });
    expect(target.workspace?.id).toBe('ws-alpha');
  });

  it('a path that does not resolve (yet, or any more) falls back to the default, not to no repository', () => {
    const target = resolveHomeTarget({
      pick: { kind: 'path', path: '/repo/just-added' },
      projects,
      workspaces,
      sessions,
    });
    expect(target.workspace?.id).toBe('ws-beta');
  });

  it('「不选仓库（临时对话）」 is no workspace, with repositories still there', () => {
    expect(
      resolveHomeTarget({ pick: { kind: 'unbound' }, projects, workspaces, sessions })
    ).toEqual({ workspace: null, repositoryName: null, hasRepositories: true });
  });

  it('with no repository at all there is nothing to default to', () => {
    expect(
      resolveHomeTarget({ pick: { kind: 'default' }, projects: [], workspaces: [], sessions: [] })
    ).toEqual({ workspace: null, repositoryName: null, hasRepositories: false });
  });
});

describe('resolveHomeDraftBranch', () => {
  const alpha = workspaces[0] as ChatWorkspace;

  it('applies to the checkout it was picked in only', () => {
    const branch = { workdir: '/repo/alpha', name: 'feature/home', create: false };
    expect(resolveHomeDraftBranch({ branch, workspace: alpha })).toBe(branch);
    expect(
      resolveHomeDraftBranch({ branch, workspace: workspaces[2] as ChatWorkspace })
    ).toBeNull();
    expect(resolveHomeDraftBranch({ branch, workspace: null })).toBeNull();
  });

  it('a pick of the branch the checkout is already on is no switch at all', () => {
    expect(
      resolveHomeDraftBranch({
        branch: { workdir: '/repo/alpha', name: 'main', create: false },
        workspace: alpha,
      })
    ).toBeNull();
  });

  it('a branch to create is kept even if the name matches', () => {
    const branch = { workdir: '/repo/alpha', name: 'main', create: true };
    expect(resolveHomeDraftBranch({ branch, workspace: alpha })).toBe(branch);
  });
});

describe('planHomeBranchSwitch (what the home send does before it makes the conversation)', () => {
  const draft = { workdir: '/repo/alpha', name: 'feature/home', create: false };

  it('nothing without a draft, whatever the lock', () => {
    expect(planHomeBranchSwitch({ draft: null, lock: null })).toEqual({ kind: 'none' });
    expect(planHomeBranchSwitch({ draft: null, lock: 'checkout-busy' })).toEqual({ kind: 'none' });
  });

  it('switches when the checkout is free', () => {
    expect(planHomeBranchSwitch({ draft, lock: null })).toEqual({
      kind: 'switch',
      workdir: '/repo/alpha',
      branch: 'feature/home',
      create: false,
    });
    expect(planHomeBranchSwitch({ draft: { ...draft, create: true }, lock: null })).toMatchObject({
      kind: 'switch',
      create: true,
    });
  });

  it('is blocked — nothing sent, nothing switched — under either lock', () => {
    expect(planHomeBranchSwitch({ draft, lock: 'checkout-busy' })).toEqual({
      kind: 'blocked',
      branch: 'feature/home',
    });
    expect(planHomeBranchSwitch({ draft, lock: 'session-running' })).toEqual({
      kind: 'blocked',
      branch: 'feature/home',
    });
  });

  it('drops a draft the column no longer offers (not a local git checkout)', () => {
    expect(planHomeBranchSwitch({ draft, lock: 'no-checkout' })).toEqual({ kind: 'none' });
  });
});
