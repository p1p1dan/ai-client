import { describe, expect, it } from 'vitest';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import {
  buildSidebarFolders,
  buildUnboundFolder,
  chipForWorkspace,
  deriveRecentRows,
  formatRelativeAge,
  RECENT_DEFAULT_LIMIT,
  RECENT_WINDOW_MS,
  resolveActiveProjectId,
  resolveFolderClickActivation,
  resolveNewSessionTarget,
  resolveNewSessionWorkspaceId,
  UNBOUND_FOLDER_ID,
} from '../sidebarTree';

const NOW = 1_800_000_000_000;

const projects: ChatProject[] = [
  { id: 'p-ai', name: 'ai-client' },
  { id: 'p-empty', name: 'newhp' },
];

const workspaces: ChatWorkspace[] = [
  { id: 'ws-main', projectId: 'p-ai', name: 'Main', kind: 'main', path: '/repo', branch: 'main' },
  {
    id: 'ws-wt',
    projectId: 'p-ai',
    name: 'feat/x',
    kind: 'worktree',
    path: '/repo-wt',
    branch: 'feat/x',
  },
  { id: 'ws-empty', projectId: 'p-empty', name: 'Main', kind: 'main', path: '/newhp' },
  { id: 'ws-temp', projectId: 'p-temp', name: 'Scratch', kind: 'temp', path: '/tmp/scratch' },
];

function session(overrides: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    projectId: 'p-ai',
    workspaceId: 'ws-main',
    title: `Session ${overrides.id}`,
    status: 'idle',
    updatedAt: NOW,
    ...overrides,
  };
}

/** Shared by the folder-click / active-project describes below: builds the
 * one folder under test through the real `buildSidebarFolders`, so its
 * `rows` are genuinely `updatedAt`-desc sorted the way the sidebar renders
 * them (resolveFolderClickActivation's `rows[0]` precondition). */
function folderOf(projectId: string, sessions: ChatSession[]) {
  const built = buildSidebarFolders({
    projects: [...projects, { id: projectId, name: projectId }].filter(
      (project, index, all) => all.findIndex((p) => p.id === project.id) === index
    ),
    workspaces,
    sessions,
  });
  const folder = built.find((f) => f.projectId === projectId);
  if (!folder) {
    throw new Error(`folder ${projectId} not built`);
  }
  return folder;
}

describe('buildSidebarFolders', () => {
  it('merges sessions across worktrees of one project into the same folder node', () => {
    const folders = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [
        session({ id: 's-main', workspaceId: 'ws-main', updatedAt: NOW - 1000 }),
        session({ id: 's-wt', workspaceId: 'ws-wt', updatedAt: NOW }),
      ],
    });

    const aiFolder = folders.find((folder) => folder.projectId === 'p-ai');
    expect(aiFolder?.rows.map((row) => row.sessionId)).toEqual(['s-wt', 's-main']);
  });

  it('drops orphan sessions without crashing or fabricating folders', () => {
    const folders = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [
        session({ id: 's-orphan', workspaceId: 'ws-gone' }),
        // Workspace exists but points at an unregistered project: also orphan.
        session({ id: 's-temp', workspaceId: 'ws-temp' }),
      ],
    });

    expect(folders.map((folder) => folder.projectId)).toEqual(['p-ai', 'p-empty']);
    expect(folders.every((folder) => folder.rows.length === 0)).toBe(true);
  });

  it('filters by session title only — folder and branch names never match', () => {
    const folders = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [
        session({ id: 's-hit', title: 'refactor sidebar' }),
        // Title misses; its branch (feat/x) and folder (ai-client) must not hit.
        session({ id: 's-miss', title: 'other work', workspaceId: 'ws-wt' }),
      ],
      query: 'ai-client',
    });

    expect(folders.flatMap((folder) => folder.rows)).toEqual([]);

    const byTitle = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [
        session({ id: 's-hit', title: 'refactor sidebar' }),
        session({ id: 's-miss', title: 'other work', workspaceId: 'ws-wt' }),
      ],
      query: 'SIDEBAR',
    });
    expect(byTitle.flatMap((folder) => folder.rows.map((row) => row.sessionId))).toEqual(['s-hit']);
  });

  it('keeps empty folders visible with a usable new-session target', () => {
    const folders = buildSidebarFolders({ projects, workspaces, sessions: [] });
    const empty = folders.find((folder) => folder.projectId === 'p-empty');
    expect(empty).toBeDefined();
    expect(empty?.rows).toEqual([]);
    expect(empty?.newSessionWorkspaceId).toBe('ws-empty');
  });

  it('groups by the workspace project, not a stale session.projectId', () => {
    const folders = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [session({ id: 's-stale', projectId: 'p-empty', workspaceId: 'ws-main' })],
    });
    expect(folders.find((f) => f.projectId === 'p-ai')?.rows).toHaveLength(1);
    expect(folders.find((f) => f.projectId === 'p-empty')?.rows).toHaveLength(0);
  });
});

describe('chipForWorkspace', () => {
  it('shows the actual branch for main and worktree workspaces (main/master included)', () => {
    expect(chipForWorkspace(workspaces[0])).toEqual({ variant: 'branch', label: 'main' });
    expect(chipForWorkspace(workspaces[1])).toEqual({ variant: 'branch', label: 'feat/x' });
  });

  it('never guesses: unknown branch on a real folder renders no chip', () => {
    expect(chipForWorkspace(workspaces[2])).toBeNull();
  });

  // U05-b ③ — "no folder" is a state the user can now be IN, not just a gap
  // on the way to picking one, so the session list has to say so.
  it('labels a chat with no folder as temporary', () => {
    expect(chipForWorkspace(undefined)).toEqual({ variant: 'kind', label: 'temporary' });
  });

  it('treats the empty-path placeholder as no folder too', () => {
    // What a fresh install actually sits on: a seeded workspace whose path is
    // deliberately empty so a fake cwd can never reach spawn.
    expect(
      chipForWorkspace({
        id: 'ws-seed',
        projectId: 'p-ai',
        name: 'Main',
        kind: 'main',
        path: '',
      })
    ).toEqual({ variant: 'kind', label: 'temporary' });
  });

  it('shows the kind label for temp and remote workspaces', () => {
    expect(chipForWorkspace(workspaces[3])).toEqual({ variant: 'kind', label: 'temp' });
    expect(
      chipForWorkspace({
        id: 'ws-r',
        projectId: 'p-r',
        name: 'srv',
        kind: 'remote',
        path: '/srv',
      })
    ).toEqual({ variant: 'kind', label: 'remote' });
  });
});

describe('resolveNewSessionWorkspaceId', () => {
  it('prefers the main workspace, skipping unusable empty-path seeds', () => {
    const seeded: ChatWorkspace[] = [
      { id: 'ws-seed', projectId: 'p-x', name: 'Main', kind: 'main', path: '' },
      { id: 'ws-real', projectId: 'p-x', name: 'feat/y', kind: 'worktree', path: '/wt' },
    ];
    expect(resolveNewSessionWorkspaceId('p-x', seeded)).toBe('ws-real');
    expect(resolveNewSessionWorkspaceId('p-x', workspaces)).toBeNull();
    expect(resolveNewSessionWorkspaceId('p-ai', workspaces)).toBe('ws-main');
  });
});

describe('resolveNewSessionTarget', () => {
  const folders = buildSidebarFolders({ projects, workspaces, sessions: [] });

  it('prefers the focused folder over the active session', () => {
    const target = resolveNewSessionTarget({
      focusedProjectId: 'p-empty',
      folders,
      activeSession: { workspaceId: 'ws-main' },
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-empty', folderName: 'newhp' });
  });

  it('falls back to the active session workspace when nothing is focused', () => {
    const target = resolveNewSessionTarget({
      focusedProjectId: null,
      folders,
      activeSession: { workspaceId: 'ws-wt' },
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-wt', folderName: 'ai-client' });
  });

  it('falls back to the first usable workspace when both focus and active session are absent', () => {
    const target = resolveNewSessionTarget({
      focusedProjectId: null,
      folders,
      activeSession: undefined,
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-main', folderName: 'ai-client' });
  });

  it('self-heals when the focused folder was deleted, falling through to the next tier', () => {
    const target = resolveNewSessionTarget({
      focusedProjectId: 'p-deleted',
      folders,
      activeSession: { workspaceId: 'ws-wt' },
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-wt', folderName: 'ai-client' });
  });

  // R5 round-2 (B1): every fallback target must still be reachable in the nav.
  it('skips an active session whose workspace no longer exists', () => {
    const target = resolveNewSessionTarget({
      focusedProjectId: null,
      folders,
      activeSession: { workspaceId: 'ws-deleted' },
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-main', folderName: 'ai-client' });
  });

  it('skips an active session whose project has no folder row (orphan workspace)', () => {
    // `ws-temp` belongs to `p-temp`, which is not in `projects` — creating a
    // chat there would land in a folder the sidebar never renders.
    const target = resolveNewSessionTarget({
      focusedProjectId: null,
      folders,
      activeSession: { workspaceId: 'ws-temp' },
      workspaces,
    });
    expect(target).toEqual({ workspaceId: 'ws-main', folderName: 'ai-client' });
  });

  it('disables the button (null target) when the focused folder has no usable workspace', () => {
    const seedProjects: ChatProject[] = [...projects, { id: 'p-seed', name: 'seed-repo' }];
    const seedWorkspaces: ChatWorkspace[] = [
      ...workspaces,
      { id: 'ws-seed', projectId: 'p-seed', name: 'Main', kind: 'main', path: '' },
    ];
    const seedFolders = buildSidebarFolders({
      projects: seedProjects,
      workspaces: seedWorkspaces,
      sessions: [],
    });

    const target = resolveNewSessionTarget({
      focusedProjectId: 'p-seed',
      folders: seedFolders,
      activeSession: { workspaceId: 'ws-main' },
      workspaces: seedWorkspaces,
    });

    // Falling through to `ws-main` would create the chat in a different folder
    // than the button's own title names — a silent redirect (D1).
    expect(target).toEqual({ workspaceId: null, folderName: 'seed-repo' });
  });

  it('skips orphan workspaces in the last-resort scan instead of taking the first one', () => {
    const orphanFirst: ChatWorkspace[] = [
      { id: 'ws-temp', projectId: 'p-temp', name: 'Scratch', kind: 'temp', path: '/tmp/scratch' },
      ...workspaces.filter((ws) => ws.id !== 'ws-temp'),
    ];

    const target = resolveNewSessionTarget({
      focusedProjectId: null,
      folders,
      activeSession: undefined,
      workspaces: orphanFirst,
    });

    expect(target).toEqual({ workspaceId: 'ws-main', folderName: 'ai-client' });
  });
});

describe('resolveFolderClickActivation (D29, open-q #28 A; F1/F5 adversarial-review fixes)', () => {
  it('activates the most recent session in the folder when the click crosses projects, forcing it open', () => {
    const folder = folderOf('p-ai', [
      session({ id: 's-old', workspaceId: 'ws-main', updatedAt: NOW - 5000 }),
      session({ id: 's-new', workspaceId: 'ws-wt', updatedAt: NOW }),
      session({ id: 's-mid', workspaceId: 'ws-main', updatedAt: NOW - 1000 }),
    ]);

    // F1: activation forces nextExpanded=true regardless of the prior state —
    // a cross-repo click must never leave the just-activated row collapsed.
    expect(
      resolveFolderClickActivation({ folder, activeProjectId: 'p-empty', currentExpanded: true })
    ).toEqual({ activateSessionId: 's-new', nextExpanded: true });
    expect(
      resolveFolderClickActivation({ folder, activeProjectId: 'p-empty', currentExpanded: false })
    ).toEqual({ activateSessionId: 's-new', nextExpanded: true });
    // Nothing active at all is also "a different project" — the click should
    // still land the user somewhere visible.
    expect(
      resolveFolderClickActivation({ folder, activeProjectId: null, currentExpanded: false })
    ).toEqual({ activateSessionId: 's-new', nextExpanded: true });
  });

  it('never hijacks a click inside the already-active project, and keeps the plain toggle', () => {
    const folder = folderOf('p-ai', [
      session({ id: 's-old', workspaceId: 'ws-main', updatedAt: NOW - 5000 }),
      session({ id: 's-new', workspaceId: 'ws-wt', updatedAt: NOW }),
    ]);

    expect(
      resolveFolderClickActivation({ folder, activeProjectId: 'p-ai', currentExpanded: true })
    ).toEqual({ activateSessionId: null, nextExpanded: false });
    expect(
      resolveFolderClickActivation({ folder, activeProjectId: 'p-ai', currentExpanded: false })
    ).toEqual({ activateSessionId: null, nextExpanded: true });
  });

  it('returns null for an empty folder instead of auto-creating a session, and keeps the plain toggle', () => {
    const folder = folderOf('p-empty', []);
    expect(folder.rows).toEqual([]);
    expect(
      resolveFolderClickActivation({ folder, activeProjectId: 'p-ai', currentExpanded: true })
    ).toEqual({ activateSessionId: null, nextExpanded: false });
    expect(
      resolveFolderClickActivation({ folder, activeProjectId: 'p-ai', currentExpanded: false })
    ).toEqual({ activateSessionId: null, nextExpanded: true });
    // The "New" affordance still points here — that path is untouched (D29 ④).
    expect(folder.newSessionWorkspaceId).toBe('ws-empty');
  });

  it('breaks an updatedAt tie toward rows[0], under the sorted-input precondition (F5)', () => {
    const tied = [
      session({ id: 's-first', workspaceId: 'ws-main', updatedAt: NOW }),
      session({ id: 's-second', workspaceId: 'ws-wt', updatedAt: NOW }),
    ];
    const folder = folderOf('p-ai', tied);
    // buildSidebarFolders sorts updatedAt desc with a stable sort, so the tie
    // keeps input order — and the resolver must agree with what is on screen.
    expect(folder.rows.map((row) => row.sessionId)).toEqual(['s-first', 's-second']);
    expect(
      resolveFolderClickActivation({ folder, activeProjectId: 'p-empty', currentExpanded: false })
        .activateSessionId
    ).toBe('s-first');

    // Same rule with the inputs reversed: the tie follows row order, never id
    // or workspace ordering.
    const reversed = folderOf('p-ai', [...tied].reverse());
    expect(reversed.rows.map((row) => row.sessionId)).toEqual(['s-second', 's-first']);
    expect(
      resolveFolderClickActivation({
        folder: reversed,
        activeProjectId: 'p-empty',
        currentExpanded: false,
      }).activateSessionId
    ).toBe('s-second');
  });

  it('treats Temp as an ordinary project — no special case', () => {
    const tempFolder = folderOf('p-temp', [
      session({ id: 's-temp', workspaceId: 'ws-temp', updatedAt: NOW }),
    ]);
    expect(
      resolveFolderClickActivation({
        folder: tempFolder,
        activeProjectId: 'p-ai',
        currentExpanded: false,
      })
    ).toEqual({ activateSessionId: 's-temp', nextExpanded: true });
    expect(
      resolveFolderClickActivation({
        folder: tempFolder,
        activeProjectId: 'p-temp',
        currentExpanded: true,
      })
    ).toEqual({ activateSessionId: null, nextExpanded: false });
  });
});

describe('resolveActiveProjectId (F3, D29 adversarial-review)', () => {
  it('resolves through the active session workspace, not a stale session.projectId', () => {
    expect(
      resolveActiveProjectId({
        activeSessionId: 's-stale',
        sessions: [session({ id: 's-stale', projectId: 'p-empty', workspaceId: 'ws-main' })],
        workspaces,
      })
    ).toBe('p-ai');
  });

  it('returns null when nothing is active', () => {
    expect(resolveActiveProjectId({ activeSessionId: null, sessions: [], workspaces })).toBeNull();
  });

  it('returns null for an orphan active session (workspace missing)', () => {
    expect(
      resolveActiveProjectId({
        activeSessionId: 's-orphan',
        sessions: [session({ id: 's-orphan', workspaceId: 'ws-gone' })],
        workspaces,
      })
    ).toBeNull();
  });

  // F4 (store-shape case): the active session sits on a DIFFERENT worktree of
  // the SAME project as the clicked folder (ws-wt vs ws-main, both p-ai) —
  // resolveActiveProjectId must still land on 'p-ai' through the workspace,
  // so the folder click resolves to "no switch", not a false activation.
  it('a worktree of the same project as the clicked folder resolves to no switch', () => {
    const aiFolder = folderOf('p-ai', [
      session({ id: 's-main', workspaceId: 'ws-main', updatedAt: NOW - 1000 }),
      session({ id: 's-wt', workspaceId: 'ws-wt', updatedAt: NOW }),
    ]);
    const activeProjectId = resolveActiveProjectId({
      activeSessionId: 's-wt',
      sessions: [
        session({ id: 's-main', workspaceId: 'ws-main' }),
        session({ id: 's-wt', workspaceId: 'ws-wt' }),
      ],
      workspaces,
    });
    expect(activeProjectId).toBe('p-ai');
    expect(
      resolveFolderClickActivation({
        folder: aiFolder,
        activeProjectId,
        currentExpanded: true,
      })
    ).toEqual({ activateSessionId: null, nextExpanded: false });
  });
});

describe('deriveRecentRows', () => {
  it('keeps busy sessions and sessions touched within 48h, newest first', () => {
    const { rows } = deriveRecentRows({
      sessions: [
        session({ id: 's-old-busy', status: 'running', updatedAt: NOW - RECENT_WINDOW_MS * 2 }),
        session({ id: 's-fresh', updatedAt: NOW - 1000 }),
        session({ id: 's-stale', updatedAt: NOW - RECENT_WINDOW_MS - 1 }),
      ],
      workspaces,
      now: NOW,
    });
    expect(rows.map((row) => row.sessionId)).toEqual(['s-fresh', 's-old-busy']);
    expect(rows[1]?.busy).toBe(true);
  });

  it('caps at 7 with a hidden count until showAll', () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      session({ id: `s-${i}`, updatedAt: NOW - i })
    );
    const capped = deriveRecentRows({ sessions, workspaces, now: NOW });
    expect(capped.rows).toHaveLength(RECENT_DEFAULT_LIMIT);
    expect(capped.hiddenCount).toBe(3);

    const all = deriveRecentRows({ sessions, workspaces, now: NOW, showAll: true });
    expect(all.rows).toHaveLength(10);
    expect(all.hiddenCount).toBe(0);
  });

  it('excludes orphan sessions like the folder tree does', () => {
    const { rows } = deriveRecentRows({
      sessions: [session({ id: 's-orphan', workspaceId: 'ws-gone' })],
      workspaces,
      now: NOW,
    });
    expect(rows).toEqual([]);
  });
});

describe('sidebar rows are Pi-only', () => {
  it('keeps branch chips without exposing a runtime chip', () => {
    const folders = buildSidebarFolders({
      projects,
      workspaces,
      sessions: [session({ id: 's1' }), session({ id: 's2', workspaceId: 'ws-wt' })],
    });
    const rows = folders.find((folder) => folder.projectId === 'p-ai')?.rows ?? [];

    expect(rows.map((row) => [row.sessionId, row.chip?.label ?? null])).toEqual([
      ['s1', 'main'],
      ['s2', 'feat/x'],
    ]);
    expect(rows.every((row) => !('agentChip' in row))).toBe(true);
  });
});

/**
 * U13 (D04) — temporary chats have no repository behind them, so they get one
 * synthetic group instead of being dropped with the genuine orphans.
 */
describe('buildUnboundFolder (U13)', () => {
  const unbound = { workspacePath: '/tmp/unbound-sessions/abc' };

  it('returns null when there is no unbound chat', () => {
    expect(buildUnboundFolder({ sessions: [session({ id: 's1' })], name: 'Temporary' })).toBeNull();
  });

  it('collects unbound chats newest first, with the temporary chip and no new-chat target', () => {
    const folder = buildUnboundFolder({
      sessions: [
        session({ id: 'old', workspaceId: '', unbound, updatedAt: NOW - 10_000 }),
        session({ id: 'new', workspaceId: '', unbound, updatedAt: NOW }),
      ],
      name: 'Temporary',
    });
    expect(folder?.projectId).toBe(UNBOUND_FOLDER_ID);
    expect(folder?.synthetic).toBe('unbound');
    expect(folder?.newSessionWorkspaceId).toBeNull();
    expect(folder?.rows.map((row) => row.sessionId)).toEqual(['new', 'old']);
    expect(folder?.rows.every((row) => row.chip?.label === 'temporary')).toBe(true);
  });

  it('applies the same title query as the repository folders', () => {
    const sessions = [
      session({ id: 's1', title: 'Draft plan', workspaceId: '', unbound }),
      session({ id: 's2', title: 'Other', workspaceId: '', unbound }),
    ];
    expect(
      buildUnboundFolder({ sessions, name: 'Temporary', query: 'draft' })?.rows.map(
        (row) => row.sessionId
      )
    ).toEqual(['s1']);
    expect(buildUnboundFolder({ sessions, name: 'Temporary', query: 'zzz' })).toBeNull();
  });

  it('never renders an unbound chat twice — the repository folders skip it', () => {
    // A store seed session the user typed into before adding any repository
    // keeps a real workspace id while being unbound.
    const seeded = session({ id: 's1', workspaceId: 'ws-main', unbound });
    const folders = buildSidebarFolders({ projects, workspaces, sessions: [seeded] });
    expect(folders.flatMap((folder) => folder.rows)).toEqual([]);
    expect(buildUnboundFolder({ sessions: [seeded], name: 'Temporary' })?.rows).toHaveLength(1);
  });

  it('keeps unbound chats in Recent, where a real orphan is still excluded', () => {
    const { rows } = deriveRecentRows({
      sessions: [
        session({ id: 'u1', workspaceId: '', unbound }),
        session({ id: 'gone', workspaceId: 'ws-removed' }),
      ],
      workspaces,
      now: NOW,
    });
    expect(rows.map((row) => row.sessionId)).toEqual(['u1']);
    expect(rows[0].chip?.label).toBe('temporary');
  });
});

describe('formatRelativeAge', () => {
  it('formats compact ages per range', () => {
    expect(formatRelativeAge(NOW - 5_000, NOW)).toBe('now');
    expect(formatRelativeAge(NOW + 5_000, NOW)).toBe('now');
    expect(formatRelativeAge(NOW - 90_000, NOW)).toBe('1m');
    expect(formatRelativeAge(NOW - 3 * 60 * 60_000, NOW)).toBe('3h');
    expect(formatRelativeAge(NOW - 5 * 24 * 60 * 60_000, NOW)).toBe('5d');
    expect(formatRelativeAge(NOW - 2 * 7 * 24 * 60 * 60_000, NOW)).toBe('2w');
    expect(formatRelativeAge(NOW - 3 * 30 * 24 * 60 * 60_000, NOW)).toBe('3mo');
    expect(formatRelativeAge(NOW - 2 * 365 * 24 * 60 * 60_000, NOW)).toBe('2y');
  });
});
