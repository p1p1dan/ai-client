import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { describe, expect, it } from 'vitest';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { mergeSessionIndex, recentSessionIdsFromIndex } from '../sessionIndexMerge';

function entry(sessionId: string, opts: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    sessionId,
    workspacePath: '/repo',
    title: sessionId,
    updatedAt: 1000,
    archived: false,
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

  it('recentSessionIdsFromIndex: updatedAt desc, dedup, limit', () => {
    const sessions = [
      session('a', { updatedAt: 1 }),
      session('b', { updatedAt: 30 }),
      session('c', { updatedAt: 20 }),
    ];
    expect(recentSessionIdsFromIndex(sessions, 2)).toEqual(['b', 'c']);
  });
});
