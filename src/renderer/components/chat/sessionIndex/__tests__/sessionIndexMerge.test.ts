import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { describe, expect, it } from 'vitest';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { mergeSessionIndex, recentSessionIdsFromIndex } from '../sessionIndexMerge';

// Both index writers (`chat:createSession` and `chat:registerSession`) stamp
// `agent: 'pi'`, so every row this build persists carries the binding. A row
// without one predates the field and is deliberately hidden — see the
// dedicated describe block at the bottom of this file.
function entry(sessionId: string, opts: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    sessionId,
    workspacePath: '/repo',
    title: sessionId,
    updatedAt: 1000,
    archived: false,
    agent: 'pi',
    ...opts,
  };
}

function session(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'p1',
    workspaceId: 'ws-1',
    title: id,
    status: 'idle',
    updatedAt: 1000,
    ...extra,
  };
}

const workspaces: ChatWorkspace[] = [
  { id: 'ws-1', projectId: 'p1', name: 'Main', kind: 'main', path: '/repo' },
  { id: 'ws-2', projectId: 'p1', name: 'feat', kind: 'worktree', path: '/repo-wt' },
];

describe('mergeSessionIndex (T-02)', () => {
  it('preserves UI-live status/runtimeIdentity when entry also exists', () => {
    const live = [session('s1', { status: 'running', runtimeIdentity: 'rt-live', updatedAt: 500 })];
    const entries = [entry('s1', { runtimeIdentity: 'rt-persisted', updatedAt: 900 })];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions[0].status).toBe('running');
    expect(sessions[0].runtimeIdentity).toBe('rt-live');
    expect(sessions[0].updatedAt).toBe(900);
  });

  it('persists title wins over UI placeholder title', () => {
    const live = [session('s1', { title: 'Session 1' })];
    const entries = [entry('s1', { title: 'My real name' })];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions[0].title).toBe('My real name');
  });

  it('fills runtimeIdentity from entry when UI has none yet', () => {
    const live = [session('s1', { runtimeIdentity: undefined })];
    const entries = [entry('s1', { runtimeIdentity: 'persisted-rt' })];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions[0].runtimeIdentity).toBe('persisted-rt');
  });

  it('archives entry filtered out of live list', () => {
    const live = [session('s1'), session('s2')];
    const entries = [entry('s1'), entry('s2', { archived: true })];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('seeds a new entry (no live sentence) using seedStatus and workspace mapping by path', () => {
    const entries = [entry('new-persistent', { workspacePath: '/repo-wt' })];
    const { sessions } = mergeSessionIndex([], entries, { workspaces, seedStatus: 'idle' });
    expect(sessions[0]).toMatchObject({
      id: 'new-persistent',
      projectId: 'p1',
      workspaceId: 'ws-2',
      status: 'idle',
    });
  });

  it('orphans entries with unknown workspacePath into orphaned[] (not seeded blindly)', () => {
    const entries = [entry('ghost', { workspacePath: '/somewhere-else' })];
    const { sessions, orphaned } = mergeSessionIndex([], entries, { workspaces });
    expect(sessions).toEqual([]);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe('ghost');
  });

  it('keeps live-only sessions (freshly New, not persisted) between refreshes', () => {
    const live = [session('fresh-new', { updatedAt: 5 })];
    const entries = [entry('s1')];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions.map((s) => s.id).sort()).toEqual(['fresh-new', 's1']);
  });

  // R5 D2: the live-only keep-alive is a safety net, not a removal blocker.
  it('does not resurrect a live-only session the renderer removed (Archive fallback / Close)', () => {
    const live = [session('kept')];
    const entries = [entry('kept')];
    // 'removed' is in neither list — the merge must not invent it back.
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions.map((s) => s.id)).toEqual(['kept']);
  });

  it('drops the live row as soon as its entry carries the archived bit', () => {
    const live = [session('fresh', { status: 'idle' })];
    const entries = [entry('fresh', { archived: true })];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions).toEqual([]);
  });

  it('recentSessionIdsFromIndex: updatedAt desc, dedup, limit', () => {
    const sessions = [
      session('a', { updatedAt: 1 }),
      session('b', { updatedAt: 30 }),
      session('c', { updatedAt: 20 }),
    ];
    expect(recentSessionIdsFromIndex(sessions, 2)).toEqual(['b', 'c']);
  });
});

// Round-6 review M3: workspacesByPath keys by canonicalPathKey (raw keys
// missed `/repo/` vs `/repo` and case drift) and prefers the
// registered-folder identity when one directory backs two workspaces.
describe('mergeSessionIndex — canonical path matching (round-6 review M3)', () => {
  it('binds entry.workspacePath with a trailing slash or case drift to the canonical workspace', () => {
    const entries = [entry('new-1', { workspacePath: '/REPO/' })];
    const { sessions } = mergeSessionIndex([], entries, { workspaces });
    expect(sessions[0]).toMatchObject({ id: 'new-1', projectId: 'p1', workspaceId: 'ws-1' });
  });

  it('binds a new seed to the main workspace when the path backs two identities, either array order', () => {
    const dualPath = '/aaa';
    const dualWorkspacesWorktreeFirst: ChatWorkspace[] = [
      { id: 'ws-worktree', projectId: 'p-parent', name: 'aaa', kind: 'worktree', path: dualPath },
      { id: 'ws-main', projectId: 'p-aaa', name: 'Main', kind: 'main', path: dualPath },
    ];
    const dualWorkspacesMainFirst: ChatWorkspace[] = [
      { id: 'ws-main', projectId: 'p-aaa', name: 'Main', kind: 'main', path: dualPath },
      { id: 'ws-worktree', projectId: 'p-parent', name: 'aaa', kind: 'worktree', path: dualPath },
    ];

    for (const dualWorkspaces of [dualWorkspacesWorktreeFirst, dualWorkspacesMainFirst]) {
      const entries = [entry('new-dual', { workspacePath: dualPath })];
      const { sessions } = mergeSessionIndex([], entries, { workspaces: dualWorkspaces });
      expect(sessions[0]).toMatchObject({
        id: 'new-dual',
        projectId: 'p-aaa',
        workspaceId: 'ws-main',
      });
    }
  });
});

/**
 * Regression: `recordCreated` persists `title: ''` until an explicit rename, so
 * every merge branch has to survive an empty persisted title. Before the guard,
 * the empty value clobbered the UI seed and every LeftNav row rendered with only
 * a status badge — and the title-substring search matched nothing.
 */
describe('mergeSessionIndex — empty persisted title never blanks a row', () => {
  it('keeps the UI seed title when the persisted entry has none', () => {
    const live = [session('s1', { title: 'New chat' })];
    const entries = [entry('s1', { title: '' })];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions[0].title).toBe('New chat');
  });

  it('falls back to a short-id placeholder when both sides are empty', () => {
    const live = [session('abcdef123456', { title: '' })];
    const entries = [entry('abcdef123456', { title: '' })];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions[0].title).toBe('Session 123456');
  });

  it('seeds a restored entry with a placeholder rather than an empty title', () => {
    const entries = [entry('restored-after-restart', { title: '' })];
    const { sessions } = mergeSessionIndex([], entries, { workspaces });
    expect(sessions[0].title).toBe('Session estart');
    expect(sessions[0].title).not.toBe('');
  });

  it('gives orphaned entries a placeholder title too', () => {
    const entries = [entry('ghost1', { title: '', workspacePath: '/somewhere-else' })];
    const { orphaned } = mergeSessionIndex([], entries, { workspaces });
    expect(orphaned[0].title).toBe('Session ghost1');
  });

  it('still lets a real persisted title win over the UI seed', () => {
    const live = [session('s1', { title: 'New chat' })];
    const entries = [entry('s1', { title: 'Renamed by user' })];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions[0].title).toBe('Renamed by user');
  });
});

/**
 * U13 (D04) — an unbound chat's `workspacePath` is a scratch directory, which
 * matches no workspace on purpose. Before the marker existed it fell through
 * to `orphaned` and disappeared from the sidebar on every restart, with its
 * history still on disk and no way back in.
 */
describe('mergeSessionIndex — unbound rows (U13)', () => {
  const scratch = '/tmp/unbound-sessions/abc';

  it('keeps a marked row as a session and carries its scratch path', () => {
    const entries = [entry('u1', { workspacePath: scratch, unbound: true })];
    const { sessions, orphaned } = mergeSessionIndex([], entries, { workspaces });
    expect(orphaned).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'u1',
      workspaceId: '',
      projectId: '',
      unbound: { workspacePath: scratch },
    });
  });

  it('leaves an unmarked orphan exactly as before (removed folder)', () => {
    const entries = [entry('ghost', { workspacePath: '/somewhere-else' })];
    const { sessions, orphaned } = mergeSessionIndex([], entries, { workspaces });
    expect(sessions).toEqual([]);
    expect(orphaned.map((s) => s.id)).toEqual(['ghost']);
  });

  it('leaves a pre-U13 row (scratch path, no marker) dropped rather than guessed', () => {
    const entries = [entry('legacy', { workspacePath: scratch })];
    const { sessions, orphaned } = mergeSessionIndex([], entries, { workspaces });
    expect(sessions).toEqual([]);
    expect(orphaned.map((s) => s.id)).toEqual(['legacy']);
  });

  it('marks a live row whose index entry says unbound', () => {
    const live = [session('u1', { status: 'running' })];
    const entries = [entry('u1', { workspacePath: scratch, unbound: true })];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions[0].status).toBe('running');
    expect(sessions[0].unbound).toEqual({ workspacePath: scratch });
  });

  it('clears the marker when the row moves to a real folder', () => {
    const live = [session('u1', { unbound: { workspacePath: scratch } })];
    const entries = [entry('u1', { workspacePath: '/repo' })];
    const { sessions } = mergeSessionIndex(live, entries, { workspaces });
    expect(sessions[0].unbound).toBeUndefined();
    expect(sessions[0].workspaceId).toBe('ws-1');
  });

  it('does not mark a row that claims unbound without a path', () => {
    const entries = [entry('u1', { workspacePath: '', unbound: true })];
    const { sessions, orphaned } = mergeSessionIndex([], entries, { workspaces });
    expect(sessions).toEqual([]);
    expect(orphaned.map((s) => s.id)).toEqual(['u1']);
  });
});
