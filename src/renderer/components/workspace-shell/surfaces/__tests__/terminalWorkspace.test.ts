import { describe, expect, it } from 'vitest';
import { resolveTerminalWorkspace, type TerminalWorkspaceSnapshot } from '../terminalWorkspace';

const BASE: TerminalWorkspaceSnapshot = {
  activeSessionId: 's1',
  sessions: [
    { id: 's1', workspaceId: 'w1' },
    { id: 's2', workspaceId: 'w2' },
  ],
  workspaces: [
    { id: 'w1', path: '/repo/main', kind: 'main' },
    { id: 'w2', path: '/repo/feature', kind: 'worktree' },
  ],
};

describe('resolveTerminalWorkspace', () => {
  it('resolves the active session to its workspace path', () => {
    expect(resolveTerminalWorkspace(BASE)).toEqual({
      status: 'ready',
      path: '/repo/main',
      isTemp: false,
    });
  });

  it('follows the active session rather than the first one', () => {
    expect(resolveTerminalWorkspace({ ...BASE, activeSessionId: 's2' })).toEqual({
      status: 'ready',
      path: '/repo/feature',
      isTemp: false,
    });
  });

  it('flags a temp workspace so the temp auto-create setting applies', () => {
    expect(
      resolveTerminalWorkspace({
        activeSessionId: 's1',
        sessions: [{ id: 's1', workspaceId: 'w1' }],
        workspaces: [{ id: 'w1', path: '/tmp/scratch', kind: 'temp' }],
      })
    ).toEqual({ status: 'ready', path: '/tmp/scratch', isTemp: true });
  });

  it('treats a remote workspace as ready — remote virtual paths are terminal cwds', () => {
    expect(
      resolveTerminalWorkspace({
        activeSessionId: 's1',
        sessions: [{ id: 's1', workspaceId: 'w1' }],
        workspaces: [{ id: 'w1', path: 'remote://host/srv/app', kind: 'remote' }],
      })
    ).toEqual({ status: 'ready', path: 'remote://host/srv/app', isTemp: false });
  });

  it('reports no-session when nothing is selected', () => {
    expect(resolveTerminalWorkspace({ ...BASE, activeSessionId: null })).toEqual({
      status: 'unavailable',
      reason: 'no-session',
    });
  });

  it('reports no-session when the selected id names no session', () => {
    expect(resolveTerminalWorkspace({ ...BASE, activeSessionId: 'gone' })).toEqual({
      status: 'unavailable',
      reason: 'no-session',
    });
  });

  it('reports no-workspace when the session points at a workspace that is gone', () => {
    expect(resolveTerminalWorkspace({ ...BASE, workspaces: [] })).toEqual({
      status: 'unavailable',
      reason: 'no-workspace',
    });
  });

  it('reports no-path for an empty or whitespace-only path', () => {
    for (const path of ['', '   ']) {
      expect(
        resolveTerminalWorkspace({
          activeSessionId: 's1',
          sessions: [{ id: 's1', workspaceId: 'w1' }],
          workspaces: [{ id: 'w1', path, kind: 'main' }],
        })
      ).toEqual({ status: 'unavailable', reason: 'no-path' });
    }
  });

  it('trims a padded path instead of spawning in a whitespace directory', () => {
    expect(
      resolveTerminalWorkspace({
        activeSessionId: 's1',
        sessions: [{ id: 's1', workspaceId: 'w1' }],
        workspaces: [{ id: 'w1', path: '  /repo/main  ', kind: 'main' }],
      })
    ).toEqual({ status: 'ready', path: '/repo/main', isTemp: false });
  });

  it('never falls back to another workspace when the right one is missing', () => {
    // A06: a terminal opened in the wrong directory is worse than no terminal.
    const result = resolveTerminalWorkspace({
      activeSessionId: 's1',
      sessions: [{ id: 's1', workspaceId: 'missing' }],
      workspaces: BASE.workspaces,
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'no-workspace' });
  });
});
