import { beforeEach, describe, expect, it } from 'vitest';
import { useChatSessionsStore } from '../chatSessions';
import {
  openHome,
  preselectAddedRepository,
  resetHomeDraftForTests,
  useHomeDraftStore,
} from '../homeDraft';

/**
 * Decision 174 (GitHub issue #6, second wave): the home page's draft target.
 * Picking writes it and nothing else; the home page is "no conversation open".
 */

const branch = { workdir: '/repo/alpha', name: 'feature/home', create: false };

beforeEach(() => {
  resetHomeDraftForTests();
  useChatSessionsStore.setState({
    activeSessionId: 's1',
    sessions: [
      { id: 's1', projectId: 'p', workspaceId: 'w', title: 's1', status: 'running', updatedAt: 0 },
    ],
    unreadSessionIds: [],
  });
});

describe('useHomeDraftStore', () => {
  it('starts on the default target with no branch', () => {
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'default' });
    expect(useHomeDraftStore.getState().branch).toBeNull();
  });

  it('a new target drops the branch picked for the old one', () => {
    useHomeDraftStore.getState().setPick({ kind: 'path', path: '/repo/alpha' });
    useHomeDraftStore.getState().setBranch(branch);
    useHomeDraftStore.getState().setPick({ kind: 'path', path: '/repo/beta' });
    expect(useHomeDraftStore.getState().branch).toBeNull();
  });

  it('picking the same target again keeps the branch', () => {
    useHomeDraftStore.getState().setPick({ kind: 'path', path: '/repo/alpha' });
    useHomeDraftStore.getState().setBranch(branch);
    useHomeDraftStore.getState().setPick({ kind: 'path', path: '/repo/alpha/' });
    expect(useHomeDraftStore.getState().branch).toBe(branch);
  });
});

describe('openHome', () => {
  it('closes the conversation on screen without touching it', () => {
    openHome();
    const state = useChatSessionsStore.getState();
    expect(state.activeSessionId).toBeNull();
    // Still listed, still running: it is in 「正在活动」, one click away.
    expect(state.sessions.map((session) => session.id)).toEqual(['s1']);
    expect(state.sessions[0]?.status).toBe('running');
  });

  it('picks what the entry asks for, and keeps the user pick when it asks for nothing', () => {
    openHome({ kind: 'path', path: '/repo/alpha' });
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'path', path: '/repo/alpha' });
    openHome();
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'path', path: '/repo/alpha' });
    openHome({ kind: 'unbound' });
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'unbound' });
  });
});

describe('preselectAddedRepository', () => {
  it('on the home page, the repository just added becomes the target', () => {
    openHome();
    preselectAddedRepository('/repo/new');
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'path', path: '/repo/new' });
  });

  it('with a conversation open, the home page pick is left alone', () => {
    preselectAddedRepository('/repo/new');
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'default' });
  });
});
