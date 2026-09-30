import { zhTranslations } from '@shared/i18n';
import { LEGACY_FORK_TITLE_KEY } from '@shared/types/legacyMigration';
import { describe, expect, it } from 'vitest';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import {
  buildSidebarFolders,
  buildUnboundFolder,
  chipForWorkspace,
  deriveActiveRows,
  deriveRecentRows,
  FOLDER_DEFAULT_LIMIT,
  formatRelativeAge,
  isWaitingSessionStatus,
  LEGACY_DIVERGED_HINT,
  limitFolderRows,
  RECENT_DEFAULT_LIMIT,
  RECENT_WINDOW_MS,
  resolveNewSessionTarget,
  resolveNewSessionWorkspaceId,
  resolveRecentCollapsed,
  splitBranchSuffix,
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

/** Builds the one folder under test through the real `buildSidebarFolders`,
 * so its `rows` are genuinely `updatedAt`-desc sorted the way the sidebar
 * renders them (the input `limitFolderRows` is given). */
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

describe('decision 137 §3: a folder header click no longer activates anything', () => {
  it('the D29 activation helpers are gone from the module', async () => {
    // The header's only effect is its own expansion entry (LeftNav). Pinned
    // here so a helper that decides "which session a folder click opens"
    // cannot quietly come back.
    const mod = (await import('../sidebarTree')) as Record<string, unknown>;
    expect(mod.resolveFolderClickActivation).toBeUndefined();
    expect(mod.resolveActiveProjectId).toBeUndefined();
  });
});

describe('resolveRecentCollapsed (decision 137 §2)', () => {
  it('starts collapsed when nothing was stored', () => {
    expect(resolveRecentCollapsed(null)).toBe(true);
  });

  it('remembers what the toggle wrote, under the same key as before', () => {
    expect(resolveRecentCollapsed('true')).toBe(true);
    expect(resolveRecentCollapsed('false')).toBe(false);
  });

  it('reads anything but an explicit expand as collapsed', () => {
    expect(resolveRecentCollapsed('')).toBe(true);
    expect(resolveRecentCollapsed('garbage')).toBe(true);
  });
});

describe('limitFolderRows (decision 137 §4)', () => {
  const rows = (count: number) =>
    folderOf(
      'p-ai',
      Array.from({ length: count }, (_, i) => session({ id: `s-${i}`, updatedAt: NOW - i }))
    ).rows;

  it('lists a folder of 8 or fewer rows whole, with nothing to toggle', () => {
    const limited = limitFolderRows({ rows: rows(8), showAll: false, queryActive: false });
    expect(limited.rows).toHaveLength(8);
    expect(limited).toMatchObject({ hiddenCount: 0, collapsible: false });
  });

  it('shows the first 8 and counts the rest behind "View more"', () => {
    const limited = limitFolderRows({ rows: rows(11), showAll: false, queryActive: false });
    expect(limited.rows.map((row) => row.sessionId)).toEqual(
      Array.from({ length: FOLDER_DEFAULT_LIMIT }, (_, i) => `s-${i}`)
    );
    expect(limited).toMatchObject({ hiddenCount: 3, collapsible: false });
  });

  it('lists everything once expanded, ending in "Show less"', () => {
    const limited = limitFolderRows({ rows: rows(11), showAll: true, queryActive: false });
    expect(limited.rows).toHaveLength(11);
    expect(limited).toMatchObject({ hiddenCount: 0, collapsible: true });
  });

  it('keeps the selected conversation visible below the cap, without counting it as hidden', () => {
    const limited = limitFolderRows({
      rows: rows(11),
      showAll: false,
      queryActive: false,
      activeSessionId: 's-9',
    });
    expect(limited.rows.map((row) => row.sessionId)).toEqual([
      ...Array.from({ length: FOLDER_DEFAULT_LIMIT }, (_, i) => `s-${i}`),
      's-9',
    ]);
    expect(limited.hiddenCount).toBe(2);
  });

  it('does not duplicate a selected conversation already inside the first 8', () => {
    const limited = limitFolderRows({
      rows: rows(11),
      showAll: false,
      queryActive: false,
      activeSessionId: 's-2',
    });
    expect(limited.rows).toHaveLength(FOLDER_DEFAULT_LIMIT);
    expect(limited.hiddenCount).toBe(3);
  });

  it('lists every match while a search is active', () => {
    const limited = limitFolderRows({ rows: rows(11), showAll: false, queryActive: true });
    expect(limited.rows).toHaveLength(11);
    expect(limited).toMatchObject({ hiddenCount: 0, collapsible: false });
  });
});

describe('deriveActiveRows (decision 137 §1)', () => {
  it('lists conversations started on the engine in this run, and nothing merely previewed', () => {
    const rows = deriveActiveRows({
      sessions: [
        session({ id: 's-bound', updatedAt: NOW - 5000 }),
        // Previewed: has a transcript identity but no binding, no turn.
        session({ id: 's-previewed', runtimeIdentity: '/x.dsh.json', updatedAt: NOW }),
      ],
      workspaces,
      hostBoundSessionIds: ['s-bound'],
    });
    expect(rows.map((row) => row.sessionId)).toEqual(['s-bound']);
  });

  it('adds any conversation running a turn, bound or not', () => {
    const rows = deriveActiveRows({
      sessions: [session({ id: 's-running', status: 'running' })],
      workspaces,
      hostBoundSessionIds: [],
    });
    expect(rows.map((row) => row.sessionId)).toEqual(['s-running']);
  });

  it('puts running turns first, then the rest by last activity', () => {
    const rows = deriveActiveRows({
      sessions: [
        session({ id: 's-idle-new', updatedAt: NOW }),
        session({ id: 's-running-old', status: 'running', updatedAt: NOW - 9000 }),
        session({ id: 's-waiting', status: 'waiting_permission', updatedAt: NOW - 5000 }),
        session({ id: 's-idle-old', updatedAt: NOW - 1000 }),
      ],
      workspaces,
      hostBoundSessionIds: ['s-idle-new', 's-running-old', 's-waiting', 's-idle-old'],
    });
    expect(rows.map((row) => row.sessionId)).toEqual([
      's-waiting',
      's-running-old',
      's-idle-new',
      's-idle-old',
    ]);
  });

  it('is empty when nothing is started, so the section can disappear', () => {
    expect(
      deriveActiveRows({ sessions: [session({ id: 's-a' })], workspaces, hostBoundSessionIds: [] })
    ).toEqual([]);
  });

  it('a conversation the pool reclaimed leaves with its binding', () => {
    const sessions = [session({ id: 's-a', status: 'disconnected' })];
    expect(deriveActiveRows({ sessions, workspaces, hostBoundSessionIds: ['s-a'] })).toHaveLength(
      1
    );
    expect(deriveActiveRows({ sessions, workspaces, hostBoundSessionIds: [] })).toEqual([]);
  });

  it('keeps a bound temporary chat and drops an orphan, like Recent', () => {
    const rows = deriveActiveRows({
      sessions: [
        session({ id: 's-temp', projectId: '', workspaceId: '' }),
        session({ id: 's-orphan', workspaceId: 'ws-gone' }),
      ],
      workspaces,
      hostBoundSessionIds: ['s-temp', 's-orphan'],
    });
    expect(rows.map((row) => row.sessionId)).toEqual(['s-temp']);
  });

  it('applies the title query, exempting the open conversation', () => {
    const sessions = [
      session({ id: 's-open', title: 'Untitled' }),
      session({ id: 's-hit', title: 'Parser rewrite' }),
      session({ id: 's-miss', title: 'Docs' }),
    ];
    const rows = deriveActiveRows({
      sessions,
      workspaces,
      hostBoundSessionIds: ['s-open', 's-hit', 's-miss'],
      query: 'parser',
      activeSessionId: 's-open',
    });
    expect(rows.map((row) => row.sessionId).sort()).toEqual(['s-hit', 's-open']);
  });
});

describe('isWaitingSessionStatus', () => {
  it('is the two statuses that park a turn on the user', () => {
    expect(isWaitingSessionStatus('waiting_permission')).toBe(true);
    expect(isWaitingSessionStatus('waiting_question')).toBe(true);
    expect(isWaitingSessionStatus('running')).toBe(false);
    expect(isWaitingSessionStatus('idle')).toBe(false);
  });
});

describe('splitBranchSuffix (point-check issue 32, decision 138)', () => {
  it('splits the Chinese interim title Main writes', () => {
    expect(splitBranchSuffix('旧会话己：一直在被写（1.0.x 分支）')).toEqual({
      base: '旧会话己：一直在被写',
      suffix: '（1.0.x 分支）',
      spaced: false,
    });
  });

  it('splits the English one and remembers the space', () => {
    expect(splitBranchSuffix('Old chat: tidy notes (1.0.x branch)')).toEqual({
      base: 'Old chat: tidy notes',
      suffix: '(1.0.x branch)',
      spaced: true,
    });
  });

  it('builds both suffixes from the dictionary entry Main uses', () => {
    expect(zhTranslations[LEGACY_FORK_TITLE_KEY]).toBe('{{title}}（1.0.x 分支）');
    expect(LEGACY_FORK_TITLE_KEY).toBe('{{title}} (1.0.x branch)');
  });

  it('leaves every other title whole', () => {
    expect(splitBranchSuffix('Parser rewrite')).toEqual({
      base: 'Parser rewrite',
      suffix: null,
      spaced: false,
    });
    // A suffix alone is not a title with a suffix.
    expect(splitBranchSuffix('（1.0.x 分支）').suffix).toBeNull();
    // Only at the end.
    expect(splitBranchSuffix('（1.0.x 分支）之后的笔记').suffix).toBeNull();
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
 * dsh-rebase P1-9e (decision 051): the legacy copy of a migrated chat that
 * 1.0.x wrote to since is listed next to the migrated chat, under the same
 * title; its row carries the `1.0.x` mark while it is still that copy.
 */
describe('the diverged legacy row (P1-9e)', () => {
  const rowsOf = (sessions: ChatSession[]) =>
    buildSidebarFolders({ projects, workspaces, sessions }).find(
      (folder) => folder.projectId === 'p-ai'
    )?.rows ?? [];

  it('marks the legacy copy and nothing else', () => {
    const rows = rowsOf([
      session({ id: 's1', agent: 'dsh', updatedAt: NOW }),
      session({ id: 's1_pi', agent: 'pi', legacyDiverged: true, updatedAt: NOW - 1 }),
      session({ id: 's2', agent: 'pi', runtimeIdentity: '/p/s2.jsonl', updatedAt: NOW - 2 }),
    ]);
    expect(rows.map((row) => [row.sessionId, row.legacyDiverged ?? null])).toEqual([
      ['s1', null],
      ['s1_pi', true],
      ['s2', null],
    ]);
    // Present only when true, like `unbound`.
    expect('legacyDiverged' in (rows[0] ?? {})).toBe(false);
  });

  it('drops the mark the moment the copy is moved over and rebound to DSH', () => {
    const rows = rowsOf([session({ id: 's1_pi', agent: 'dsh', legacyDiverged: true })]);
    expect(rows[0]?.legacyDiverged).toBeUndefined();
  });

  it('ships the mark’s explanation in the dictionary', () => {
    // A constant, not a `t('…')` literal: the catalog scan cannot see it.
    expect(zhTranslations[LEGACY_DIVERGED_HINT]).toBeDefined();
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

/**
 * T091, field repro B(b) and the temporary-chat half of it (2026-09-19).
 *
 * A temporary chat created in THIS run carries no `unbound` marker.
 * `createUnboundChatSession` deliberately withholds it: the scratch directory
 * does not exist until the first send allocates it, and writing a guessed
 * `workspacePath` is the fake-cwd failure U13 exists to prevent. All it has is
 * `workspaceId: ''`.
 *
 * All three derivations keyed on the marker alone, so such a chat appeared in
 * NO part of the sidebar — not the Temporary group, not Recent, not a
 * repository folder — until a send wrote the session index and the sidebar
 * remounted. From the user's side that is indistinguishable from "the New
 * button did nothing".
 */
describe('a live-only temporary chat is visible before its first send (T091)', () => {
  /** Exactly what `createUnboundChatSession` produces: no marker, no workspace. */
  const liveOnly = session({ id: 'live-temp', workspaceId: '', projectId: '', title: 'New chat' });

  it('appears in the Temporary chats group', () => {
    const folder = buildUnboundFolder({ sessions: [liveOnly], name: 'Temporary' });
    expect(folder?.rows.map((row) => row.sessionId)).toEqual(['live-temp']);
    expect(folder?.rows[0]?.chip?.label).toBe('temporary');
  });

  it('appears in Recent', () => {
    const { rows } = deriveRecentRows({ sessions: [liveOnly], workspaces, now: NOW });
    expect(rows.map((row) => row.sessionId)).toEqual(['live-temp']);
    expect(rows[0]?.chip?.label).toBe('temporary');
  });

  it('is never duplicated into a repository folder', () => {
    const folders = buildSidebarFolders({ projects, workspaces, sessions: [liveOnly] });
    expect(folders.flatMap((folder) => folder.rows)).toEqual([]);
  });

  it('a genuine orphan — an unknown, NON-EMPTY workspaceId — is still dropped everywhere', () => {
    const orphan = session({ id: 'orphan', workspaceId: 'ws-removed' });
    expect(buildUnboundFolder({ sessions: [orphan], name: 'Temporary' })).toBeNull();
    expect(deriveRecentRows({ sessions: [orphan], workspaces, now: NOW }).rows).toEqual([]);
    expect(
      buildSidebarFolders({ projects, workspaces, sessions: [orphan] }).flatMap(
        (folder) => folder.rows
      )
    ).toEqual([]);
  });

  it('a whitespace-only workspaceId counts as unbound, not as an orphan', () => {
    // The store writes `''`, but a merge/import path trimming to whitespace
    // would otherwise fall into the orphan bucket and vanish.
    const blank = session({ id: 'blank', workspaceId: '   ' });
    expect(buildUnboundFolder({ sessions: [blank], name: 'Temporary' })?.rows).toHaveLength(1);
  });
});

/**
 * T091, field repro B(b) — the search box hid the row the click just created.
 *
 * With a query in the sidebar's search field, a brand-new chat is titled
 * `New chat`, does not match, and is filtered out of every group. The user
 * clicks New, the main pane switches to an empty chat, and the sidebar shows
 * nothing new — so the button looks broken. A query is a filter over a list,
 * not a statement about which conversation is open, so the ACTIVE session is
 * exempt from it.
 */
describe('the active session is never filtered out by a title query (T091)', () => {
  it('survives a non-matching query in a repository folder', () => {
    const sessions = [
      session({ id: 'new', title: 'New chat' }),
      session({ id: 'match', title: 'Draft plan' }),
    ];
    const withoutActive = buildSidebarFolders({ projects, workspaces, sessions, query: 'draft' });
    expect(withoutActive.flatMap((f) => f.rows).map((row) => row.sessionId)).toEqual(['match']);

    const withActive = buildSidebarFolders({
      projects,
      workspaces,
      sessions,
      query: 'draft',
      activeSessionId: 'new',
    });
    expect(
      withActive
        .flatMap((f) => f.rows)
        .map((row) => row.sessionId)
        .sort()
    ).toEqual(['match', 'new']);
  });

  it('survives a non-matching query in the Temporary group', () => {
    const sessions = [
      session({ id: 'new', title: 'New chat', workspaceId: '' }),
      session({ id: 'match', title: 'Draft plan', workspaceId: '' }),
    ];
    expect(
      buildUnboundFolder({ sessions, name: 'Temporary', query: 'draft' })?.rows.map(
        (row) => row.sessionId
      )
    ).toEqual(['match']);
    expect(
      buildUnboundFolder({
        sessions,
        name: 'Temporary',
        query: 'draft',
        activeSessionId: 'new',
      })
        ?.rows.map((row) => row.sessionId)
        .sort()
    ).toEqual(['match', 'new']);
  });

  it('can bring the Temporary group back from null on its own', () => {
    // The group collapses entirely when no row survives; the active chat must
    // be able to keep it on screen.
    const sessions = [session({ id: 'new', title: 'New chat', workspaceId: '' })];
    expect(buildUnboundFolder({ sessions, name: 'Temporary', query: 'zzz' })).toBeNull();
    expect(
      buildUnboundFolder({ sessions, name: 'Temporary', query: 'zzz', activeSessionId: 'new' })
        ?.rows
    ).toHaveLength(1);
  });

  it('survives a non-matching query in Recent', () => {
    const sessions = [
      session({ id: 'new', title: 'New chat' }),
      session({ id: 'match', title: 'Draft plan' }),
    ];
    expect(
      deriveRecentRows({ sessions, workspaces, now: NOW, query: 'draft' }).rows.map(
        (row) => row.sessionId
      )
    ).toEqual(['match']);
    expect(
      deriveRecentRows({
        sessions,
        workspaces,
        now: NOW,
        query: 'draft',
        activeSessionId: 'new',
      })
        .rows.map((row) => row.sessionId)
        .sort()
    ).toEqual(['match', 'new']);
  });

  it('exempts only the query — an orphan active session is still dropped', () => {
    // The exemption is about SEARCH, not about validity. A session whose
    // workspace no longer exists has nowhere to render, active or not.
    const orphan = session({ id: 'orphan', title: 'New chat', workspaceId: 'ws-removed' });
    expect(
      buildSidebarFolders({
        projects,
        workspaces,
        sessions: [orphan],
        query: 'zzz',
        activeSessionId: 'orphan',
      }).flatMap((folder) => folder.rows)
    ).toEqual([]);
  });

  it('omitting activeSessionId leaves every derivation exactly as it was', () => {
    const sessions = [
      session({ id: 'a', title: 'Draft plan' }),
      session({ id: 'b', title: 'Other' }),
      session({ id: 'c', title: 'Draft notes', workspaceId: '' }),
    ];
    for (const activeSessionId of [undefined, null]) {
      expect(
        buildSidebarFolders({ projects, workspaces, sessions, query: 'draft', activeSessionId })
      ).toEqual(buildSidebarFolders({ projects, workspaces, sessions, query: 'draft' }));
      expect(
        buildUnboundFolder({ sessions, name: 'Temporary', query: 'draft', activeSessionId })
      ).toEqual(buildUnboundFolder({ sessions, name: 'Temporary', query: 'draft' }));
      expect(
        deriveRecentRows({ sessions, workspaces, now: NOW, query: 'draft', activeSessionId })
      ).toEqual(deriveRecentRows({ sessions, workspaces, now: NOW, query: 'draft' }));
    }
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
