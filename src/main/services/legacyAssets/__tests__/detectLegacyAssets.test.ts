import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type LegacyAssetNoticeState,
  type LegacyAssetReport,
  legacyAssetCount,
  shouldShowLegacyAssetNotice,
} from '@shared/legacyAssets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DetectLegacyAssetsOptions,
  delegationSwitchExplicitlyOff,
  detectLegacyAssets,
  usableWorkspace,
} from '../detectLegacyAssets';
import { type LegacyAssetFiles, nodeLegacyAssetFiles } from '../nodeFiles';

/**
 * dsh-rebase P1-16e (decision 104) — what the legacy-asset notice lists.
 *
 * Every case runs against a temporary directory with an injected home and
 * agent directory; nothing here reads the developer's real home. The
 * workspace always has a `.git` at its repository root, so the project-root
 * climb stops inside the temporary tree too.
 */

let base: string;
let home: string;
let agentDir: string;
let repo: string;
let cwd: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aiclient-legacy-assets-'));
  home = join(base, 'home');
  agentDir = join(home, '.pilab', 'test-profile', 'pi-agent');
  repo = join(base, 'repo');
  cwd = join(repo, 'packages', 'app');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function doc(fields: Record<string, string>, body = 'Body.'): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n${body}\n`;
}

function detect(overrides: Partial<DetectLegacyAssetsOptions> = {}): Promise<LegacyAssetReport> {
  return detectLegacyAssets({
    files: nodeLegacyAssetFiles(),
    agentDir,
    home,
    cwd: null,
    settings: {},
    ...overrides,
  });
}

/** Every file under `root` with its size, mtime and content — the read-only witness. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        out[`${path}/`] = String(statSync(path).mtimeMs);
        walk(path);
      } else {
        const info = statSync(path);
        out[path] = `${info.size}:${info.mtimeMs}:${readFileSync(path, 'utf8')}`;
      }
    }
  };
  walk(root);
  return out;
}

describe('detectLegacyAssets — nothing to report', () => {
  it('answers an empty report for a machine with no 1.0.x assets', async () => {
    const report = await detect();
    expect(report).toEqual({
      agentDir,
      instructionTarget: join(agentDir, 'AGENTS.md'),
      skillsTarget: join(agentDir, 'skills'),
      workspace: null,
      subagents: [],
      promptTemplates: [],
      instructionFile: null,
      mcpConfigs: [],
      skills: [],
      delegationSwitchOff: false,
    });
    expect(legacyAssetCount(report)).toBe(0);
  });
});

describe('detectLegacyAssets — custom sub-agent definitions', () => {
  it('does not count the four builtins, which live in code', async () => {
    const report = await detect();
    for (const builtin of ['explorer', 'code-reviewer', 'test-runner', 'fixer']) {
      expect(report.subagents.map((entry) => entry.name)).not.toContain(builtin);
    }
  });

  it.each([
    {
      title: 'agent-directory definition, named by its frontmatter',
      file: ['subagents', 'helper.md'],
      under: 'agentDir',
      content: doc({ name: 'helper', description: 'finds things' }),
      expected: 'helper',
    },
    {
      title: '~/.agents definition without a name, named by its file',
      file: ['.agents', 'subagents', 'Code Reviewer.md'],
      under: 'home',
      content: doc({ description: 'reviews' }),
      expected: 'code-reviewer',
    },
    {
      title: 'a user file that overrides a builtin by name is still the user’s',
      file: ['subagents', 'explorer.md'],
      under: 'agentDir',
      content: doc({ name: 'explorer', description: 'my own explorer' }),
      expected: 'explorer',
    },
    {
      title: 'a definition 1.0.x could not parse is still listed, by its file name',
      file: ['subagents', 'broken.md'],
      under: 'agentDir',
      content: 'no frontmatter at all',
      expected: 'broken',
    },
  ])('lists $title', async ({ file, under, content, expected }) => {
    const root = under === 'agentDir' ? agentDir : home;
    const path = join(root, ...file);
    put(path, content);
    const report = await detect();
    expect(report.subagents).toEqual([{ name: expected, path }]);
  });

  it.each([
    ['a non-Markdown file', ['subagents', 'notes.txt']],
    ['a file one level down, which 1.0.x never read', ['subagents', 'nested', 'deep.md']],
  ])('ignores %s', async (_label, file) => {
    put(join(agentDir, ...file), doc({ name: 'x', description: 'y' }));
    expect((await detect()).subagents).toEqual([]);
  });
});

describe('detectLegacyAssets — prompt templates', () => {
  beforeEach(() => {
    put(join(agentDir, 'prompts', 'review.md'), doc({ description: 'Review a PR' }));
    put(join(cwd, '.pi', 'prompts', 'fix.md'), 'Fix $1 now.\n');
  });

  it('lists the agent-directory templates without a workspace', async () => {
    const report = await detect();
    expect(report.promptTemplates).toEqual([
      { name: 'review', path: join(agentDir, 'prompts', 'review.md'), scope: 'user' },
    ]);
    expect(report.workspace).toBeNull();
  });

  it('adds the workspace’s .pi/prompts only when that workspace is open', async () => {
    const report = await detect({ cwd });
    expect(report.workspace).toBe(cwd);
    expect(report.promptTemplates).toEqual([
      { name: 'review', path: join(agentDir, 'prompts', 'review.md'), scope: 'user' },
      { name: 'fix', path: join(cwd, '.pi', 'prompts', 'fix.md'), scope: 'project' },
    ]);
  });
});

describe('detectLegacyAssets — user-layer instruction file', () => {
  const PILAB = ['.pilab', 'AGENTS.md'];
  const CLAUDE = ['.claude', 'CLAUDE.md'];
  const CODEX = ['.codex', 'AGENTS.md'];

  it.each([
    { title: 'none of the three', files: [] as [string[], string][], expected: null },
    { title: 'only Codex', files: [[CODEX, 'rules']] as [string[], string][], expected: CODEX },
    {
      title: 'a blank ~/.pilab file falls through to Claude, as 1.0.x did',
      files: [
        [PILAB, '  \n'],
        [CLAUDE, 'rules'],
      ] as [string[], string][],
      expected: CLAUDE,
    },
    {
      title: 'all three: the first in 1.0.x order wins',
      files: [
        [PILAB, 'a'],
        [CLAUDE, 'b'],
        [CODEX, 'c'],
      ] as [string[], string][],
      expected: PILAB,
    },
  ])('$title', async ({ files, expected }) => {
    for (const [segments, content] of files) put(join(home, ...segments), content);
    // DSH's own global file is where rules go now, not a legacy asset.
    put(join(agentDir, 'AGENTS.md'), 'managed');
    const report = await detect();
    expect(report.instructionFile).toBe(expected ? join(home, ...expected) : null);
  });
});

describe('detectLegacyAssets — mcp.json', () => {
  beforeEach(() => {
    put(
      join(agentDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' }, fs: { url: 'http://x' } } })
    );
    put(join(cwd, '.pi', 'mcp.json'), '{ not json');
    put(join(cwd, '.pi', 'mcp.local.json'), JSON.stringify({ servers: {} }));
  });

  it('lists the user file and its server names without a workspace', async () => {
    expect((await detect()).mcpConfigs).toEqual([
      {
        path: join(agentDir, 'mcp.json'),
        scope: 'user',
        servers: ['github', 'fs'],
        unreadable: false,
      },
    ]);
  });

  it('adds the project and local files when the workspace is open', async () => {
    const report = await detect({ cwd });
    expect(
      report.mcpConfigs.map(({ path, scope, unreadable }) => ({ path, scope, unreadable }))
    ).toEqual([
      { path: join(agentDir, 'mcp.json'), scope: 'user', unreadable: false },
      { path: join(cwd, '.pi', 'mcp.json'), scope: 'project', unreadable: true },
      { path: join(cwd, '.pi', 'mcp.local.json'), scope: 'local', unreadable: true },
    ]);
  });

  it('carries server names only, never commands, URLs or env', async () => {
    const serialised = JSON.stringify((await detect()).mcpConfigs);
    expect(serialised).not.toContain('gh-mcp');
    expect(serialised).not.toContain('http://x');
  });
});

describe('detectLegacyAssets — skills DSH will not load', () => {
  type Case = {
    title: string;
    path: () => string;
    content: string;
    expected: { name: string; issues: string[] } | null;
  };
  const cases: Case[] = [
    {
      title: 'a well-formed skill in <agentDir>/skills',
      path: () => join(agentDir, 'skills', 'good-one', 'SKILL.md'),
      content: doc({ name: 'good-one', description: 'fine' }),
      expected: null,
    },
    {
      title: 'a flat <name>.md in <agentDir>/skills',
      path: () => join(agentDir, 'skills', 'loose.md'),
      content: doc({ name: 'loose', description: 'fine' }),
      expected: null,
    },
    {
      title: 'a well-formed skill in ~/.agents/skills',
      path: () => join(home, '.agents', 'skills', 'shared-ok', 'SKILL.md'),
      content: doc({ name: 'shared-ok', description: 'fine' }),
      expected: null,
    },
    {
      title: 'a skill with no name (1.0.x used the directory name)',
      path: () => join(agentDir, 'skills', 'no-name', 'SKILL.md'),
      content: doc({ description: 'nameless' }),
      expected: { name: 'no-name', issues: ['missing-name'] },
    },
    {
      title: 'a name that is not lowercase-with-dashes',
      path: () => join(agentDir, 'skills', 'bad', 'SKILL.md'),
      content: doc({ name: 'Bad_Name', description: 'shouty' }),
      expected: { name: 'Bad_Name', issues: ['invalid-name'] },
    },
    {
      title: 'a skill two levels down',
      path: () => join(agentDir, 'skills', 'group', 'deep', 'SKILL.md'),
      content: doc({ name: 'deep', description: 'buried' }),
      expected: { name: 'deep', issues: ['nested'] },
    },
    {
      title: 'a declared loose .md inside a grouping folder of ~/.agents/skills',
      path: () => join(home, '.agents', 'skills', 'group', 'inner.md'),
      content: doc({ name: 'inner', description: 'grouped' }),
      expected: { name: 'inner', issues: ['nested'] },
    },
    {
      title: 'a project skill in .pi/skills',
      path: () => join(cwd, '.pi', 'skills', 'proj', 'SKILL.md'),
      content: doc({ name: 'proj', description: 'project' }),
      expected: { name: 'proj', issues: ['unscanned-root'] },
    },
    {
      title: 'a project skill in .agents/skills below the repository root',
      path: () => join(cwd, '.agents', 'skills', 'sub-skill', 'SKILL.md'),
      content: doc({ name: 'sub-skill', description: 'package level' }),
      expected: { name: 'sub-skill', issues: ['unscanned-root'] },
    },
    {
      title: 'a project skill in .agents/skills at the repository root',
      path: () => join(repo, '.agents', 'skills', 'root-ok', 'SKILL.md'),
      content: doc({ name: 'root-ok', description: 'repo level' }),
      expected: null,
    },
    {
      title: 'every problem at once',
      path: () => join(cwd, '.pi', 'skills', 'group', 'Some_Thing', 'SKILL.md'),
      content: doc({ description: 'all wrong' }),
      expected: { name: 'Some_Thing', issues: ['unscanned-root', 'nested', 'missing-name'] },
    },
    {
      title: 'a file 1.0.x did not load either (no description)',
      path: () => join(agentDir, 'skills', 'Nope', 'SKILL.md'),
      content: doc({ name: 'Nope' }),
      expected: null,
    },
  ];

  it.each(cases)('$title', async ({ path, content, expected }) => {
    const file = path();
    put(file, content);
    const report = await detect({ cwd });
    expect(report.skills).toEqual(expected ? [{ ...expected, path: file }] : []);
  });

  it('leaves project roots alone when no workspace is open', async () => {
    put(join(cwd, '.pi', 'skills', 'proj', 'SKILL.md'), doc({ name: 'proj', description: 'p' }));
    expect((await detect()).skills).toEqual([]);
  });
});

describe('detectLegacyAssets — the delegation switch (decision 105)', () => {
  it.each([
    ['never set', {}, false],
    ['override off', { piOptInFeatures: { subagents: false } }, true],
    [
      'override on beats the older boolean',
      { piOptInFeatures: { subagents: true }, enablePiSubagents: false },
      false,
    ],
    ['older boolean off', { enablePiSubagents: false }, true],
    ['older boolean on', { enablePiSubagents: true }, false],
    ['another feature off', { piOptInFeatures: { other: false } }, false],
    ['a malformed override map', { piOptInFeatures: 'off' }, false],
    ['only per-definition switches off', { nativeSubagentsDisabled: ['explorer'] }, false],
  ] as [
    string,
    Record<string, unknown>,
    boolean,
  ][])('%s → %s', async (_label, settings, expected) => {
    expect(delegationSwitchExplicitlyOff(settings)).toBe(expected);
    expect((await detect({ settings })).delegationSwitchOff).toBe(expected);
  });
});

describe('detectLegacyAssets — pi extensions are not looked for (decision 090)', () => {
  it('lists nothing about installed pi extensions', async () => {
    put(join(agentDir, 'npm', 'node_modules', 'pi-ext', 'package.json'), '{"name":"pi-ext"}');
    put(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-ext'] }));
    put(join(agentDir, 'extensions', 'my-ext.ts'), 'export default {}');
    put(join(home, '.pi', 'agent', 'extensions', 'other-ext.ts'), 'export default {}');
    const report = await detect({ cwd });
    expect(Object.keys(report).sort()).toEqual(
      [
        'agentDir',
        'delegationSwitchOff',
        'instructionFile',
        'instructionTarget',
        'mcpConfigs',
        'promptTemplates',
        'skills',
        'skillsTarget',
        'subagents',
        'workspace',
      ].sort()
    );
    expect(legacyAssetCount(report)).toBe(0);
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('pi-ext');
    expect(serialised).not.toContain('my-ext');
    expect(serialised).not.toContain('other-ext');
  });
});

describe('detectLegacyAssets — read-only', () => {
  it('changes, moves and creates nothing', async () => {
    put(join(agentDir, 'subagents', 'helper.md'), doc({ name: 'helper', description: 'd' }));
    put(join(agentDir, 'prompts', 'review.md'), 'Review.');
    put(join(home, '.claude', 'CLAUDE.md'), 'rules');
    put(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    put(join(agentDir, 'skills', 'bad', 'SKILL.md'), doc({ name: 'Bad', description: 'd' }));
    put(join(cwd, '.pi', 'prompts', 'fix.md'), 'Fix.');
    const before = snapshotTree(base);
    const report = await detect({ cwd, settings: { enablePiSubagents: false } });
    // helper, review + fix, CLAUDE.md, mcp.json, the Bad skill, the switch.
    expect(legacyAssetCount(report)).toBe(7);
    expect(snapshotTree(base)).toEqual(before);
  });
});

describe('detectLegacyAssets — one category failing', () => {
  it('reports the rest and logs the failed one', async () => {
    put(join(agentDir, 'subagents', 'helper.md'), doc({ name: 'helper', description: 'd' }));
    put(join(agentDir, 'prompts', 'review.md'), 'Review.');
    const real = nodeLegacyAssetFiles();
    const files: LegacyAssetFiles = {
      ...real,
      readDirectory(path) {
        if (path === join(agentDir, 'subagents')) {
          throw Object.assign(new Error('I/O error'), { code: 'EIO' });
        }
        return real.readDirectory(path);
      },
    };
    const log = vi.fn();
    const report = await detect({ files, log });
    expect(report.subagents).toEqual([]);
    expect(report.promptTemplates.map((entry) => entry.name)).toEqual(['review']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('subagents not scanned: I/O error'));
  });
});

describe('usableWorkspace', () => {
  it.each([
    [undefined, null],
    [42, null],
    ['', null],
    ['   ', null],
    ['relative/path', null],
    ['__aiclient_temp_workspace__', null],
    ['/__aiclient_remote__/conn-1/home/u/repo', null],
    [' /abs/repo ', '/abs/repo'],
  ])('%j → %j', (value, expected) => {
    expect(usableWorkspace(value)).toBe(expected);
  });
});

describe('shouldShowLegacyAssetNotice', () => {
  const empty: LegacyAssetReport = {
    agentDir: '/a',
    instructionTarget: '/a/AGENTS.md',
    skillsTarget: '/a/skills',
    workspace: null,
    subagents: [],
    promptTemplates: [],
    instructionFile: null,
    mcpConfigs: [],
    skills: [],
    delegationSwitchOff: false,
  };
  const found: LegacyAssetReport = { ...empty, delegationSwitchOff: true };

  it.each([
    ['unseen with something to list', { report: found, seen: false }, true],
    ['unseen with nothing to list', { report: empty, seen: false }, false],
    ['seen', { report: found, seen: true }, false],
  ] as [string, LegacyAssetNoticeState, boolean][])('%s → %s', (_label, state, expected) => {
    expect(shouldShowLegacyAssetNotice(state)).toBe(expected);
  });
});
