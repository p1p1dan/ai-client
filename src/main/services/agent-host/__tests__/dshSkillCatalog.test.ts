import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_SCAN_BYTES, skillSource } from '@shared/skills/catalog';
import type { WorkerSlashCommandInfo } from '@shared/types/workerRpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeLegacyAssetFiles } from '../../legacyAssets/nodeFiles';
import {
  composerSlashCommands,
  DSH_SKILL_NAME,
  type DshSkillCandidate,
  type DshSkillHomes,
  discoverDshSkillRoot,
  dshProjectRoot,
  dshSkillHeader,
  dshSkillRoots,
  listDshUserSkills,
  preStartSlashRows,
  readDshFrontmatter,
  WINDOW_OWNED_COMMAND_NAMES,
} from '../dshSkillCatalog';
import type { WorkerSlashCommandsAnswer } from '../WorkerManager';

/**
 * dsh-rebase decision 175 (GitHub issue #6 follow-up): the skills Main lists
 * for the composer's menu while no session is up in the workspace, by DSH's
 * own rules. The load-bearing claim is the last block: DSH's installed
 * provider, run over the same directories, finds the same skills.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');
const DSH_MODULES = join(REPO, 'src/dsh-host/node_modules/@deepseek-ai');
const DSH_SKILL_FS = join(DSH_MODULES, 'dsh-skill-filesystem/lib/index.js');
const DSH_SKILL = join(DSH_MODULES, 'dsh-skill/lib/index.js');

const source = () => skillSource(nodeLegacyAssetFiles(), MAX_SCAN_BYTES);

let box: string;

function put(relative: string, content: string): string {
  const file = join(box, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

const skill = (name: string, description: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

function homesIn(root: string): DshSkillHomes {
  return {
    agentDir: join(root, 'agent-dir'),
    dshHome: join(root, 'dsh-home'),
    agentsHome: join(root, 'home', '.agents'),
  };
}

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'dsh-skill-catalog-'));
});

afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

/** The fields of a header, plain values only. */
function fields(text: string): Record<string, unknown> | undefined {
  const read = readDshFrontmatter(text);
  if (!read) return undefined;
  return Object.fromEntries(
    [...read].map(([key, value]) => [key, typeof value === 'symbol' ? '<unresolved>' : value])
  );
}

const fm = (yaml: string) => `---\n${yaml}\n---\nbody\n`;

describe('readDshFrontmatter — the header as DSH cuts and reads it', () => {
  it('needs `---` on the first line and a closing `---` line', () => {
    expect(fields('name: x\n')).toBeUndefined();
    expect(fields('---\nname: x\n')).toBeUndefined();
    expect(fields('# Title\n---\nname: x\n---\n')).toBeUndefined();
    expect(fields('---\r\nname: x\r\ndescription: y\r\n---\r\nbody')).toEqual({
      name: 'x',
      description: 'y',
    });
    // Only comments: `parse` answers null, which DSH treats as no header.
    expect(fields(fm('# nothing here'))).toBeUndefined();
  });

  it.each([
    ['plain', 'description: Use it for X', 'Use it for X'],
    ['a trailing comment', 'description: text # a note', 'text'],
    ['a hash inside a word', 'description: C# and F#', 'C# and F#'],
    ['a URL', 'description: see https://example.com/x', 'see https://example.com/x'],
    [
      'folded plain lines',
      'description: line one\n  line two\n\n  line three',
      'line one line two\nline three',
    ],
    ['a value on the next line', 'description:\n  foo bar\n  baz', 'foo bar baz'],
    ['double quotes', 'description: "a \\"q\\" \\u00e9 b"', 'a "q" é b'],
    ['double quotes over lines', 'description: "a\n  b"', 'a b'],
    ['double quotes with a blank line', 'description: "a\n\n  b"', 'a\nb'],
    ['an escaped line break', 'description: "a\\\n   b"', 'ab'],
    ['single quotes', "description: 'it''s'", "it's"],
    ['single quotes over lines', "description: 'a\n  b'", 'a b'],
    ['a literal block', 'description: |\n  a\n  b\n', 'a\nb\n'],
    ['a folded block', 'description: >\n  a\n  b\n\n  c\n', 'a b\nc\n'],
    ['a stripped folded block', 'description: >-\n  a\n  b\n', 'a b'],
    ['an indentation indicator', 'description: |2\n   x\n  y\n', ' x\ny\n'],
    ['a dash inside', 'description: a - b', 'a - b'],
    ['a dash continuing a line', 'description: foo\n  - bar', 'foo - bar'],
    ['a leading dash without a space', 'description: -foo', '-foo'],
    ['a pipe inside', 'description: a | b', 'a | b'],
  ])('reads %s', (_label, yaml, expected) => {
    expect(fields(fm(`name: x\n${yaml}`))?.description).toBe(expected);
  });

  it.each([
    ['null', 'description:', null],
    ['tilde', 'description: ~', null],
    ['a number', 'description: 2024', 2024],
    ['true', 'user-invocable: True', true],
    ['yes stays a word', 'user-invocable: yes', 'yes'],
    ['one', 'user-invocable: 1', 1],
    ['a float one', 'user-invocable: 1.0', 1],
    ['hex', 'user-invocable: 0x1', 1],
  ])('types an unquoted %s the way the core schema does', (_label, yaml, expected) => {
    const read = fields(fm(yaml));
    expect(Object.values(read ?? {})[0]).toBe(expected);
  });

  it('keeps nested blocks, flow collections and sequences, unread', () => {
    expect(
      fields(
        fm(
          'name: x\nmetadata:\n  a: 1\n  b:\n    - y\nallowed-tools:\n- Read\n- Grep\nflow: [a, "b]", c]\nmulti: [\n  a,\n  b\n]\ndescription: d'
        )
      )
    ).toEqual({
      name: 'x',
      metadata: '<unresolved>',
      'allowed-tools': '<unresolved>',
      flow: '<unresolved>',
      multi: '<unresolved>',
      description: 'd',
    });
  });

  it('reads keys written at an indent, all at the same one', () => {
    expect(fields(fm('  name: x\n  description: y'))).toEqual({ name: 'x', description: 'y' });
    expect(fields(fm('  name: x\ndescription: y'))).toBeUndefined();
  });

  it.each([
    ['a `: ` inside a plain value', 'description: Use when: X'],
    ['a trailing colon', 'description: foo:'],
    ['a mapping on a continuation line', 'description: line one\n  b: c'],
    ['a key twice', 'name: a\nname: b'],
    ['another key twice', 'license: a\nlicense: a'],
    ['a stray line', 'name: a\nfoo'],
    ['a tab as indentation', 'description: a\n\tb'],
    ['a sequence item on the key line', 'description: - foo'],
    ['a reserved first character', 'description: @foo'],
    ['a flow indicator first', 'description: ,foo'],
    ['junk after a quoted value', 'description: "a" b'],
    ['a comment glued to a quote', 'description: "a"#c'],
    ['an unknown escape', 'description: "a\\q"'],
    ['an unclosed quote', 'description: "a'],
    ['a block line left of its column', 'description: |\n    a\n  b\nname: x'],
    ['content after a comment in a value', 'description: foo\n  # c\n  bar'],
    ['a top-level comment inside a value', 'description: foo\n# c\n  bar'],
    ['a document that is a sequence', '- a\n- b'],
    ['a document that is a scalar', 'name:x'],
  ])('rejects %s, as `parse` does', (_label, yaml) => {
    expect(fields(fm(yaml))).toBeUndefined();
  });
});

describe('dshSkillHeader — what dsh-skill-filesystem accepts as a skill', () => {
  const header = (yaml: string) => dshSkillHeader(readDshFrontmatter(fm(yaml)));

  it('needs a kebab-case name and a description, both non-empty strings', () => {
    expect(header('name: plan-tree\ndescription: Plans')).toEqual({
      name: 'plan-tree',
      description: 'Plans',
      modelInvocable: true,
      userInvocable: true,
    });
    expect(header('name: Plan_Tree\ndescription: Plans')).toBeUndefined();
    expect(header('name: plan-tree')).toBeUndefined();
    expect(header('name: plan-tree\ndescription:')).toBeUndefined();
    expect(header('name: plan-tree\ndescription: ""')).toBeUndefined();
    expect(header('name: 123\ndescription: numbers are not names')).toBeUndefined();
    expect(header('name: "123"\ndescription: a quoted one is')).toMatchObject({ name: '123' });
    expect(header('name: [a]\ndescription: d')).toBeUndefined();
  });

  it('reads the two invocation keys strictly, and refuses the camel-case spellings', () => {
    expect(header('name: a\ndescription: d\nuser-invocable: false')).toMatchObject({
      userInvocable: false,
    });
    expect(header('name: a\ndescription: d\nuser-invocable: "No"')).toMatchObject({
      userInvocable: false,
    });
    expect(header('name: a\ndescription: d\nuser-invocable: 0')).toMatchObject({
      userInvocable: false,
    });
    expect(header('name: a\ndescription: d\ndisable-model-invocation: on')).toMatchObject({
      modelInvocable: false,
      userInvocable: true,
    });
    expect(header('name: a\ndescription: d\nuser-invocable: maybe')).toBeUndefined();
    expect(header('name: a\ndescription: d\nuser-invocable:')).toBeUndefined();
    expect(header('name: a\ndescription: d\nuserInvocable: true')).toBeUndefined();
    expect(header('name: a\ndescription: d\ndisableModelInvocation: false')).toBeUndefined();
    expect(header('name: a\ndescription: d\nmodelInvocable: true')).toBeUndefined();
  });
});

describe('roots and the project root', () => {
  it('lists the five roots in rank order, the project two only with a workspace', () => {
    const homes = homesIn('/x');
    expect(
      dshSkillRoots(homes, '/repo').map((root) => [root.source, root.rank, root.path])
    ).toEqual([
      ['project-dsh', 100, join('/repo', '.dsh', 'skills')],
      ['project-agents', 200, join('/repo', '.agents', 'skills')],
      ['custom', 300, join('/x', 'agent-dir', 'skills')],
      ['user-dsh', 400, join('/x', 'dsh-home', 'skills')],
      ['user-agents', 500, join('/x', 'home', '.agents', 'skills')],
    ]);
    expect(dshSkillRoots(homes, null).map((root) => root.source)).toEqual([
      'custom',
      'user-dsh',
      'user-agents',
    ]);
  });

  it('climbs to the nearest `.git`, a worktree file included, else stays put', async () => {
    mkdirSync(join(box, 'repo', '.git'), { recursive: true });
    mkdirSync(join(box, 'repo', 'pkg', 'src'), { recursive: true });
    expect(await dshProjectRoot(source(), join(box, 'repo', 'pkg', 'src'))).toBe(join(box, 'repo'));
    put('worktree/.git', 'gitdir: /elsewhere\n');
    mkdirSync(join(box, 'worktree', 'sub'), { recursive: true });
    expect(await dshProjectRoot(source(), join(box, 'worktree', 'sub'))).toBe(
      join(box, 'worktree')
    );
    mkdirSync(join(box, 'plain', 'dir'), { recursive: true });
    expect(await dshProjectRoot(source(), join(box, 'plain', 'dir'))).toBe(
      join(box, 'plain', 'dir')
    );
  });
});

describe('listDshUserSkills — the menu rows for a workspace', () => {
  function tree() {
    const homes = homesIn(box);
    mkdirSync(join(box, 'repo', '.git'), { recursive: true });
    put('repo/.dsh/skills/shared/SKILL.md', skill('shared', 'From the project'));
    put('repo/.agents/skills/project-only.md', skill('project-only', 'A flat project skill'));
    put('repo/.agents/skills/nested/deeper/SKILL.md', skill('too-deep', 'Never found'));
    put('repo/.agents/skills/notes.txt', 'not a skill');
    put('agent-dir/skills/app-skill/SKILL.md', skill('app-skill', 'The app folder'));
    put('dsh-home/skills/.system/SKILL.md', skill('dsh-system', 'DSH’s own'));
    put('dsh-home/skills/dsh-user/SKILL.md', skill('dsh-user', 'Under DSH_HOME'));
    put('home/.agents/skills/shared/SKILL.md', skill('shared', 'From the user'));
    put('home/.agents/skills/.system/SKILL.md', skill('agents-system', 'Not skipped here'));
    put(
      'home/.agents/skills/hidden/SKILL.md',
      skill('hidden', 'Model only', 'user-invocable: false\n')
    );
    put('home/.agents/skills/broken/SKILL.md', skill('broken', 'Use when: broken'));
    return homes;
  }

  it('reads every root, the lowest rank winning a name, user-invocable only, by name', async () => {
    const homes = tree();
    const rows = await listDshUserSkills(source(), homes, join(box, 'repo'));
    expect(rows.map((row) => [row.name, row.scope, row.description])).toEqual([
      ['agents-system', 'user-agents', 'Not skipped here'],
      ['app-skill', 'custom', 'The app folder'],
      ['dsh-user', 'user-dsh', 'Under DSH_HOME'],
      ['project-only', 'project-agents', 'A flat project skill'],
      ['shared', 'project-dsh', 'From the project'],
    ]);
    for (const row of rows) expect(row.source).toBe('skill');
    expect(rows.find((row) => row.name === 'project-only')?.path).toBe(
      join(box, 'repo', '.agents', 'skills', 'project-only.md')
    );
  });

  it('without a workspace, only the user’s skills', async () => {
    const homes = tree();
    const rows = await listDshUserSkills(source(), homes, null);
    expect(rows.map((row) => [row.name, row.scope])).toEqual([
      ['agents-system', 'user-agents'],
      ['app-skill', 'custom'],
      ['dsh-user', 'user-dsh'],
      ['shared', 'user-agents'],
    ]);
  });

  it('a workspace with no skills of its own still has the user’s', async () => {
    const homes = tree();
    mkdirSync(join(box, 'other', '.git'), { recursive: true });
    const rows = await listDshUserSkills(source(), homes, join(box, 'other'));
    expect(rows.map((row) => row.name)).toEqual([
      'agents-system',
      'app-skill',
      'dsh-user',
      'shared',
    ]);
  });

  it('follows a symbolic link to a skill directory', async () => {
    const homes = homesIn(box);
    put('elsewhere/linked/SKILL.md', skill('linked', 'Through a link'));
    mkdirSync(join(box, 'home', '.agents', 'skills'), { recursive: true });
    try {
      symlinkSync(
        join(box, 'elsewhere', 'linked'),
        join(box, 'home', '.agents', 'skills', 'linked')
      );
    } catch {
      return; // A platform without unprivileged symlinks: nothing to check.
    }
    const rows = await listDshUserSkills(source(), homes, null);
    expect(rows.map((row) => row.name)).toEqual(['linked']);
  });

  it('a missing root holds nothing', async () => {
    expect(await listDshUserSkills(source(), homesIn(box), join(box, 'nowhere'))).toEqual([]);
  });
});

describe('the menu before a session is up', () => {
  const row = (name: string, rowSource = 'skill'): WorkerSlashCommandInfo => ({
    name,
    source: rowSource,
  });

  it('puts the skills after the commands, minus any a command or the window’s /compact names', () => {
    expect(
      preStartSlashRows(
        [row('goal', 'command')],
        [row('compact'), row('goal'), row('plan-tree'), row('archive')]
      )
    ).toEqual({
      commands: [row('goal', 'command'), row('plan-tree'), row('archive')],
      truncated: false,
    });
  });

  it('is capped like a worker’s list', () => {
    const skills = Array.from({ length: 300 }, (_, i) => row(`skill-${i}`));
    const result = preStartSlashRows([], skills);
    expect(result.commands).toHaveLength(256);
    expect(result.truncated).toBe(true);
  });

  function workers(answer: Partial<WorkerSlashCommandsAnswer>) {
    return {
      getSlashCommands: vi.fn(async () => ({
        commands: [],
        truncated: false,
        origin: 'none' as const,
        workspacePath: null,
        engine: 'dsh' as const,
        ...answer,
      })),
    };
  }

  it('a worker of the workspace answers alone', async () => {
    const listSkills = vi.fn(async () => [row('from-disk')]);
    const dshHost = { listSlashCommands: vi.fn(async () => ({ commands: [], truncated: false })) };
    for (const origin of ['session', 'workspace'] as const) {
      const result = await composerSlashCommands(
        { sessionId: 's1', workspacePath: '/repo' },
        { workers: workers({ origin, commands: [row('from-worker')] }), dshHost, listSkills }
      );
      expect(result).toEqual({ commands: [row('from-worker')], truncated: false });
    }
    expect(listSkills).not.toHaveBeenCalled();
    expect(dshHost.listSlashCommands).not.toHaveBeenCalled();
  });

  it('decision 194: with none, the DSH host lists the folder the pool matched, sanitized', async () => {
    const listSkills = vi.fn(async () => [row('from-disk')]);
    const dshHost = {
      listSlashCommands: vi.fn(async () => ({
        commands: [
          row('goal', 'command'),
          row('plugin-skill'),
          { name: '', source: 'skill' } as WorkerSlashCommandInfo,
        ],
        truncated: false,
      })),
    };
    const pool = workers({ workspacePath: '/repo/alpha' });
    const result = await composerSlashCommands(
      { workspacePath: '/repo/alpha', engine: 'dsh' },
      { workers: pool, dshHost, listSkills }
    );
    expect(pool.getSlashCommands).toHaveBeenCalledWith({
      workspacePath: '/repo/alpha',
      engine: 'dsh',
    });
    expect(dshHost.listSlashCommands).toHaveBeenCalledWith('/repo/alpha');
    expect(listSkills).not.toHaveBeenCalled();
    expect(result).toEqual({
      commands: [row('goal', 'command'), row('plugin-skill')],
      truncated: false,
    });
  });

  it('a host that cannot answer falls back to the skills on disk', async () => {
    const log = vi.fn();
    const listSkills = vi.fn(async () => [row('plan-tree')]);
    const result = await composerSlashCommands(
      { workspacePath: '/repo/alpha' },
      {
        workers: workers({ workspacePath: '/repo/alpha' }),
        dshHost: {
          listSlashCommands: async () => {
            throw new Error('no ready DSH host');
          },
        },
        listSkills,
        log,
      }
    );
    expect(listSkills).toHaveBeenCalledWith('/repo/alpha');
    expect(result).toEqual({ commands: [row('plan-tree')], truncated: false });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a disk that cannot be read costs the skills, not the menu', async () => {
    const log = vi.fn();
    const result = await composerSlashCommands(
      { workspacePath: null },
      {
        workers: workers({}),
        listSkills: async () => {
          throw new Error('EIO');
        },
        log,
      }
    );
    expect(result).toEqual({ commands: [], truncated: false });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('decision 194: an SDK chat that is not up gets the CLI’s list, never DSH’s skills', async () => {
    const listSkills = vi.fn(async () => [row('from-disk')]);
    const dshHost = { listSlashCommands: vi.fn(async () => ({ commands: [], truncated: false })) };
    const sdkCatalog = {
      list: vi.fn(async () => ({ commands: [row('cli-skill')], truncated: false })),
    };
    const result = await composerSlashCommands(
      { workspacePath: '/repo', engine: 'claude-sdk' },
      {
        workers: workers({ engine: 'claude-sdk', workspacePath: '/repo' }),
        dshHost,
        sdkCatalog,
        listSkills,
      }
    );
    expect(result).toEqual({ commands: [row('cli-skill')], truncated: false });
    expect(sdkCatalog.list).toHaveBeenCalledWith('/repo');
    expect(listSkills).not.toHaveBeenCalled();
    expect(dshHost.listSlashCommands).not.toHaveBeenCalled();
    // Without a catalog (a build with no SDK host), nothing.
    expect(
      await composerSlashCommands(
        { workspacePath: '/repo', engine: 'claude-sdk' },
        { workers: workers({ engine: 'claude-sdk' }), listSkills }
      )
    ).toEqual({ commands: [], truncated: false });
  });
});

describe('the IPC handler wiring', () => {
  const chat = readFileSync(join(REPO, 'src/main/ipc/chat.ts'), 'utf8');
  const handler = chat.slice(chat.indexOf('IPC_CHANNELS.CHAT_GET_SLASH_COMMANDS,'));
  const body = handler.slice(0, handler.indexOf('ipcMain.handle('));

  it('answers through composerSlashCommands, with a checked workspace and the host’s homes', () => {
    expect(body).toContain('composerSlashCommands(');
    expect(body).toContain('workspacePath: usableWorkspace(payload.workspacePath)');
    expect(body).toContain("engine: payload.engine === 'claude-sdk' ? 'claude-sdk' : 'dsh'");
    expect(body).toContain('workers: workerManager');
    expect(body).toContain('dshHost: dshHostSupervisor');
    expect(body).toContain('sdkCatalog: claudeSdkCommandCatalog');
    expect(body).toContain('listDshSkillsFromDisk(workspacePath, currentDshSkillHomes())');
  });
});

// ---- against the installed DSH packages -------------------------------------------

describe.skipIf(!existsSync(DSH_SKILL_FS))('the same skills DSH’s own provider finds', () => {
  /** Every case the frontmatter reader distinguishes, as files in every root. */
  function corpus(): DshSkillHomes {
    const homes = homesIn(box);
    mkdirSync(join(box, 'repo', '.git'), { recursive: true });
    const files: Record<string, string> = {
      'repo/.dsh/skills/basic/SKILL.md': skill('basic', 'A plain one'),
      'repo/.dsh/skills/shared/SKILL.md': skill('shared', 'Project copy'),
      'repo/.dsh/skills/quoted.md': skill('quoted', '"a \\"q\\" \\u00e9 b"'),
      'repo/.dsh/skills/single/SKILL.md': skill('single', "'it''s fine'"),
      'repo/.dsh/skills/folded/SKILL.md':
        '---\nname: folded\ndescription: >\n  a\n  b\n\n  c\n---\n',
      'repo/.dsh/skills/literal/SKILL.md':
        '---\nname: literal\ndescription: |\n  line 1\n  line 2\n---\n',
      'repo/.dsh/skills/strip/SKILL.md': '---\nname: strip\ndescription: >-\n  a\n  b\n---\n',
      'repo/.agents/skills/multi/SKILL.md':
        '---\nname: multi\ndescription: line one\n  line two\n\n  line three\n---\n',
      'repo/.agents/skills/below/SKILL.md':
        '---\nname: below\ndescription:\n  on the next line\n---\n',
      'repo/.agents/skills/colon-bad/SKILL.md': skill('colon-bad', 'Use when: X'),
      'repo/.agents/skills/dup/SKILL.md': '---\nname: dup\nname: dup\ndescription: d\n---\n',
      'repo/.agents/skills/no-desc/SKILL.md': '---\nname: no-desc\n---\n',
      'repo/.agents/skills/bad-name/SKILL.md': skill('Bad_Name', 'Not kebab-case'),
      'repo/.agents/skills/numeric/SKILL.md': skill('123', 'A number'),
      'agent-dir/skills/user-off/SKILL.md': skill('user-off', 'Off', 'user-invocable: false\n'),
      'agent-dir/skills/user-yes/SKILL.md': skill('user-yes', 'Yes', 'user-invocable: yes\n'),
      'agent-dir/skills/user-bad/SKILL.md': skill('user-bad', 'Bad', 'user-invocable: maybe\n'),
      'agent-dir/skills/legacy/SKILL.md': skill('legacy', 'Legacy', 'userInvocable: true\n'),
      'agent-dir/skills/model-off.md': skill(
        'model-off',
        'Off',
        'disable-model-invocation: true\n'
      ),
      'agent-dir/skills/tools/SKILL.md': skill(
        'tools',
        'Tools',
        'allowed-tools:\n- Read\n- Grep\n'
      ),
      'agent-dir/skills/flow/SKILL.md': skill('flow', 'Flow', 'allowed-tools: [Read, Grep]\n'),
      'agent-dir/skills/meta/SKILL.md': skill('meta', 'Meta', 'metadata:\n  a: 1\n  b:\n    - x\n'),
      'dsh-home/skills/crlf/SKILL.md': '---\r\nname: crlf\r\ndescription: Windows lines\r\n---\r\n',
      'dsh-home/skills/no-frontmatter/SKILL.md': '# Just a body\n',
      'dsh-home/skills/unclosed/SKILL.md': '---\nname: unclosed\ndescription: d\n',
      'dsh-home/skills/comment/SKILL.md': skill('comment', 'text # a note'),
      'dsh-home/skills/hash/SKILL.md': skill('hash', 'C# and F#'),
      'dsh-home/skills/.system/SKILL.md': skill('dsh-system', 'Skipped here'),
      'dsh-home/skills/README.md': '# readme\n',
      'dsh-home/skills/UPPER.MD': skill('upper', 'Not a .md file to DSH'),
      'home/.agents/skills/shared/SKILL.md': skill('shared', 'User copy'),
      'home/.agents/skills/.system/SKILL.md': skill('agents-system', 'Kept here'),
      'home/.agents/skills/tab/SKILL.md': '---\nname: tab\ndescription: a\n\tb\n---\n',
      'home/.agents/skills/indented/SKILL.md': '---\n  name: indented\n  description: d\n---\n',
      'home/.agents/skills/empty-block/SKILL.md': '---\nname: empty-block\ndescription: |\n---\n',
      'home/.agents/skills/quoted-name/SKILL.md': '---\nname: "quoted-name"\ndescription: d\n---\n',
      'home/.agents/skills/no-skill-file/notes.md': skill('nested-notes', 'Never read'),
    };
    for (const [file, content] of Object.entries(files)) put(file, content);
    return homes;
  }

  async function dshCandidates(homes: DshSkillHomes, cwd: string) {
    const dsh = (await import(pathToFileURL(DSH_SKILL_FS).href)) as {
      FileSystemSkillProvider: new (
        ctx: unknown,
        control: unknown,
        config: Record<string, unknown>
      ) => {
        list(options: { cwd?: string }): Promise<unknown>;
        dispose(): Promise<void>;
      };
    };
    const provider = new dsh.FileSystemSkillProvider(
      { get: () => undefined, logger: { warn: () => undefined } },
      { invalidate: () => undefined, signal: new AbortController().signal },
      {
        watch: false,
        dshHome: homes.dshHome,
        agentsHome: homes.agentsHome,
        customSkillDirs: [join(homes.agentDir, 'skills')],
      }
    );
    try {
      const listed = (await provider.list({ cwd })) as Array<{
        name: string;
        description: string;
        source: string;
        rank: number;
        invocation: { modelInvocable: boolean; userInvocable: boolean };
      }>;
      return listed.map((candidate) => ({
        source: candidate.source,
        rank: candidate.rank,
        name: candidate.name,
        description: candidate.description,
        modelInvocable: candidate.invocation.modelInvocable,
        userInvocable: candidate.invocation.userInvocable,
      }));
    } finally {
      await provider.dispose();
    }
  }

  async function ourCandidates(homes: DshSkillHomes, cwd: string) {
    const files = source();
    const found: DshSkillCandidate[] = [];
    for (const root of dshSkillRoots(homes, await dshProjectRoot(files, cwd))) {
      found.push(...(await discoverDshSkillRoot(files, root)));
    }
    return found.map(
      ({ source: rootSource, rank, name, description, modelInvocable, userInvocable }) => ({
        source: rootSource,
        rank,
        name,
        description,
        modelInvocable,
        userInvocable,
      })
    );
  }

  it('finds every candidate DSH finds, root by root, with the same fields', async () => {
    const homes = corpus();
    const cwd = join(box, 'repo');
    const theirs = await dshCandidates(homes, cwd);
    expect(await ourCandidates(homes, cwd)).toEqual(theirs);
    // The corpus is not vacuous: both sides kept some and dropped others.
    expect(theirs.length).toBeGreaterThan(15);
    expect(theirs.map((candidate) => candidate.name)).not.toContain('colon-bad');
  });

  it('agrees without a git root, and from a subdirectory of one', async () => {
    const homes = corpus();
    mkdirSync(join(box, 'repo', 'src', 'deep'), { recursive: true });
    for (const cwd of [join(box, 'repo', 'src', 'deep'), join(box, 'home')]) {
      expect(await ourCandidates(homes, cwd)).toEqual(await dshCandidates(homes, cwd));
    }
  });
});

describe.skipIf(!existsSync(DSH_SKILL))(
  'constants pinned to the installed DSH and the bridge',
  () => {
    it('the skill name grammar is dsh-skill’s', () => {
      const theirs = readFileSync(DSH_SKILL, 'utf8').match(
        /const SKILL_NAME = (\/[^\n]+\/[a-z]*);/
      )?.[1];
      expect(theirs).toBe(String(DSH_SKILL_NAME));
    });

    it('the root table is dsh-skill-filesystem’s', () => {
      const fs = readFileSync(DSH_SKILL_FS, 'utf8');
      for (const [rankName, rank] of [
        ['PROJECT_DSH_RANK', 100],
        ['PROJECT_AGENTS_RANK', 200],
        ['CUSTOM_RANK', 300],
        ['USER_DSH_RANK', 400],
        ['USER_AGENTS_RANK', 500],
      ] as const) {
        expect(fs).toContain(`const ${rankName} = ${rank};`);
      }
      expect(fs).toContain('path: join(projectRoot, ".dsh/skills"),');
      expect(fs).toContain('path: join(projectRoot, ".agents/skills"),');
      expect(fs).toContain('path: join(this.dshHome, "skills"),');
      expect(fs).toContain('path: join(this.agentsHome, "skills"),');
      expect(fs).toContain('if (root.skipSystem && entry.name === ".system") continue;');
    });
  }
);

describe('constants pinned to the bridge', () => {
  it('the window-owned commands are the bridge’s', () => {
    const bridge = readFileSync(join(REPO, 'src/dsh-host/bridge/commands.ts'), 'utf8');
    const theirs = bridge.match(
      /export const WINDOW_OWNED_COMMANDS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\);/
    )?.[1];
    expect(theirs?.split(',').map((name) => name.trim().replace(/'/g, ''))).toEqual([
      ...WINDOW_OWNED_COMMAND_NAMES,
    ]);
  });

  it('the host gets its customSkillDirs from the same <agentDir>', () => {
    const profile = readFileSync(join(REPO, 'src/dsh-host/lib/hostProfile.ts'), 'utf8');
    expect(profile).toMatch(
      /\{ id: 'skill-filesystem', config: \{ customSkillDirs: \[`\$\{agentDir\}\/skills`\] \} \},/
    );
  });
});
