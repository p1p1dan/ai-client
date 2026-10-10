import { readFileSync } from 'node:fs';
import path from 'node:path';
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
 * time a worktree list or a repo add changed the tree. Decision 174 (issue #6)
 * took both out entirely: nothing is seeded, nothing is picked.
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
    messages: {},
    historyErrors: {},
    pendingPermissions: [],
    pendingQuestions: [],
    ...overrides,
  };
}

function patch(prev: TreeSyncPrevState) {
  return resolveTreeSyncPatch({ prev, workspaces, preferredWorkspaceId: 'ws-main' });
}

beforeEach(() => {
  resetDismissedSessionRows();
});

/**
 * Decision 174 (issue #6, second wave; user ruling 2026-10-10): the app opens on
 * the home page — no conversation at all. The start-up chat this pass used to
 * seed (and to rename out of the store's DEMO row) is gone, and so is "pick the
 * first conversation" when the open one goes away.
 */
describe('resolveTreeSyncPatch — no start-up chat (decision 174)', () => {
  it('seeds nothing on a cold start: the home page', () => {
    const result = patch(prevState());

    expect(result.sessions).toEqual([]);
    expect(result.activeSessionId).toBeNull();
    expect(result.recentSessionIds).toEqual([]);
  });

  it('seeds nothing after the user removed a row in this run either', () => {
    markSessionDismissed('closed-one');

    const result = patch(prevState());

    expect(result.sessions).toEqual([]);
    expect(result.activeSessionId).toBeNull();
    expect(result.recentSessionIds).toEqual([]);
  });

  it('drops the store DEMO rows instead of renaming one into a start-up chat', () => {
    const result = patch(
      prevState({
        sessions: [
          session('session-live', { title: 'Live Agent Host' }),
          session('session-welcome', { title: 'Welcome' }),
        ],
        activeSessionId: 'session-live',
        recentSessionIds: ['session-live', 'session-welcome'],
      })
    );

    expect(result.sessions).toEqual([]);
    expect(result.activeSessionId).toBeNull();
    expect(result.recentSessionIds).toEqual([]);
  });

  it('keeps a real conversation whose id merely starts like the old seed', () => {
    // Rows an older build saved from its start-up chat (`session-live-…`) are
    // ordinary conversations now; only the two DEMO ids themselves go.
    const saved = session('session-live-abc123', {
      title: 'Fix the build',
      runtimeIdentity: 'd-1',
    });
    const result = patch(prevState({ sessions: [saved] }));

    expect(result.sessions.map((item) => item.id)).toEqual(['session-live-abc123']);
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

  it('opens the home page when the previous one is gone — nothing is picked (decision 174)', () => {
    const result = patch(
      prevState({ sessions: [session('s1'), session('s2')], activeSessionId: 'deleted' })
    );

    expect(result.activeSessionId).toBeNull();
    expect(result.sessions.map((item) => item.id)).toEqual(['s1', 's2']);
  });

  it('falls to the empty state instead of keeping a dangling active id', () => {
    markSessionDismissed('only');

    const result = patch(prevState({ sessions: [session('only')], activeSessionId: 'only' }));

    expect(result.sessions).toEqual([]);
    expect(result.activeSessionId).toBeNull();
  });

  it('never points active at a row that was filtered out, and picks no other', () => {
    markSessionDismissed('s1');

    const result = patch(
      prevState({ sessions: [session('s1'), session('s2')], activeSessionId: 's1' })
    );

    expect(result.activeSessionId).toBeNull();
  });
});

describe('resolveTreeSyncPatch — empty workspace tree (T27-a)', () => {
  it('the hook writes an empty tree instead of returning before the store update', () => {
    const source = readFileSync(path.join(__dirname, '..', 'useSyncChatWorkspaceTree.ts'), 'utf8');

    expect(source).not.toMatch(/if \(tree\.workspaces\.length === 0\) \{\s*return;/);
    expect(source).toContain('projects: tree.projects');
    expect(source).toContain('workspaces: tree.workspaces');
  });

  it('clears sessions, selection, runtime bindings and every per-session bucket', () => {
    const result = resolveTreeSyncPatch({
      prev: prevState({
        sessions: [session('s1')],
        hostBoundSessionIds: ['s1'],
        activeSessionId: 's1',
        recentSessionIds: ['s1'],
        messages: { s1: [] },
        historyErrors: { s1: 'read failed' },
        pendingPermissions: [{ sessionId: 's1', permissionId: 'p1', messageId: 'm1' }],
        pendingQuestions: [{ sessionId: 's1', questionId: 'q1', messageId: 'm2' }],
      }),
      workspaces: [],
      preferredWorkspaceId: null,
    });

    expect(result).toEqual({
      sessions: [],
      hostBoundSessionIds: [],
      activeSessionId: null,
      recentSessionIds: [],
      messages: {},
      historyErrors: {},
      pendingPermissions: [],
      pendingQuestions: [],
    });
  });

  it('supports add → remove-last → re-add without retaining the old session or seeding one', () => {
    const added = patch(prevState({ sessions: [session('s1')], activeSessionId: 's1' }));
    expect(added.sessions.map((item) => item.id)).toEqual(['s1']);

    const removed = resolveTreeSyncPatch({
      prev: { ...prevState(), ...added },
      workspaces: [],
      preferredWorkspaceId: null,
    });
    expect(removed.sessions).toEqual([]);
    expect(removed.activeSessionId).toBeNull();

    // Decision 174: re-adding the repository brings back the home page, not a
    // fresh blank chat.
    const readded = patch({ ...prevState(), ...removed });
    expect(readded.sessions).toEqual([]);
    expect(readded.activeSessionId).toBeNull();
  });

  it('drops a restored runtime session when its repository disappears instead of rebinding it', () => {
    const restored = session('restored', {
      workspaceId: 'removed-workspace',
      projectId: 'removed-project',
      runtimeIdentity: 'pi-session-1',
    });

    const result = patch(
      prevState({
        sessions: [restored],
        activeSessionId: restored.id,
      })
    );

    expect(result.sessions).toEqual([]);
    expect(result.activeSessionId).toBeNull();
  });

  it('keeps only buckets belonging to sessions that survived a non-empty rebind', () => {
    const result = patch(
      prevState({
        sessions: [session('s1')],
        activeSessionId: 's1',
        messages: { s1: [], removed: [] },
        historyErrors: { s1: 'keep', removed: 'drop' },
        pendingPermissions: [
          { sessionId: 's1', permissionId: 'p1', messageId: 'm1' },
          { sessionId: 'removed', permissionId: 'p2', messageId: 'm2' },
        ],
        pendingQuestions: [{ sessionId: 'removed', questionId: 'q1', messageId: 'm3' }],
      })
    );

    expect(result.messages).toEqual({ s1: [] });
    expect(result.historyErrors).toEqual({ s1: 'keep' });
    expect(result.pendingPermissions).toEqual([
      { sessionId: 's1', permissionId: 'p1', messageId: 'm1' },
    ]);
    expect(result.pendingQuestions).toEqual([]);
  });
});

describe('resolveTreeSyncPatch — same-path dual identity (round-6 review M3/N2)', () => {
  it('rebinds an unsent draft onto the registered-folder main, not the parent worktree entry, when both share a path', () => {
    // D2's deliberate dual identity: one directory backs both the parent
    // project's `worktree` entry and the registered folder's own `main`.
    // preferredWorkspaceId is looked up by id (not path), so a rebound draft
    // must land on whichever entry `preferredWorkspaceId` names — here the aaa
    // project's main — even though the parent's worktree entry for the same
    // path is listed first. (Decision 174: this was the start-up chat's seat;
    // with no seed any more, the orphaned unsent draft is what lands there.)
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
      prev: prevState({ sessions: [session('draft', { workspaceId: 'ws-gone' })] }),
      workspaces: dualWorkspaces,
      preferredWorkspaceId: `ws:main:${aaaPath}`,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.workspaceId).toBe(`ws:main:${aaaPath}`);
    expect(result.sessions[0]?.projectId).toBe('p-aaa');
  });
});

/**
 * D6 (dev-box pass 2026-09-17) — temp chats left the sidebar mid-run and came
 * back after a restart.
 *
 * The two paths that rebuild the session list disagreed about unbound chats:
 * `mergeSessionIndex` has an explicit `!workspaceId && unbound` arm and keeps
 * the row, while this pass had none, so an unbound chat that had already run a
 * turn (and therefore carries a runtime identity) fell through to the orphan
 * rule and was dropped from the store. Every tree signature change triggered it
 * — a temp workspace added or removed, a worktree list arriving, the selected
 * repository changing — and only a restart brought the rows back, because the
 * startup path reads the index rows this pass never touched.
 */
describe('resolveTreeSyncPatch — unbound chats (D6)', () => {
  function unbound(id: string, extra: Partial<ChatSession> = {}): ChatSession {
    return session(id, {
      projectId: '',
      workspaceId: '',
      unbound: { workspacePath: `/tmp/JYWAI/temporary/unbound-sessions/${id}` },
      ...extra,
    });
  }

  it('keeps an unbound chat that has already run a turn', () => {
    const temp = unbound('session-temp', { runtimeIdentity: 'pi-1' });
    const result = patch(prevState({ sessions: [session('session-bound'), temp] }));

    expect(result.sessions.map((item) => item.id)).toEqual(['session-bound', 'session-temp']);
    // Still unbound: adopting it into the preferred repository would give a
    // scratch-directory chat a project cwd it never agreed to.
    expect(result.sessions.find((item) => item.id === 'session-temp')?.workspaceId).toBe('');
  });

  it('keeps an unbound chat that is currently Host-bound, and keeps it bound', () => {
    const temp = unbound('session-temp', { runtimeIdentity: 'pi-1' });
    const result = patch(prevState({ sessions: [temp], hostBoundSessionIds: ['session-temp'] }));

    expect(result.sessions.map((item) => item.id)).toContain('session-temp');
    expect(result.hostBoundSessionIds).toEqual(['session-temp']);
  });

  it('keeps a live unbound chat that has run but has no index row yet', () => {
    // `createUnboundChatSession` writes no `unbound` marker — it is set from the
    // index row, which does not exist until the first send commits and the next
    // refresh arrives. In that window the empty workspaceId is the only signal.
    const live = session('session-live-temp', {
      projectId: '',
      workspaceId: '',
      runtimeIdentity: 'pi-2',
    });
    const result = patch(prevState({ sessions: [live] }));

    expect(result.sessions.map((item) => item.id)).toEqual(['session-live-temp']);
    expect(result.sessions[0]?.workspaceId).toBe('');
  });

  it('keeps an unsent unbound draft unbound — no U22 adoption (decision 174)', () => {
    // U22 adopted it into the first repository the user added, because the
    // start screen's blank chat was the only way to talk before a repository
    // existed. The home page makes the conversation at send time on the target
    // the user picked, so a temporary chat never turns into a repository's.
    const draft = session('session-draft', { projectId: '', workspaceId: '' });
    const result = patch(prevState({ sessions: [draft] }));

    expect(result.sessions[0]?.workspaceId).toBe('');
    expect(result.sessions[0]?.projectId).toBe('');
  });

  it('keeps temporary chats through a sync with no workspace at all (decision 174)', () => {
    const temp = unbound('session-temp', { runtimeIdentity: 'pi-1' });
    const result = resolveTreeSyncPatch({
      prev: prevState({ sessions: [temp, session('s1')], activeSessionId: 'session-temp' }),
      workspaces: [],
      preferredWorkspaceId: null,
    });

    expect(result.sessions.map((item) => item.id)).toEqual(['session-temp']);
    expect(result.activeSessionId).toBe('session-temp');
  });

  it('still drops an orphan whose repository disappeared', () => {
    // The rule the new arm must not weaken: a session that DID have a workspace
    // and lost it keeps a runtime identity pointing at that checkout's cwd.
    const orphan = session('session-orphan', {
      workspaceId: 'ws-gone',
      runtimeIdentity: 'pi-3',
    });
    const result = patch(prevState({ sessions: [orphan] }));

    expect(result.sessions.map((item) => item.id)).not.toContain('session-orphan');
  });
});
