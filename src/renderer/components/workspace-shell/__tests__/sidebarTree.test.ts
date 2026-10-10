import { translate, zhTranslations } from '@shared/i18n';
import { LEGACY_FORK_TITLE_KEY } from '@shared/types/legacyMigration';
import { describe, expect, it } from 'vitest';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { TEMP_PROJECT_ID } from '../deriveChatWorkspaceTree';
import {
  ACTIVE_DEFAULT_LIMIT,
  applyHeldFolderOrder,
  buildSidebarFolders,
  buildUnboundFolder,
  chipForWorkspace,
  chipShownInFolder,
  deriveActiveRows,
  deriveFolderLastActivity,
  FOLDER_DEFAULT_LIMIT,
  folderBranchLabel,
  folderPrimaryChip,
  folderTooltip,
  formatRelativeAge,
  isWaitingSessionStatus,
  LEGACY_DIVERGED_HINT,
  lastBranchSegment,
  limitActiveRows,
  limitFolderRows,
  orderFoldersByActivity,
  resolveHomePreselect,
  resolveNewSessionWorkspaceId,
  sidebarFolderNameForDisplay,
  sidebarRowPlace,
  sidebarRowTooltip,
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

  // Decision 167 retired the kind chips (「临时」「远程」 on every row, decision
  // 144 §2–3): a chat with no folder is marked `unbound` instead (U05-b ③,
  // see 'marks a chat with no folder as unbound' below), and a remote
  // repository is said once, on its folder row.
  it('carries no chip for a chat with no folder, temp or remote workspaces', () => {
    expect(chipForWorkspace(undefined)).toBeNull();
    // What a fresh install actually sits on: a seeded workspace whose path is
    // deliberately empty so a fake cwd can never reach spawn.
    expect(
      chipForWorkspace({ id: 'ws-seed', projectId: 'p-ai', name: 'Main', kind: 'main', path: '' })
    ).toBeNull();
    expect(chipForWorkspace(workspaces[3])).toBeNull();
    expect(
      chipForWorkspace({ id: 'ws-r', projectId: 'p-r', name: 'srv', kind: 'remote', path: '/srv' })
    ).toBeNull();
  });

  // U05-b ③ — "no folder" is a state the user can now be IN, not just a gap
  // on the way to picking one, so the session list has to say so.
  it('marks a chat with no folder — or on the empty-path placeholder — as unbound', () => {
    const seed: ChatWorkspace = {
      id: 'ws-seed',
      projectId: 'p-ai',
      name: 'Main',
      kind: 'main',
      path: '',
    };
    const [onSeed] =
      buildSidebarFolders({
        projects,
        workspaces: [seed],
        sessions: [session({ id: 's-seed', workspaceId: 'ws-seed' })],
      })[0]?.rows ?? [];
    expect(onSeed?.unbound).toBe(true);
    const [onRepo] = folderOf('p-ai', [session({ id: 's-repo' })]).rows;
    expect(onRepo).toBeDefined();
    expect('unbound' in (onRepo ?? {})).toBe(false);
  });
});

describe('the folder row carries the branch, rows only off the main workspace (decision 167 §2)', () => {
  const remote: ChatWorkspace = {
    id: 'ws-r',
    projectId: 'p-r',
    name: 'srv',
    kind: 'remote',
    path: '/srv',
  };

  it('folderPrimaryChip names the main workspace and its branch', () => {
    expect(folderPrimaryChip('p-ai', workspaces)).toEqual({
      workspaceId: 'ws-main',
      branch: 'main',
      remote: false,
    });
    // Branch unknown: still the folder's main workspace, just nothing to name.
    expect(folderPrimaryChip('p-empty', workspaces)).toEqual({
      workspaceId: 'ws-empty',
      branch: null,
      remote: false,
    });
    expect(folderPrimaryChip('p-r', [remote])).toEqual({
      workspaceId: 'ws-r',
      branch: null,
      remote: true,
    });
    // The Temp Session project has one temp workspace per directory, no main.
    expect(folderPrimaryChip('p-temp', workspaces)).toBeNull();
    expect(folderPrimaryChip('p-gone', workspaces)).toBeNull();
  });

  it('chipShownInFolder shows a branch only for a chat on a linked worktree', () => {
    const rows = folderOf('p-ai', [
      session({ id: 's-main', updatedAt: NOW }),
      session({ id: 's-wt', workspaceId: 'ws-wt', updatedAt: NOW - 1 }),
    ]).rows;
    const primary = folderPrimaryChip('p-ai', workspaces);
    expect(rows.map((row) => [row.sessionId, chipShownInFolder(row, primary)])).toEqual([
      ['s-main', false],
      ['s-wt', true],
    ]);
    // A row with no branch shows nothing, whatever its workspace.
    expect(chipShownInFolder({ chip: null, workspaceId: 'ws-wt' }, primary)).toBe(false);
    // A folder whose main workspace is unknown still shows a worktree's branch.
    expect(
      chipShownInFolder(
        { chip: { variant: 'branch', label: 'feat/x' }, workspaceId: 'ws-wt' },
        null
      )
    ).toBe(true);
  });

  it('lastBranchSegment keeps only the last path segment', () => {
    expect(lastBranchSegment('feature/sidebar-redesign')).toBe('sidebar-redesign');
    expect(lastBranchSegment('user/team/fix/login-retry')).toBe('login-retry');
    expect(lastBranchSegment('main')).toBe('main');
    expect(lastBranchSegment('release/2026.10')).toBe('2026.10');
    expect(lastBranchSegment('odd/')).toBe('odd');
    expect(lastBranchSegment('/')).toBe('/');
  });

  it('folderBranchLabel and folderTooltip say the main branch once, and remote', () => {
    const zh = (key: string, params?: Record<string, string | number>) =>
      translate('zh', key, params);
    const main = folderPrimaryChip('p-ai', workspaces);
    expect(folderBranchLabel(main)).toBe('main');
    expect(folderBranchLabel(folderPrimaryChip('p-empty', workspaces))).toBeNull();
    expect(folderBranchLabel(null)).toBeNull();
    const remotePrimary = folderPrimaryChip('p-r', [remote]);
    expect(folderBranchLabel(remotePrimary, zh)).toBe('远程');
    expect(folderBranchLabel({ workspaceId: 'w', branch: 'main', remote: true }, zh)).toBe(
      'main · 远程'
    );
    expect(folderTooltip('ai-client', main, zh)).toBe('ai-client\n主工作区分支：main');
    expect(folderTooltip('srv', remotePrimary, zh)).toBe('srv\n远程仓库');
    expect(folderTooltip('newhp', folderPrimaryChip('p-empty', workspaces))).toBe('newhp');
  });

  it('words the Temp Session project at display time only', () => {
    const zh = (key: string, params?: Record<string, string | number>) =>
      translate('zh', key, params);
    expect(sidebarFolderNameForDisplay('project-temp', 'Temp', zh)).toBe('临时工作区');
    expect(sidebarFolderNameForDisplay('p-ai', 'ai-client', zh)).toBe('ai-client');
  });
});

describe('the three-line row tooltip (decision 167 §3)', () => {
  const zh = (key: string, params?: Record<string, string | number>) =>
    translate('zh', key, params);
  const at = new Date(2026, 9, 7, 14, 32).getTime();
  const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws] as const));
  const names = new Map([['p-ai', 'ai-client']]);

  it('reads title / folder · branch / updated date and time', () => {
    const [row] = folderOf('p-ai', [session({ id: 's-wt', workspaceId: 'ws-wt' })]).rows;
    const place = sidebarRowPlace(row as never, workspaceById, names);
    expect(place).toEqual({ folderName: 'ai-client', branch: 'feat/x', remote: false });
    expect(
      sidebarRowTooltip({ title: '修复登录', place, updatedAt: at, locale: 'zh', t: zh })
    ).toBe('修复登录\nai-client · feat/x\n更新于 2026-10-07 14:32');
  });

  it('says 「临时对话」 for an unbound chat and adds 「（远程）」 for a remote one', () => {
    const unbound = sidebarRowPlace({ workspaceId: '', unbound: true }, workspaceById, names);
    expect(unbound).toEqual({ folderName: null, branch: null, remote: false });
    expect(
      sidebarRowTooltip({ title: 'x', place: unbound, updatedAt: at, locale: 'zh', t: zh }).split(
        '\n'
      )[1]
    ).toBe('临时对话');
    const remote = { folderName: 'srv', branch: null, remote: true };
    expect(
      sidebarRowTooltip({ title: 'x', place: remote, updatedAt: at, locale: 'zh', t: zh }).split(
        '\n'
      )[1]
    ).toBe('srv（远程）');
    // English, and a folder with no branch to name.
    expect(
      sidebarRowTooltip({
        title: 'Fix login',
        place: { folderName: 'newhp', branch: null, remote: false },
        updatedAt: at,
      })
    ).toBe('Fix login\nnewhp\nUpdated 2026-10-07 14:32');
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

/**
 * Decision 174 (issue #6, second wave): the sidebar's 「＋新建」 opens the home
 * page with the corresponding repository picked — the focused folder, else the
 * open conversation's — and otherwise picks nothing, leaving the home page's
 * own default (most recent activity). `resolveNewSessionTarget`, which chose
 * where a blank conversation was made at once, went with that change.
 */
describe('resolveHomePreselect', () => {
  const folders = buildSidebarFolders({ projects, workspaces, sessions: [] });

  it('prefers the focused folder over the active session', () => {
    expect(
      resolveHomePreselect({
        focusedProjectId: 'p-empty',
        folders,
        activeSession: { workspaceId: 'ws-main' },
        workspaces,
      })
    ).toEqual({ workspaceId: 'ws-empty', path: '/newhp', folderName: 'newhp' });
  });

  it('falls back to the active session workspace when nothing is focused', () => {
    expect(
      resolveHomePreselect({
        focusedProjectId: null,
        folders,
        activeSession: { workspaceId: 'ws-wt' },
        workspaces,
      })
    ).toEqual({ workspaceId: 'ws-wt', path: '/repo-wt', folderName: 'ai-client' });
  });

  it('picks nothing when neither a focused folder nor an open conversation names one', () => {
    expect(
      resolveHomePreselect({
        focusedProjectId: null,
        folders,
        activeSession: undefined,
        workspaces,
      })
    ).toBeNull();
  });

  it('falls through to the active session when the focused folder was deleted', () => {
    expect(
      resolveHomePreselect({
        focusedProjectId: 'p-deleted',
        folders,
        activeSession: { workspaceId: 'ws-wt' },
        workspaces,
      })?.workspaceId
    ).toBe('ws-wt');
  });

  // R5 round-2 (B1): a target must still be reachable in the nav.
  it('picks nothing for an active session whose workspace no longer exists', () => {
    expect(
      resolveHomePreselect({
        focusedProjectId: null,
        folders,
        activeSession: { workspaceId: 'ws-deleted' },
        workspaces,
      })
    ).toBeNull();
  });

  it('picks nothing for an active session whose project has no folder row (orphan workspace)', () => {
    expect(
      resolveHomePreselect({
        focusedProjectId: null,
        folders,
        activeSession: { workspaceId: 'ws-temp' },
        workspaces,
      })
    ).toBeNull();
  });

  it('picks nothing — never another folder — when the focused folder has no usable workspace', () => {
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
    expect(
      resolveHomePreselect({
        focusedProjectId: 'p-seed',
        folders: seedFolders,
        activeSession: { workspaceId: 'ws-main' },
        workspaces: seedWorkspaces,
      })
    ).toBeNull();
  });

  it('the immediate-create resolver is gone from the module', async () => {
    const mod = (await import('../sidebarTree')) as Record<string, unknown>;
    expect(mod.resolveNewSessionTarget).toBeUndefined();
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

describe('decision 170: Recent and its 48-hour window are gone from the sidebar', () => {
  it('the Recent derivations and the stored-collapse reader are gone from the module', async () => {
    // Issue #6 ruling 2: the top region is "Active now" alone; the 48-hour
    // list moves to the home page, which derives its own. Pinned so a second
    // cross-folder list cannot quietly come back into the sidebar.
    const mod = (await import('../sidebarTree')) as Record<string, unknown>;
    for (const name of [
      'deriveRecentRows',
      'RECENT_WINDOW_MS',
      'RECENT_DEFAULT_LIMIT',
      'resolveRecentCollapsed',
    ]) {
      expect(mod[name], name).toBeUndefined();
    }
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

  it('keeps a bound temporary chat and drops an orphan, like the folders', () => {
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

describe('limitActiveRows (decision 170, issue #6 ruling 2)', () => {
  /** `count` started chats, newest first — the region's input. */
  const activeOf = (count: number) => {
    const ids = Array.from({ length: count }, (_, i) => `s-${i}`);
    return deriveActiveRows({
      sessions: ids.map((id, i) => session({ id, updatedAt: NOW - i * 1000 })),
      workspaces,
      hostBoundSessionIds: ids,
    });
  };

  it('caps at 5', () => {
    expect(ACTIVE_DEFAULT_LIMIT).toBe(5);
  });

  it('lists 5 or fewer rows whole, with nothing to toggle', () => {
    const limited = limitActiveRows({ rows: activeOf(5), showAll: false, queryActive: false });
    expect(limited.rows).toHaveLength(5);
    expect(limited).toMatchObject({ hiddenCount: 0, collapsible: false });
  });

  it('shows the first 5 and counts the rest behind "View more" (7 active: 5 + 2)', () => {
    const limited = limitActiveRows({ rows: activeOf(7), showAll: false, queryActive: false });
    expect(limited.rows.map((row) => row.sessionId)).toEqual(['s-0', 's-1', 's-2', 's-3', 's-4']);
    expect(limited).toMatchObject({ hiddenCount: 2, collapsible: false });
  });

  it('lists everything once expanded, ending in "Show less"', () => {
    const limited = limitActiveRows({ rows: activeOf(7), showAll: true, queryActive: false });
    expect(limited.rows).toHaveLength(7);
    expect(limited).toMatchObject({ hiddenCount: 0, collapsible: true });
  });

  it('pins nothing past the cap, unlike a folder: the open chat stays behind "View more"', () => {
    // The open chat is still listed — and highlighted — in its own folder,
    // whose cap does pin it (decision 137 §4). The README's question 6 left
    // this region unpinned, and the user did not ask for it.
    const limited = limitActiveRows({ rows: activeOf(7), showAll: false, queryActive: false });
    expect(limited.rows.map((row) => row.sessionId)).not.toContain('s-6');
    expect(limited.hiddenCount).toBe(2);
  });

  it('lists every match while a search is active', () => {
    const limited = limitActiveRows({ rows: activeOf(9), showAll: false, queryActive: true });
    expect(limited.rows).toHaveLength(9);
    expect(limited).toMatchObject({ hiddenCount: 0, collapsible: false });
  });
});

/**
 * Decision 170 (issue #6 ruling 6): the repository list ordered by activity —
 * folders with chats newest first, folders without chats after them in their
 * old order, the Temp Session project last — and held while the user is in it.
 */
describe('folders by last activity (decision 170, issue #6 ruling 6)', () => {
  const MIN = 60_000;
  // In the order the repositories were added (`aiclient-repositories`).
  const orderProjects: ChatProject[] = [
    { id: 'p-atlas', name: 'atlas-web' },
    { id: 'p-zephyr', name: 'zephyr-tools' },
    { id: 'p-beacon', name: 'beacon-api' },
    { id: 'p-yarrow', name: 'yarrow-bot' },
    { id: 'p-nimbus', name: 'nimbus-agent' },
    { id: TEMP_PROJECT_ID, name: 'Temp' },
  ];
  const orderWorkspaces: ChatWorkspace[] = [
    { id: 'w-atlas', projectId: 'p-atlas', name: 'Main', kind: 'main', path: '/atlas' },
    { id: 'w-zephyr', projectId: 'p-zephyr', name: 'Main', kind: 'main', path: '/zephyr' },
    { id: 'w-beacon', projectId: 'p-beacon', name: 'Main', kind: 'main', path: '/beacon' },
    {
      id: 'w-beacon-wt',
      projectId: 'p-beacon',
      name: 'feat/x',
      kind: 'worktree',
      path: '/beacon-wt',
    },
    { id: 'w-yarrow', projectId: 'p-yarrow', name: 'Main', kind: 'main', path: '/yarrow' },
    { id: 'w-nimbus', projectId: 'p-nimbus', name: 'Main', kind: 'main', path: '/nimbus' },
    { id: 'w-temp', projectId: TEMP_PROJECT_ID, name: 'Scratch', kind: 'temp', path: '/tmp/s' },
  ];
  const orderSessions: ChatSession[] = [
    session({
      id: 'atlas-1',
      projectId: 'p-atlas',
      workspaceId: 'w-atlas',
      updatedAt: NOW - 25 * MIN,
    }),
    // A folder's activity is its newest chat, on any of its workspaces.
    session({
      id: 'beacon-main',
      projectId: 'p-beacon',
      workspaceId: 'w-beacon',
      updatedAt: NOW - 120 * MIN,
    }),
    session({
      id: 'beacon-wt',
      projectId: 'p-beacon',
      workspaceId: 'w-beacon-wt',
      updatedAt: NOW - 6 * MIN,
    }),
    session({ id: 'nimbus-1', projectId: 'p-nimbus', workspaceId: 'w-nimbus', updatedAt: NOW }),
    // Newer than everything, and still last: the Temp Session project.
    session({
      id: 'temp-1',
      projectId: TEMP_PROJECT_ID,
      workspaceId: 'w-temp',
      updatedAt: NOW + MIN,
    }),
    // Neither moves anything: an unbound chat has no folder, an orphan none left.
    session({ id: 'unbound-1', projectId: '', workspaceId: '', updatedAt: NOW + 2 * MIN }),
    session({
      id: 'orphan-1',
      projectId: 'p-yarrow',
      workspaceId: 'w-gone',
      updatedAt: NOW + 3 * MIN,
    }),
  ];
  const ids = (folders: readonly { projectId: string }[]) => folders.map((f) => f.projectId);
  const built = () =>
    buildSidebarFolders({
      projects: orderProjects,
      workspaces: orderWorkspaces,
      sessions: orderSessions,
    });

  it('takes each folder s newest chat, grouped by the workspace s project', () => {
    const activity = deriveFolderLastActivity({
      workspaces: orderWorkspaces,
      sessions: orderSessions,
    });
    expect(Object.fromEntries(activity)).toEqual({
      'p-atlas': NOW - 25 * MIN,
      'p-beacon': NOW - 6 * MIN,
      'p-nimbus': NOW,
      [TEMP_PROJECT_ID]: NOW + MIN,
    });
  });

  it('orders folders with chats newest first, then the empty ones in their old order, Temp last', () => {
    const activity = deriveFolderLastActivity({
      workspaces: orderWorkspaces,
      sessions: orderSessions,
    });
    expect(ids(orderFoldersByActivity(built(), activity))).toEqual([
      'p-nimbus',
      'p-beacon',
      'p-atlas',
      'p-zephyr',
      'p-yarrow',
      TEMP_PROJECT_ID,
    ]);
  });

  it('keeps the old order between folders with the same activity (stable)', () => {
    const folders = [{ projectId: 'a' }, { projectId: 'b' }, { projectId: 'c' }];
    const activity = new Map([
      ['a', NOW],
      ['b', NOW + 1],
      ['c', NOW],
    ]);
    expect(ids(orderFoldersByActivity(folders, activity))).toEqual(['b', 'a', 'c']);
  });

  it('a search does not reorder: the activity ignores which rows the query keeps', () => {
    const activity = deriveFolderLastActivity({
      workspaces: orderWorkspaces,
      sessions: orderSessions,
    });
    const searched = buildSidebarFolders({
      projects: orderProjects,
      workspaces: orderWorkspaces,
      sessions: orderSessions,
      query: 'atlas',
    });
    expect(ids(orderFoldersByActivity(searched, activity))).toEqual(
      ids(orderFoldersByActivity(built(), activity))
    );
  });

  it('a hold keeps the captured order while the live order changes', () => {
    const live = [
      { projectId: 'p-beacon' },
      { projectId: 'p-nimbus' },
      { projectId: TEMP_PROJECT_ID },
    ];
    expect(ids(applyHeldFolderOrder(live, null))).toEqual(ids(live));
    expect(ids(applyHeldFolderOrder(live, ['p-nimbus', 'p-beacon', TEMP_PROJECT_ID]))).toEqual([
      'p-nimbus',
      'p-beacon',
      TEMP_PROJECT_ID,
    ]);
  });

  it('a folder added during the hold goes after the held ones, a removed one goes, Temp stays last', () => {
    const live = [
      { projectId: 'p-new' },
      { projectId: 'p-beacon' },
      { projectId: 'p-other-new' },
      { projectId: TEMP_PROJECT_ID },
    ];
    expect(ids(applyHeldFolderOrder(live, ['p-nimbus', TEMP_PROJECT_ID, 'p-beacon']))).toEqual([
      'p-beacon',
      'p-new',
      'p-other-new',
      TEMP_PROJECT_ID,
    ]);
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

  it('collects unbound chats newest first, marked unbound and with no new-chat target', () => {
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
    expect(folder?.rows.every((row) => row.unbound === true && row.chip === null)).toBe(true);
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

  it('keeps unbound chats in Active now, where a real orphan is still excluded', () => {
    const rows = deriveActiveRows({
      sessions: [
        session({ id: 'u1', workspaceId: '', unbound }),
        session({ id: 'gone', workspaceId: 'ws-removed' }),
      ],
      workspaces,
      hostBoundSessionIds: ['u1', 'gone'],
    });
    expect(rows.map((row) => row.sessionId)).toEqual(['u1']);
    expect(rows[0]?.unbound).toBe(true);
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
    expect(folder?.rows[0]?.unbound).toBe(true);
  });

  it('appears in Active now once started', () => {
    const rows = deriveActiveRows({
      sessions: [liveOnly],
      workspaces,
      hostBoundSessionIds: ['live-temp'],
    });
    expect(rows.map((row) => row.sessionId)).toEqual(['live-temp']);
    expect(rows[0]?.unbound).toBe(true);
  });

  it('is never duplicated into a repository folder', () => {
    const folders = buildSidebarFolders({ projects, workspaces, sessions: [liveOnly] });
    expect(folders.flatMap((folder) => folder.rows)).toEqual([]);
  });

  it('a genuine orphan — an unknown, NON-EMPTY workspaceId — is still dropped everywhere', () => {
    const orphan = session({ id: 'orphan', workspaceId: 'ws-removed' });
    expect(buildUnboundFolder({ sessions: [orphan], name: 'Temporary' })).toBeNull();
    expect(
      deriveActiveRows({ sessions: [orphan], workspaces, hostBoundSessionIds: ['orphan'] })
    ).toEqual([]);
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

  it('survives a non-matching query in Active now', () => {
    const sessions = [
      session({ id: 'new', title: 'New chat' }),
      session({ id: 'match', title: 'Draft plan' }),
    ];
    const hostBoundSessionIds = ['new', 'match'];
    expect(
      deriveActiveRows({ sessions, workspaces, hostBoundSessionIds, query: 'draft' }).map(
        (row) => row.sessionId
      )
    ).toEqual(['match']);
    expect(
      deriveActiveRows({
        sessions,
        workspaces,
        hostBoundSessionIds,
        query: 'draft',
        activeSessionId: 'new',
      })
        .map((row) => row.sessionId)
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
      const hostBoundSessionIds = ['a', 'b', 'c'];
      expect(
        deriveActiveRows({
          sessions,
          workspaces,
          hostBoundSessionIds,
          query: 'draft',
          activeSessionId,
        })
      ).toEqual(deriveActiveRows({ sessions, workspaces, hostBoundSessionIds, query: 'draft' }));
    }
  });
});

describe('a search matches a title as the sidebar shows it (P1-7e e6, decision 145)', () => {
  const zh = (key: string, params?: Record<string, string | number>) =>
    translate('zh', key, params);
  const placeholder = session({ id: 'placeholder', title: 'New chat' });
  const named = session({ id: 'named', title: '新建一个脚本' });
  const other = session({ id: 'other', title: 'Fix the build' });
  const sessions = [placeholder, named, other];
  const ids = (rows: { sessionId: string }[]) => rows.map((row) => row.sessionId).sort();

  it('finds a `New chat` row by 「新建」 in Chinese, in every section', () => {
    const [folder] = buildSidebarFolders({ projects, workspaces, sessions, query: '新建', t: zh });
    expect(ids(folder?.rows ?? [])).toEqual(['named', 'placeholder']);
    expect(
      ids(
        deriveActiveRows({
          sessions,
          workspaces,
          hostBoundSessionIds: ['placeholder', 'other'],
          query: '新建',
          t: zh,
        })
      )
    ).toEqual(['placeholder']);
    const unbound = buildUnboundFolder({
      sessions: [{ ...placeholder, workspaceId: '' }],
      name: 'Temporary chats',
      query: '新建',
      t: zh,
    });
    expect(ids(unbound?.rows ?? [])).toEqual(['placeholder']);
  });

  it('still matches the stored identifier, and nothing changes without a translator', () => {
    const [byIdentifier] = buildSidebarFolders({
      projects,
      workspaces,
      sessions,
      query: 'new chat',
      t: zh,
    });
    expect(ids(byIdentifier?.rows ?? [])).toEqual(['placeholder']);
    const [english] = buildSidebarFolders({ projects, workspaces, sessions, query: '新建' });
    expect(ids(english?.rows ?? [])).toEqual(['named']);
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
