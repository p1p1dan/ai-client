/**
 * The composer target row's three columns: repository / branch / run location.
 *
 * These pin the two locks the row exists for — the conversation's own binding
 * and the CHECKOUT-level lock that no earlier control could express, because
 * nothing before this named the directory a conversation was actually in. Two
 * sessions can share one workspace, and `git checkout` rewrites every file in it.
 *
 * Also pinned: empty mode's branch column only appears once a repository is
 * selected, and it targets THAT repository's checkout (user ruling 2026-09-24);
 * the column exists only for a local git checkout; and the empty-state path
 * takes the same two locks as a live session.
 */

import { describe, expect, it } from 'vitest';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { buildBranchColumn, buildRepoColumn } from '../composerColumns';
import { isSessionBusy } from '../composerTarget';

function project(overrides: Partial<ChatProject> = {}): ChatProject {
  return { id: 'p1', name: 'myrepo', ...overrides };
}

function workspace(overrides: Partial<ChatWorkspace> = {}): ChatWorkspace {
  return {
    id: 'w1',
    projectId: 'p1',
    name: 'main',
    kind: 'main',
    path: '/home/pi/code/myrepo',
    gitEnabled: true,
    ...overrides,
  };
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    projectId: 'p1',
    workspaceId: 'w1',
    title: 'chat',
    status: 'idle',
    updatedAt: 1,
    ...overrides,
  };
}

describe('isSessionBusy', () => {
  it('treats a missing status as idle', () => {
    expect(isSessionBusy(undefined)).toBe(false);
  });

  it('is true for every status that must lock the controls', () => {
    for (const status of [
      'starting',
      'running',
      'stopping',
      'waiting_permission',
      'waiting_question',
    ] as const) {
      expect(isSessionBusy(status), status).toBe(true);
    }
  });

  it('is false for the settled statuses', () => {
    for (const status of ['idle', 'completed', 'failed', 'disconnected'] as const) {
      expect(isSessionBusy(status), status).toBe(false);
    }
  });
});

describe('buildRepoColumn', () => {
  it('lists one entry per repository, labelled with the repository name', () => {
    const model = buildRepoColumn({
      projects: [project({ id: 'p1', name: 'alpha' }), project({ id: 'p2', name: 'beta' })],
      workspaces: [
        workspace({ id: 'w1', projectId: 'p1' }),
        workspace({ id: 'w2', projectId: 'p2', name: 'beta', path: '/code/beta' }),
      ],
      activeWorkspaceId: 'w1',
      mode: 'empty',
    });
    expect(model.entries.map((entry) => entry.label)).toEqual(['alpha', 'beta']);
  });

  it('targets the repository default workspace, preferring main over a worktree', () => {
    const model = buildRepoColumn({
      projects: [project({ id: 'p1' })],
      workspaces: [
        workspace({ id: 'w-worktree', kind: 'worktree', name: 'feat', path: '/code/feat' }),
        workspace({ id: 'w-main', kind: 'main', path: '/code/main' }),
      ],
      activeWorkspaceId: 'w-worktree',
      mode: 'empty',
    });
    expect(model.entries[0]?.workspaceId).toBe('w-main');
    expect(model.entries[0]?.path).toBe('/code/main');
  });

  it('marks current by repository, not by workspace id', () => {
    // The session sits in a worktree while the entry points at its main — the
    // question this column answers is "which repository", so it must still read
    // as the current one.
    const model = buildRepoColumn({
      projects: [project({ id: 'p1' })],
      workspaces: [
        workspace({ id: 'w-main', kind: 'main' }),
        workspace({ id: 'w-worktree', kind: 'worktree', path: '/code/feat' }),
      ],
      activeWorkspaceId: 'w-worktree',
      mode: 'empty',
    });
    expect(model.entries[0]?.current).toBe(true);
    expect(model.entries[0]?.workspaceId).toBe('w-main');
  });

  it('does not mark a repository current when a different one is active', () => {
    const model = buildRepoColumn({
      projects: [project({ id: 'p1', name: 'alpha' }), project({ id: 'p2', name: 'beta' })],
      workspaces: [
        workspace({ id: 'w1', projectId: 'p1' }),
        workspace({ id: 'w2', projectId: 'p2', name: 'beta', path: '/code/beta' }),
      ],
      activeWorkspaceId: 'w2',
      mode: 'empty',
    });
    expect(model.entries.map((entry) => entry.current)).toEqual([false, true]);
  });

  it('skips a repository with no targetable workspace instead of showing it unselectable', () => {
    const model = buildRepoColumn({
      projects: [project({ id: 'p1', name: 'empty' }), project({ id: 'p2', name: 'real' })],
      workspaces: [workspace({ id: 'w2', projectId: 'p2', name: 'real', path: '/code/real' })],
      activeWorkspaceId: 'w2',
      mode: 'empty',
    });
    expect(model.entries.map((entry) => entry.label)).toEqual(['real']);
  });

  it('collapses to zero entries when nothing is targetable', () => {
    const model = buildRepoColumn({
      projects: [project()],
      workspaces: [],
      activeWorkspaceId: null,
      mode: 'empty',
    });
    expect(model.entries).toEqual([]);
  });

  it('is a locked label in session mode, and reports the path the session is really in', () => {
    // The binding is made; changing it is a FORK (the sidebar and the
    // empty-state card own that). The path must be the SESSION's checkout, not
    // the repository's default one, or the branch column beside it would talk
    // about a different directory than the conversation is reading.
    const model = buildRepoColumn({
      projects: [project({ id: 'p1' })],
      workspaces: [
        workspace({ id: 'w-main', kind: 'main', path: '/code/main' }),
        workspace({ id: 'w-worktree', kind: 'worktree', path: '/code/feat' }),
      ],
      activeWorkspaceId: 'w-worktree',
      mode: 'session',
    });
    expect(model.locked).toBe(true);
    expect(model.currentLabel).toBe('myrepo');
    expect(model.currentPath).toBe('/code/feat');
  });

  it('is an unlocked control in empty mode', () => {
    const model = buildRepoColumn({
      projects: [project()],
      workspaces: [workspace()],
      activeWorkspaceId: 'w1',
      mode: 'empty',
    });
    expect(model.locked).toBe(false);
  });
});

describe('buildBranchColumn — session mode', () => {
  it('reports the active session checkout and its branch when idle', () => {
    const model = buildBranchColumn({
      sessions: [session({ status: 'idle' })],
      workspaces: [workspace({ branch: 'main' })],
      activeSessionId: 's1',
    });
    expect(model.workdir).toBe('/home/pi/code/myrepo');
    expect(model.currentBranch).toBe('main');
    expect(model.lock).toBeNull();
  });

  it('locks on the active session being mid-turn', () => {
    const model = buildBranchColumn({
      sessions: [session({ status: 'running' })],
      workspaces: [workspace({ branch: 'main' })],
      activeSessionId: 's1',
    });
    expect(model.lock).toBe('session-running');
  });

  it('locks on an in-flight send even before the status flips', () => {
    // ChatComposer latches `sending` before the store reports running; a
    // status-only check would leave a window where the switch looks allowed.
    const model = buildBranchColumn({
      sessions: [session({ status: 'idle' })],
      workspaces: [workspace({ branch: 'main' })],
      activeSessionId: 's1',
      sending: true,
    });
    expect(model.lock).toBe('session-running');
  });

  it('locks when a PEER conversation is running in the same checkout', () => {
    // The lock the old single-dropdown layout could not express: an idle
    // conversation must not let a switch rewrite the tree a peer is reading.
    const model = buildBranchColumn({
      sessions: [
        session({ id: 's1', status: 'idle' }),
        session({ id: 's2', workspaceId: 'w1', status: 'running' }),
      ],
      workspaces: [workspace({ branch: 'main' })],
      activeSessionId: 's1',
    });
    expect(model.lock).toBe('checkout-busy');
  });

  it('does not lock on a peer running in a DIFFERENT checkout', () => {
    const model = buildBranchColumn({
      sessions: [
        session({ id: 's1', workspaceId: 'w1', status: 'idle' }),
        session({ id: 's2', workspaceId: 'w2', status: 'running' }),
      ],
      workspaces: [
        workspace({ id: 'w1', branch: 'main' }),
        workspace({ id: 'w2', path: '/code/other', branch: 'other' }),
      ],
      activeSessionId: 's1',
    });
    expect(model.lock).toBeNull();
    expect(model.workdir).toBe('/home/pi/code/myrepo');
  });

  it('locks on a peer in the same DIRECTORY even under another workspace id', () => {
    // One directory can back two workspaces (a parent repository's worktree
    // entry and a registered folder's own main). git does not care which id the
    // peer was opened under.
    const model = buildBranchColumn({
      sessions: [
        session({ id: 's1', workspaceId: 'w-main', status: 'idle' }),
        session({ id: 's2', workspaceId: 'w-alias', status: 'running' }),
      ],
      workspaces: [
        workspace({ id: 'w-main', path: '/code/aaa', branch: 'main' }),
        workspace({ id: 'w-alias', kind: 'worktree', path: '/code/aaa/', branch: 'main' }),
      ],
      activeSessionId: 's1',
    });
    expect(model.lock).toBe('checkout-busy');
  });

  it('prefers the active session lock over the peer lock when both apply', () => {
    const model = buildBranchColumn({
      sessions: [
        session({ id: 's1', status: 'running' }),
        session({ id: 's2', workspaceId: 'w1', status: 'running' }),
      ],
      workspaces: [workspace({ branch: 'main' })],
      activeSessionId: 's1',
    });
    expect(model.lock).toBe('session-running');
  });

  it('does not fall back to the empty-mode checkout when the session has one but it is unusable', () => {
    // A session exists, so the fallback must NOT apply — reporting the
    // repository default here would offer a switch in a directory this
    // conversation is not in.
    const model = buildBranchColumn({
      sessions: [session({ workspaceId: 'w-broken', status: 'idle' })],
      workspaces: [
        workspace({ id: 'w-broken', path: '' }),
        workspace({ id: 'w-fallback', path: '/code/fallback', branch: 'other' }),
      ],
      activeSessionId: 's1',
      fallbackWorkspaceId: 'w-fallback',
    });
    expect(model.lock).toBe('no-checkout');
    expect(model.workdir).toBeNull();
  });

  it('keeps the branch null rather than guessing when the checkout is detached', () => {
    // `ChatWorkspace.branch` is absent for detached HEAD and temp workspaces;
    // the column shows no branch name instead of inventing one.
    const model = buildBranchColumn({
      sessions: [session({ status: 'idle' })],
      workspaces: [workspace({ branch: undefined })],
      activeSessionId: 's1',
    });
    expect(model.currentBranch).toBeNull();
    expect(model.lock).toBeNull();
  });
});

describe('buildBranchColumn — empty mode', () => {
  it('hides the column when no repository is selected', () => {
    const model = buildBranchColumn({
      sessions: [],
      workspaces: [workspace()],
      activeSessionId: null,
      fallbackWorkspaceId: null,
    });
    expect(model).toEqual({ workdir: null, currentBranch: null, lock: 'no-checkout' });
  });

  it('targets the SELECTED repository checkout, unlocked when nothing runs there', () => {
    // The control the old layout lacked entirely: picking a branch before the
    // first message.
    const model = buildBranchColumn({
      sessions: [],
      workspaces: [
        workspace({ id: 'w1', path: '/code/alpha', branch: 'main' }),
        workspace({ id: 'w2', projectId: 'p2', path: '/code/beta', branch: 'develop' }),
      ],
      activeSessionId: null,
      fallbackWorkspaceId: 'w2',
    });
    expect(model.workdir).toBe('/code/beta');
    expect(model.currentBranch).toBe('develop');
    expect(model.lock).toBeNull();
  });

  it('hides the column when the selected repository has no usable checkout', () => {
    const model = buildBranchColumn({
      sessions: [],
      workspaces: [workspace({ id: 'w1', path: '' })],
      activeSessionId: null,
      fallbackWorkspaceId: 'w1',
    });
    expect(model.lock).toBe('no-checkout');
  });

  it('locks when ANY conversation is running in the checkout it would switch', () => {
    // A new conversation lands on the repository's default checkout — the
    // directory where a peer is most likely running. A checkout there would
    // rewrite the tree under that peer.
    const model = buildBranchColumn({
      sessions: [session({ id: 's2', status: 'running' })],
      workspaces: [workspace({ branch: 'main' })],
      activeSessionId: null,
      fallbackWorkspaceId: 'w1',
    });
    expect(model.lock).toBe('checkout-busy');
    expect(model.workdir).toBe('/home/pi/code/myrepo');
  });

  it('does not lock on a conversation running in a DIFFERENT checkout', () => {
    const model = buildBranchColumn({
      sessions: [session({ id: 's2', workspaceId: 'w2', status: 'running' })],
      workspaces: [
        workspace({ id: 'w1', branch: 'main' }),
        workspace({ id: 'w2', kind: 'worktree', path: '/code/feat', branch: 'feat' }),
      ],
      activeSessionId: null,
      fallbackWorkspaceId: 'w1',
    });
    expect(model.lock).toBeNull();
  });

  it('locks while the first message is being sent, before any session status exists', () => {
    const model = buildBranchColumn({
      sessions: [],
      workspaces: [workspace({ branch: 'main' })],
      activeSessionId: null,
      fallbackWorkspaceId: 'w1',
      sending: true,
    });
    expect(model.lock).toBe('session-running');
  });

  it('keeps both locks on the fallback path of a session whose workspace is gone', () => {
    // The session exists but its workspace is not in the tree, so the column
    // falls back to the target checkout — the locks must come along with it.
    const orphan = session({ id: 's1', workspaceId: 'w-gone', status: 'running' });
    const running = buildBranchColumn({
      sessions: [orphan],
      workspaces: [workspace({ id: 'w1', branch: 'main' })],
      activeSessionId: 's1',
      fallbackWorkspaceId: 'w1',
    });
    expect(running.lock).toBe('session-running');

    const peerBusy = buildBranchColumn({
      sessions: [
        session({ id: 's1', workspaceId: 'w-gone', status: 'idle' }),
        session({ id: 's2', workspaceId: 'w1', status: 'waiting_permission' }),
      ],
      workspaces: [workspace({ id: 'w1', branch: 'main' })],
      activeSessionId: 's1',
      fallbackWorkspaceId: 'w1',
    });
    expect(peerBusy.lock).toBe('checkout-busy');
  });
});

describe('buildBranchColumn — only a local git checkout gets a branch column', () => {
  const notACheckout: Array<[string, Partial<ChatWorkspace>]> = [
    ['a temp workspace', { kind: 'temp', gitEnabled: true }],
    ['a remote workspace', { kind: 'remote', gitEnabled: true }],
    ['a folder that is not a git repository', { gitEnabled: false }],
    ['a folder whose git status is still unknown', { gitEnabled: undefined }],
  ];

  it.each(notACheckout)('hides the column for %s in session mode', (_, overrides) => {
    const model = buildBranchColumn({
      sessions: [session({ status: 'idle' })],
      workspaces: [workspace(overrides)],
      activeSessionId: 's1',
    });
    expect(model).toEqual({ workdir: null, currentBranch: null, lock: 'no-checkout' });
  });

  it.each(notACheckout)('hides the column for %s in empty mode', (_, overrides) => {
    const model = buildBranchColumn({
      sessions: [],
      workspaces: [workspace(overrides)],
      activeSessionId: null,
      fallbackWorkspaceId: 'w1',
    });
    expect(model).toEqual({ workdir: null, currentBranch: null, lock: 'no-checkout' });
  });

  it('shows it for a linked worktree that git knows about', () => {
    const model = buildBranchColumn({
      sessions: [session({ workspaceId: 'w-wt', status: 'idle' })],
      workspaces: [workspace({ id: 'w-wt', kind: 'worktree', path: '/code/feat', branch: 'feat' })],
      activeSessionId: 's1',
    });
    expect(model.workdir).toBe('/code/feat');
    expect(model.currentBranch).toBe('feat');
  });
});
