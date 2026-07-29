import { describe, expect, it } from 'vitest';
import {
  canCreateSessionOnWorkspace,
  countUsableWorkspaces,
  isUsableWorkspace,
  shouldShowAddRepositoryEmptyState,
} from '../addRepositoryEntry';

// Mirrors the chatSessions DEMO seed: real ids, empty paths.
const DEMO_PROJECTS = [{ id: 'project-demo' }];
const DEMO_WORKSPACES = [{ path: '' }, { path: '' }];
const DEMO_IDENTIFIED_WORKSPACES = [
  { id: 'ws-main', path: '' },
  { id: 'ws-worktree', path: '' },
];

describe('isUsableWorkspace', () => {
  it('accepts a workspace with a real path', () => {
    expect(isUsableWorkspace({ path: '/home/dan/projects/ai-client' })).toBe(true);
  });

  it('rejects empty and whitespace-only paths', () => {
    expect(isUsableWorkspace({ path: '' })).toBe(false);
    expect(isUsableWorkspace({ path: '   ' })).toBe(false);
  });
});

describe('countUsableWorkspaces', () => {
  it('counts only workspaces backed by a directory', () => {
    expect(countUsableWorkspaces([{ path: '/a' }, { path: '' }, { path: '/b' }])).toBe(2);
  });

  it('returns 0 for the demo seed', () => {
    expect(countUsableWorkspaces(DEMO_WORKSPACES)).toBe(0);
  });
});

describe('shouldShowAddRepositoryEmptyState', () => {
  it('shows the CTA when nothing has been derived yet', () => {
    expect(shouldShowAddRepositoryEmptyState([], [])).toBe(true);
  });

  it('shows the CTA on a fresh machine still holding the demo seed', () => {
    // Regression for plantree open-question #9: `projects.length === 0` is
    // false here, so the old check left the user with no entry point at all.
    expect(DEMO_PROJECTS.length).toBeGreaterThan(0);
    expect(shouldShowAddRepositoryEmptyState(DEMO_PROJECTS, DEMO_WORKSPACES)).toBe(true);
  });

  it('hides the CTA once a real repository is registered', () => {
    expect(
      shouldShowAddRepositoryEmptyState(
        [{ id: 'project:/home/dan/projects/ai-client' }],
        [{ path: '/home/dan/projects/ai-client' }]
      )
    ).toBe(false);
  });

  it('hides the CTA when only one of several workspaces is usable', () => {
    expect(
      shouldShowAddRepositoryEmptyState([{ id: 'p1' }], [{ path: '' }, { path: '/home/dan/repo' }])
    ).toBe(false);
  });
});

describe('canCreateSessionOnWorkspace', () => {
  it('allows a workspace backed by a real directory', () => {
    expect(
      canCreateSessionOnWorkspace('ws-1', [{ id: 'ws-1', path: '/home/dan/projects/ai-client' }])
    ).toBe(true);
  });

  it('refuses the demo seed fallback on a fresh machine', () => {
    // `workspaces[0]?.id` is a truthy id, so gating on the id alone left "New"
    // live while the add-repository empty state hid the resulting session.
    expect(DEMO_IDENTIFIED_WORKSPACES[0].id).toBeTruthy();
    expect(canCreateSessionOnWorkspace('ws-main', DEMO_IDENTIFIED_WORKSPACES)).toBe(false);
  });

  it('refuses a missing or unknown workspace id', () => {
    expect(canCreateSessionOnWorkspace(null, [{ id: 'ws-1', path: '/home/dan/repo' }])).toBe(false);
    expect(canCreateSessionOnWorkspace(undefined, [{ id: 'ws-1', path: '/home/dan/repo' }])).toBe(
      false
    );
    expect(canCreateSessionOnWorkspace('ws-gone', [{ id: 'ws-1', path: '/home/dan/repo' }])).toBe(
      false
    );
  });

  it('refuses an unusable workspace even when a usable sibling exists', () => {
    expect(
      canCreateSessionOnWorkspace('ws-empty', [
        { id: 'ws-empty', path: '' },
        { id: 'ws-real', path: '/home/dan/repo' },
      ])
    ).toBe(false);
  });
});
