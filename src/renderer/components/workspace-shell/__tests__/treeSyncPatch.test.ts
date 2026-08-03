import { beforeEach, describe, expect, it } from 'vitest';
import {
  markSessionDismissed,
  resetDismissedSessionRows,
} from '@/components/chat/sessionIndex/dismissedSessions';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { resolveTreeSyncPatch, type TreeSyncPrevState } from '../useSyncChatWorkspaceTree';

/**
 * R5 round-2 (A4): the workspace-tree sync used to re-seed a "Live Agent Host"
 * session on every tree signature change with no live row present, and to
 * overwrite `activeSessionId` from its own derivation. Both silently undid the
 * user's Close/Archive — the row came back (or the Composer jumped) the next
 * time a worktree list or a repo add changed the tree.
 */

const workspaces: ChatWorkspace[] = [
  { id: 'ws-main', projectId: 'p1', name: 'Main', kind: 'main', path: '/repo' },
  { id: 'ws-wt', projectId: 'p1', name: 'feat/x', kind: 'worktree', path: '/repo-wt' },
];

function session(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'p1',
    workspaceId: 'ws-main',
    title: id,
    status: 'idle',
    updatedAt: 1000,
    ...extra,
  };
}

function prevState(overrides: Partial<TreeSyncPrevState> = {}): TreeSyncPrevState {
  return {
    sessions: [],
    hostBoundSessionIds: [],
    activeSessionId: null,
    recentSessionIds: [],
    ...overrides,
  };
}

function patch(prev: TreeSyncPrevState) {
  return resolveTreeSyncPatch({ prev, workspaces, preferredWorkspaceId: 'ws-main' });
}

beforeEach(() => {
  resetDismissedSessionRows();
});

describe('resolveTreeSyncPatch — auto-seed gate', () => {
  it('seeds a Live session on a cold start (empty list, nothing dismissed yet)', () => {
    const result = patch(prevState());

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.title).toBe('Live Agent Host');
    expect(result.activeSessionId).toBe(result.sessions[0]?.id);
    expect(result.recentSessionIds).toEqual([result.sessions[0]?.id]);
  });

  it('never re-seeds after the user removed a row in this run', () => {
    markSessionDismissed('closed-one');

    const result = patch(prevState());

    // The user emptied the nav on purpose; a later tree change must not put a
    // session back behind their back.
    expect(result.sessions).toEqual([]);
    expect(result.activeSessionId).toBeNull();
    expect(result.recentSessionIds).toEqual([]);
  });

  it('does not seed while any session already exists', () => {
    const result = patch(prevState({ sessions: [session('s1')], activeSessionId: 's1' }));

    expect(result.sessions.map((item) => item.id)).toEqual(['s1']);
  });

  it('drops rows dismissed in this run from the write-back', () => {
    markSessionDismissed('s1');

    const result = patch(
      prevState({
        sessions: [session('s1'), session('s2')],
        recentSessionIds: ['s1', 's2'],
        activeSessionId: 's2',
      })
    );

    expect(result.sessions.map((item) => item.id)).toEqual(['s2']);
    expect(result.recentSessionIds).toEqual(['s2']);
  });
});

describe('resolveTreeSyncPatch — activeSessionId handover', () => {
  it('leaves a still-valid activeSessionId alone (does not undo a removal handover)', () => {
    // `removeSessionRow` just handed `active` over to s2; the sync's own
    // derivation would pick s1 (first row in the preferred workspace).
    const result = patch(
      prevState({ sessions: [session('s1'), session('s2')], activeSessionId: 's2' })
    );

    expect(result.activeSessionId).toBe('s2');
  });

  it('re-points active only when the previous one is gone', () => {
    const result = patch(
      prevState({ sessions: [session('s1'), session('s2')], activeSessionId: 'deleted' })
    );

    expect(result.activeSessionId).toBe('s1');
  });

  it('falls to the empty state instead of keeping a dangling active id', () => {
    markSessionDismissed('only');

    const result = patch(prevState({ sessions: [session('only')], activeSessionId: 'only' }));

    expect(result.sessions).toEqual([]);
    expect(result.activeSessionId).toBeNull();
  });

  it('never points active at a row that was filtered out', () => {
    markSessionDismissed('s1');

    const result = patch(
      prevState({ sessions: [session('s1'), session('s2')], activeSessionId: 's1' })
    );

    expect(result.activeSessionId).toBe('s2');
  });
});

describe('resolveTreeSyncPatch — same-path dual identity (round-6 review M3/N2)', () => {
  it('seeds the Live session onto the registered-folder main, not the parent worktree entry, when both share a path', () => {
    // D2's deliberate dual identity: one directory backs both the parent
    // project's `worktree` entry and the registered folder's own `main`.
    // preferredWorkspaceId is looked up by id (not path), so the seed must
    // land on whichever entry `preferredWorkspaceId` names — here the aaa
    // project's main — even though the parent's worktree entry for the same
    // path is listed first.
    const aaaPath = '/repo/aaa';
    const dualWorkspaces: ChatWorkspace[] = [
      {
        id: `ws:worktree:${aaaPath}`,
        projectId: 'p-parent',
        name: 'aaa',
        kind: 'worktree',
        path: aaaPath,
      },
      {
        id: `ws:main:${aaaPath}`,
        projectId: 'p-aaa',
        name: 'Main',
        kind: 'main',
        path: aaaPath,
      },
    ];

    const result = resolveTreeSyncPatch({
      prev: prevState(),
      workspaces: dualWorkspaces,
      preferredWorkspaceId: `ws:main:${aaaPath}`,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.workspaceId).toBe(`ws:main:${aaaPath}`);
    expect(result.sessions[0]?.projectId).toBe('p-aaa');
  });
});
