/**
 * dsh-rebase P1-7c (decision 120; plan P1-7 shard 04 §2-§5, shard 05 §4) —
 * the row tables have to speak DSH's tool dialect.
 *
 * `runtimeToolVocabulary.test.ts` reconciles the tables against the retired
 * runtime's registry; this file does the same against the DSH engine the
 * branch now runs. The list is the permission gate's classification table
 * (`src/dsh-host/permissions/classification.ts`), which its own tests pin to
 * every tool the pinned DSH and the allowlisted plugins register — so a DSH
 * upgrade that adds a tool fails here until the tool has a row.
 *
 * Each DSH tool is probed once, table-driven: its verb in both languages, its
 * icon, the one-line argument a plausible call reads as, and the fields that
 * argument already covers. The rest of the file pins the P1-7c rules that are
 * not a table entry: the pwsh prefix strip, the background-job and exit-code
 * tails, the timeout that moves a command to the background, the todo body,
 * the handle arguments and the unknown-tool fallback.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Translate, translate, zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  DSH_TOOL_CLASSES,
  PLUGIN_TOOL_CLASSES,
} from '../../../../dsh-host/permissions/classification.ts';
import {
  ARG_COVERED_FIELDS,
  classifyTool,
  composeRefArg,
  DSH_TOOL_NAMES,
  deriveFileLink,
  deriveToolRowView,
  JOB_OUTPUT_WAIT_VERB,
  OFFICE_READ_TOOL_NAMES,
  OFFICE_WRITE_TOOL_NAMES,
  outputMaxHeightClass,
  shellExitCode,
  shortPath,
  TOOL_VERBS,
  type ToolIconKind,
  type ToolRun,
  toolIconKind,
  toolVerb,
  UNKNOWN_TOOL_VERB,
  UPDATE_GOAL_VERBS,
} from '../toolCard';

const zh: Translate = (key, params) => translate('zh', key, params);

function run(toolName: string, input: unknown, overrides: Partial<ToolRun> = {}): ToolRun {
  return {
    toolCallId: `call-${toolName}`,
    blockIndex: 0,
    blockId: `block-${toolName}`,
    toolName,
    input,
    status: 'ok',
    output: 'result',
    ...overrides,
  };
}

/**
 * The DSH tools a row deliberately does not name. They read as the
 * unknown-tool fallback (「工具」 + the tool's name): `ralph` is off in
 * dsh-base (shard 04 §3), `structured_output` is a subagent's own return
 * channel, and `plugin_manager` installs host code our composition never
 * mounts (P1-10: no runtime installs).
 */
const FALLBACK_ON_PURPOSE: readonly string[] = ['ralph', 'structured_output', 'plugin_manager'];

interface Probe {
  input: Record<string, unknown>;
  /** The settled output, for the tools that read their argument off it. */
  output?: string;
  verb: string;
  zhVerb: string;
  icon: ToolIconKind;
  /** The one-line argument in English; `null` for a row that has none. */
  arg: string | null;
  /** The same in Chinese, when the argument is our own copy. */
  zhArg?: string;
}

const TODOS = [
  { content: 'Map the tool names', status: 'completed' },
  { content: 'Write the verbs', status: 'in_progress' },
  { content: 'Pin them in a test', status: 'pending' },
];

const GOAL_OUTPUT = JSON.stringify({
  goal: {
    id: 'goal-1',
    revision: 2,
    objective: 'Ship P1-7c',
    phase: 'active',
    roundsStarted: 3,
    maxGoalRounds: 256,
  },
  activation: 'armed',
});

/** One plausible call per tool, with DSH's own argument names (`name:` of each definition). */
const PROBES: Readonly<Record<string, Probe>> = {
  read: {
    input: { file_path: '/w/src/a.ts', path: '/w/src/a.ts', offset: 10, limit: 51 },
    verb: 'Read',
    zhVerb: '读取',
    icon: 'read',
    arg: 'src/a.ts L10-60',
  },
  read_image: {
    input: { file_path: '/w/shots/login.png', path: '/w/shots/login.png' },
    verb: 'Viewed image',
    zhVerb: '看图',
    icon: 'image',
    arg: 'shots/login.png',
  },
  write: {
    input: { file_path: '/w/src/a.ts', path: '/w/src/a.ts', content: 'x\n' },
    verb: 'Edited',
    zhVerb: '编辑',
    icon: 'edit',
    arg: 'src/a.ts',
  },
  edit: {
    input: { file_path: '/w/src/a.ts', path: '/w/src/a.ts', old_string: 'a', new_string: 'b' },
    verb: 'Edited',
    zhVerb: '编辑',
    icon: 'edit',
    arg: 'src/a.ts',
  },
  glob: {
    input: { pattern: '**/*.ts', path: 'src' },
    verb: 'Searched files',
    zhVerb: '搜索',
    icon: 'search',
    arg: '**/*.ts',
  },
  grep: {
    input: { pattern: 'TODO', path: 'src', include: '*.ts' },
    verb: 'Grepped',
    zhVerb: '搜索',
    icon: 'search',
    arg: 'TODO',
  },
  bash: {
    input: { command: 'cd /w && npm test', description: 'Run the tests' },
    verb: 'Ran',
    zhVerb: '终端',
    icon: 'terminal',
    arg: 'npm test',
  },
  pwsh: {
    input: { command: 'Set-Location C:\\repo; git status', description: 'Show the status' },
    verb: 'Ran',
    zhVerb: '终端',
    icon: 'terminal',
    arg: 'git status',
  },
  run_code: {
    input: { code: 'const rows = await tools.read()', description: 'Count the rows' },
    verb: 'Ran code',
    zhVerb: '代码',
    icon: 'terminal',
    arg: 'Count the rows',
  },
  workflow: {
    input: { script: 'return 1', meta: { name: 'triage', description: 'Sort the issues' } },
    verb: 'Ran workflow',
    zhVerb: '工作流',
    icon: 'workflow',
    arg: 'triage',
  },
  plugin_manager: {
    input: { action: 'install' },
    verb: 'Used tool',
    zhVerb: '工具',
    icon: 'tool',
    arg: 'plugin_manager',
  },
  skill: {
    input: { name: 'plan-tree' },
    verb: 'Loaded skill',
    zhVerb: '已加载技能',
    icon: 'tool',
    arg: 'plan-tree',
  },
  todo_write: {
    input: { todos: TODOS },
    verb: 'Planned',
    zhVerb: '规划',
    icon: 'todo',
    arg: '1/3 done',
    zhArg: '1/3 已完成',
  },
  job_list: {
    input: {},
    verb: 'Listed jobs',
    zhVerb: '后台列表',
    icon: 'job',
    arg: 'all background jobs',
    zhArg: '全部后台任务',
  },
  job_output: {
    input: { job_id: 'bash-3' },
    verb: 'Read job output',
    zhVerb: '后台输出',
    icon: 'job',
    arg: 'bash-3',
  },
  job_kill: {
    input: { job_id: 'bash-3', reason: 'no longer needed' },
    verb: 'Stopped job',
    zhVerb: '停止后台',
    icon: 'job',
    arg: 'bash-3',
  },
  subagent: {
    input: { description: 'Probe the goal projection', prompt: 'A long brief…' },
    verb: 'Delegated',
    zhVerb: '已委派',
    icon: 'delegate',
    arg: 'Probe the goal projection',
  },
  subagent_fork: {
    input: { description: 'Review the plan', prompt: 'A long brief…' },
    verb: 'Delegated',
    zhVerb: '已委派',
    icon: 'delegate',
    arg: 'Fork · Review the plan',
    zhArg: '分叉 · Review the plan',
  },
  list_agents: {
    input: { scope: 'descendants' },
    verb: 'Listed subagents',
    zhVerb: '已列出子 Agent',
    icon: 'delegate',
    arg: 'all descendants',
    zhArg: '全部后代',
  },
  list_subagent_models: {
    input: {},
    verb: 'Listed models',
    zhVerb: '列模型',
    icon: 'delegate',
    arg: null,
  },
  send_message: {
    input: { agent_id: 'aiclient-kid', message: 'Also check the fork path' },
    verb: 'Messaged subagent',
    zhVerb: '发消息',
    icon: 'delegate',
    arg: 'Also check the fork path',
  },
  interrupt_agent: {
    input: { agent_id: 'aiclient-kid' },
    verb: 'Interrupted subagent',
    zhVerb: '打断',
    icon: 'delegate',
    arg: 'aiclient-kid',
  },
  structured_output: {
    input: { value: 3 },
    verb: 'Used tool',
    zhVerb: '工具',
    icon: 'tool',
    arg: 'structured_output',
  },
  ralph: {
    input: { prompt: 'Keep going' },
    verb: 'Used tool',
    zhVerb: '工具',
    icon: 'tool',
    arg: 'ralph · Keep going',
  },
  get_goal: {
    input: {},
    output: GOAL_OUTPUT,
    verb: 'Checked goal',
    zhVerb: '查看目标',
    icon: 'goal',
    arg: 'Ship P1-7c',
  },
  create_goal: {
    input: { objective: 'Ship P1-7c', max_goal_rounds: 20 },
    output: GOAL_OUTPUT,
    verb: 'Set goal',
    zhVerb: '设定目标',
    icon: 'goal',
    arg: 'Ship P1-7c',
  },
  update_goal: {
    input: { goal_id: 'goal-1', revision: 2, action: 'blocked', blocked_reason: 'CI is down' },
    output: GOAL_OUTPUT,
    verb: 'Marked goal blocked',
    zhVerb: '目标受阻',
    icon: 'goal',
    arg: 'CI is down',
  },
  exit_plan_mode: {
    input: { plan: '# Rework the tool rows\n\n- read every name' },
    verb: 'Planned',
    zhVerb: '规划',
    icon: 'plan',
    arg: 'Rework the tool rows',
  },
  present: {
    input: { files: [{ path: '/w/out/report.docx', description: 'The report' }] },
    verb: 'Presented',
    zhVerb: '交付',
    icon: 'deliver',
    arg: 'report.docx',
  },
  ask_user_question: {
    input: {
      questions: [
        { id: 'q1', question: 'Which branch?' },
        { id: 'q2', question: 'Why?' },
      ],
    },
    verb: 'Asked',
    zhVerb: '询问',
    icon: 'tool',
    arg: 'Which branch?',
  },
  list_mcp_resources: {
    input: { server: 'docs' },
    verb: 'Listed resources',
    zhVerb: '列资源',
    icon: 'mcp',
    arg: 'docs',
  },
  list_mcp_resource_templates: {
    input: { server: 'docs', cursor: 'c-2' },
    verb: 'Listed resources',
    zhVerb: '列资源',
    icon: 'mcp',
    arg: 'docs',
  },
  read_mcp_resource: {
    input: { server: 'docs', uri: 'docs://guide/intro' },
    verb: 'Read',
    zhVerb: '读取',
    icon: 'mcp',
    arg: 'docs · docs://guide/intro',
  },
  web_search: {
    input: { queries: ['dsh jobs', 'cordis plugins'] },
    verb: 'Searched',
    zhVerb: '搜索',
    icon: 'web',
    arg: 'dsh jobs · cordis plugins',
  },
  web_fetch: {
    input: { url: 'https://example.com/a' },
    verb: 'Fetched',
    zhVerb: '获取',
    icon: 'web',
    arg: 'https://example.com/a',
  },
  // Decision 115: the office plugin — three reads, five writes.
  word_read: {
    input: { path: '/w/docs/spec.docx' },
    verb: 'Read',
    zhVerb: '读取',
    icon: 'read',
    arg: 'docs/spec.docx',
  },
  excel_read: {
    input: { path: '/w/data/q3.xlsx', sheet: 'Summary' },
    verb: 'Read',
    zhVerb: '读取',
    icon: 'read',
    arg: 'data/q3.xlsx',
  },
  ppt_read: {
    input: { path: '/w/deck/pitch.pptx' },
    verb: 'Read',
    zhVerb: '读取',
    icon: 'read',
    arg: 'deck/pitch.pptx',
  },
  word_create: {
    input: { path: '/w/docs/new.docx', content: [{ type: 'paragraph', text: 'Hi' }] },
    verb: 'Edited',
    zhVerb: '编辑',
    icon: 'edit',
    arg: 'docs/new.docx',
  },
  word_update: {
    input: { path: '/w/docs/spec.docx', edits: [] },
    verb: 'Edited',
    zhVerb: '编辑',
    icon: 'edit',
    arg: 'docs/spec.docx',
  },
  excel_create: {
    input: { path: '/w/data/new.xlsx', sheets: [] },
    verb: 'Edited',
    zhVerb: '编辑',
    icon: 'edit',
    arg: 'data/new.xlsx',
  },
  excel_update: {
    input: { path: '/w/data/q3.xlsx', cells: [] },
    verb: 'Edited',
    zhVerb: '编辑',
    icon: 'edit',
    arg: 'data/q3.xlsx',
  },
  ppt_create: {
    input: { path: '/w/deck/new.pptx', slides: [] },
    verb: 'Edited',
    zhVerb: '编辑',
    icon: 'edit',
    arg: 'deck/new.pptx',
  },
};

const DSH_TOOLS = Object.keys(DSH_TOOL_CLASSES).sort();
const PLUGIN_TOOLS = Object.keys(PLUGIN_TOOL_CLASSES).sort();
const ALL_TOOLS = [...DSH_TOOLS, ...PLUGIN_TOOLS];
const NAMED_TOOLS = ALL_TOOLS.filter((tool) => !FALLBACK_ON_PURPOSE.includes(tool));

describe('the row tables name every tool the DSH gate classifies', () => {
  it('read the classification tables, not an empty import', () => {
    // A renamed export would make every case below pass on nothing.
    expect(DSH_TOOLS.length).toBeGreaterThanOrEqual(30);
    expect(DSH_TOOLS).toContain('pwsh');
    expect(PLUGIN_TOOLS).toHaveLength(8);
  });

  it('every tool has a probe here, and every probe is a classified tool', () => {
    expect(Object.keys(PROBES).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('DSH_TOOL_NAMES spells only names the gate knows', () => {
    for (const name of Object.values(DSH_TOOL_NAMES)) {
      expect(DSH_TOOLS, name).toContain(name);
    }
    expect([...OFFICE_READ_TOOL_NAMES, ...OFFICE_WRITE_TOOL_NAMES].sort()).toEqual(PLUGIN_TOOLS);
    // The review's classification and the row's agree: reads read, writes write.
    for (const name of OFFICE_READ_TOOL_NAMES)
      expect(PLUGIN_TOOL_CLASSES[name]?.class).toBe('read');
    for (const name of OFFICE_WRITE_TOOL_NAMES)
      expect(PLUGIN_TOOL_CLASSES[name]?.class).toBe('write');
  });

  it.each(NAMED_TOOLS)('%s has its own verb triple, in both languages', (tool) => {
    const verbs = TOOL_VERBS[tool];
    expect(verbs, `${tool} has no entry in TOOL_VERBS`).toBeDefined();
    for (const word of [verbs.done, verbs.running, verbs.refused]) {
      expect(zhTranslations, `${tool}: ${word} is missing from zhTranslations`).toHaveProperty(
        word
      );
    }
  });

  it.each(NAMED_TOOLS)('%s declares which fields its arg already covers', (tool) => {
    expect(ARG_COVERED_FIELDS[tool], `${tool} has no entry in ARG_COVERED_FIELDS`).toBeDefined();
  });

  it.each(ALL_TOOLS)('%s reads right: verb, icon and argument', (tool) => {
    const probe = PROBES[tool] as Probe;
    const view = deriveToolRowView(
      run(tool, probe.input, probe.output ? { output: probe.output } : {})
    );
    expect(view.verb).toBe(probe.verb);
    expect(zh(view.verb)).toBe(probe.zhVerb);
    expect(view.iconKind).toBe(probe.icon);
    expect(view.arg ?? null).toBe(probe.arg);
    // The wire name alone is the fallback's argument, never a named tool's.
    if (!FALLBACK_ON_PURPOSE.includes(tool)) expect(view.arg).not.toBe(tool);
    if (probe.zhArg) {
      const zhView = deriveToolRowView(
        run(tool, probe.input, probe.output ? { output: probe.output } : {}),
        { t: zh }
      );
      expect(zhView.arg).toBe(probe.zhArg);
    }
  });

  it.each(FALLBACK_ON_PURPOSE)('%s is the unknown-tool fallback on purpose', (tool) => {
    expect(TOOL_VERBS[tool]).toBeUndefined();
    expect(toolVerb(tool, 'done')).toBe(UNKNOWN_TOOL_VERB.done);
  });
});

describe('the fallback no longer says it ran a command (decision 073 rule 1)', () => {
  it('reads 「工具」 + the tool’s own name, with a generic icon', () => {
    expect(UNKNOWN_TOOL_VERB).toEqual({
      done: 'Used tool',
      running: 'Using tool',
      refused: 'Use tool',
    });
    for (const word of Object.values(UNKNOWN_TOOL_VERB)) {
      expect(zh(word)).toMatch(/^工具/);
      expect(zh(word)).not.toContain('终端');
    }
    const bare = deriveToolRowView(run('acme_widget', {}));
    expect(bare.verb).toBe('Used tool');
    expect(bare.iconKind).toBe('tool');
    expect(bare.arg).toBe('acme_widget');
    expect(bare.argKind).toBe('ident');
    const probed = deriveToolRowView(run('acme_widget', { path: '/w/notes.txt' }));
    expect(probed.arg).toBe('acme_widget · /w/notes.txt');
  });

  it('keeps an MCP tool on its own words, with the plug the resource tools wear', () => {
    const view = deriveToolRowView(run('mcp__github__create_issue', {}));
    expect(view.verb).toBe('Called');
    expect(view.arg).toBe('github · create_issue');
    expect(view.iconKind).toBe('mcp');
  });
});

describe('the words that depend on the call’s input', () => {
  it.each([
    ['complete', 'Completed goal', '完成目标'],
    ['blocked', 'Marked goal blocked', '目标受阻'],
    ['pause', 'Paused goal', '暂停目标'],
    ['resume', 'Resumed goal', '继续目标'],
    ['edit', 'Edited goal', '编辑目标'],
  ])('update_goal with action %s reads %s', (action, done, zhDone) => {
    const input = { goal_id: 'g', revision: 1, action };
    expect(toolVerb(DSH_TOOL_NAMES.updateGoal, 'done', input)).toBe(done);
    expect(zh(done)).toBe(zhDone);
    const verbs = UPDATE_GOAL_VERBS[action];
    for (const word of [verbs?.done, verbs?.running, verbs?.refused]) {
      expect(zhTranslations, `${word}`).toHaveProperty(word as string);
    }
    // The refused form is the operation asked for, not a finished one.
    expect(verbs?.refused).not.toBe(verbs?.done);
  });

  it('update_goal with an action this build does not know keeps the generic words', () => {
    expect(toolVerb(DSH_TOOL_NAMES.updateGoal, 'done', { action: 'archive' })).toBe('Updated goal');
    expect(toolVerb(DSH_TOOL_NAMES.updateGoal, 'done')).toBe('Updated goal');
  });

  it('update_goal says what changed: the reason, the new objective, else the goal', () => {
    const edit = deriveToolRowView(
      run(DSH_TOOL_NAMES.updateGoal, { action: 'edit', objective: 'Ship P1-7d' })
    );
    expect(edit.arg).toBe('Ship P1-7d');
    const pause = deriveToolRowView(
      run(DSH_TOOL_NAMES.updateGoal, { action: 'pause' }, { output: GOAL_OUTPUT })
    );
    expect(pause.arg).toBe('Ship P1-7c');
    // The handles the model copied from get_goal are covered: no JSON body.
    expect(pause.input).toBeUndefined();
  });

  it('get_goal reads the goal off its result, and says when there is none', () => {
    const none = deriveToolRowView(
      run(DSH_TOOL_NAMES.getGoal, {}, { output: JSON.stringify({ goal: null }) }),
      { t: zh }
    );
    expect(none.arg).toBe('没有目标');
    // Still running: nothing to read yet, and no guess.
    const running = deriveToolRowView(
      run(DSH_TOOL_NAMES.getGoal, {}, { status: 'running', output: undefined })
    );
    expect(running.arg).toBeUndefined();
    // Not the shape: no argument rather than a wrong one.
    expect(deriveToolRowView(run(DSH_TOOL_NAMES.getGoal, {}, { output: 'oops' })).arg).toBe(
      undefined
    );
  });

  it('a job_output that waits reads 「等待中」 while it waits, and 「后台输出」 once done', () => {
    const input = { job_id: 'bash-3', wait: true, timeout_ms: 30_000 };
    const waiting = deriveToolRowView(
      run(DSH_TOOL_NAMES.jobOutput, input, { status: 'running', output: undefined })
    );
    expect(waiting.verb).toBe(JOB_OUTPUT_WAIT_VERB);
    expect(zh(waiting.verb)).toBe('等待中');
    expect(deriveToolRowView(run(DSH_TOOL_NAMES.jobOutput, input)).verb).toBe('Read job output');
    // A plain read is reading, not waiting.
    expect(
      deriveToolRowView(
        run(
          DSH_TOOL_NAMES.jobOutput,
          { job_id: 'bash-3' },
          { status: 'running', output: undefined }
        )
      ).verb
    ).toBe('Reading job output');
    // All its arguments are on the row: no JSON body under it.
    expect(deriveToolRowView(run(DSH_TOOL_NAMES.jobOutput, input)).input).toBeUndefined();
    // Its output is a command's output, and gets the shell's window.
    expect(outputMaxHeightClass(DSH_TOOL_NAMES.jobOutput)).toBe('max-h-[46vh]');
  });
});

describe('file rows read DSH’s file_path (decision 073 rule 3)', () => {
  it('reads file_path when the bridge alias is missing, and grows no JSON body from it', () => {
    const view = deriveToolRowView(run('read', { file_path: '/w/src/a.ts' }));
    expect(view.arg).toBe('src/a.ts');
    expect(view.input).toBeUndefined();
    const aliased = deriveToolRowView(
      run('read', { file_path: '/w/src/a.ts', path: '/w/src/a.ts' })
    );
    expect(aliased.input).toBeUndefined();
    expect(deriveToolRowView(run('write', { file_path: '/w/src/b.ts', content: 'x' })).arg).toBe(
      'src/b.ts'
    );
  });

  it('opens the image read_image looked at, and counts it as a read', () => {
    expect(
      deriveFileLink(run(DSH_TOOL_NAMES.readImage, { file_path: '/w/shots/login.png' }))
    ).toEqual({ path: '/w/shots/login.png' });
    expect(classifyTool(DSH_TOOL_NAMES.readImage)).toBe('read');
    // The office documents are reads too, but the editor cannot open them.
    expect(classifyTool('word_read')).toBe('read');
    expect(deriveFileLink(run('word_read', { path: '/w/docs/spec.docx' }))).toBeNull();
  });

  it('shortens a Windows path at its backslashes (shard 04 §6)', () => {
    expect(shortPath('C:\\repo\\src\\a.ts')).toBe('src/a.ts');
    expect(deriveToolRowView(run('read', { file_path: 'C:\\repo\\中文 目录\\a b.ts' })).arg).toBe(
      '中文 目录/a b.ts'
    );
  });
});

describe('shell rows (plan P1-7 shard 04 §4)', () => {
  it.each([
    ['Get-ChildItem', 'Get-ChildItem'],
    ['cd src; npm test', 'npm test'],
    ['Set-Location C:\\repo; git status', 'git status'],
    ['Set-Location -Path "C:\\my repo"; git status', 'git status'],
    ["set-location -LiteralPath 'C:\\a'; dir", 'dir'],
    ['Push-Location C:\\repo && git log', 'git log'],
    ['pushd src; cd lib; Get-ChildItem', 'Get-ChildItem'],
    // Nothing after it: the call really did only change directory.
    ['Set-Location C:\\repo', 'Set-Location C:\\repo'],
  ])('pwsh %s reads as %s', (command, summary) => {
    expect(deriveToolRowView(run(DSH_TOOL_NAMES.pwsh, { command })).arg).toBe(summary);
  });

  it('bash keeps its own rule: only `cd … &&` goes', () => {
    expect(deriveToolRowView(run('bash', { command: 'cd src; npm test' })).arg).toBe(
      'cd src; npm test'
    );
    expect(deriveToolRowView(run('bash', { command: 'cd src && npm test' })).arg).toBe('npm test');
  });

  it('opens onto the description, then the command as it ran, then the rest', () => {
    const view = deriveToolRowView(
      run(DSH_TOOL_NAMES.pwsh, {
        command: 'Set-Location C:\\repo; npm test',
        description: 'Run the tests',
        workdir: 'C:\\repo',
        timeoutMs: 300_000,
      })
    );
    expect(view.input).toBe(
      '# Run the tests\nSet-Location C:\\repo; npm test\n# workdir: C:\\repo\n# timeoutMs: 300000'
    );
    // No description: the command alone, still reachable in full.
    expect(deriveToolRowView(run('bash', { command: 'ls -la' })).input).toBe('ls -la');
    expect(outputMaxHeightClass(DSH_TOOL_NAMES.pwsh)).toBe('max-h-[46vh]');
  });

  it('a running command moves to the background at its timeout: default 120s, capped at 600s', () => {
    const running = (input: Record<string, unknown>) =>
      deriveToolRowView(
        run(DSH_TOOL_NAMES.pwsh, input, {
          status: 'running',
          output: undefined,
          execStartedAtMs: 1_000,
        })
      );
    expect(running({ command: 'npm test' }).runningTimeoutMs).toBe(120_000);
    expect(running({ command: 'npm test', timeoutMs: 300_000 }).runningTimeoutMs).toBe(300_000);
    expect(running({ command: 'npm test', timeoutMs: 3_600_000 }).runningTimeoutMs).toBe(600_000);
    // A background call returns at once; it has no deadline to show.
    expect(
      running({ command: 'npm run dev', run_in_background: true }).runningTimeoutMs
    ).toBeUndefined();
    expect(zh('to background at {{limit}}', { limit: '2m' })).toBe('2m 后转后台');
  });

  it('shows a non-zero exit as a neutral 「退出码 N」, off DSH’s marker only', () => {
    const settled = (output: string, overrides: Partial<ToolRun> = {}) =>
      deriveToolRowView(
        run(DSH_TOOL_NAMES.pwsh, { command: 'npm test' }, { output, ...overrides })
      );
    const three = settled('1 failing\n[exit code: 3]');
    expect(three.exitCode).toBe(3);
    expect(three.failed, 'the model judges a non-zero exit, not the row').toBe(false);
    expect(zh('Exit code {{code}}', { code: 3 })).toBe('退出码 3');
    expect(settled('all green').exitCode).toBeUndefined();
    expect(settled('boom\n[killed by signal: SIGKILL]').exitCode).toBeUndefined();
    // A mention that is not the last line is output, not a marker.
    expect(settled('[exit code: 2]\nand then more').exitCode).toBeUndefined();
    // Stop: Windows kills with exit 1, but the call reads 「已停止」, never 「退出码 1」.
    const stopped = settled('x\n[exit code: 1]', {
      status: 'failed',
      result: { content: [{ type: 'text', text: 'x' }], details: { stopped: true } },
    });
    expect(stopped.outcome).toBe('stopped');
    expect(stopped.exitCode).toBeUndefined();
    expect(stopped.failed).toBe(false);
    expect(shellExitCode('\n[exit code: 0]')).toBeUndefined();
  });
});

describe('where a call left its work (plan P1-7 shard 04 §4)', () => {
  const live = (backgroundJob: Record<string, unknown>, input: Record<string, unknown> = {}) =>
    deriveToolRowView(
      run(
        'bash',
        { command: 'npm run dev', ...input },
        {
          output: 'x',
          result: { content: [{ type: 'text', text: 'x' }], details: { backgroundJob } },
        }
      )
    );

  it('a command its timeout moved reads 「已转后台 · bash-3」, live', () => {
    const view = live({ id: 'bash-3', promoted: true });
    expect(view.backgroundJob).toEqual({ id: 'bash-3', promoted: true });
    expect(zh('Moved to background')).toBe('已转后台');
    expect(view.failed).toBe(false);
  });

  it('a run_in_background call reads 「后台 · bash-2」 live, 「后台」 replayed', () => {
    expect(live({ id: 'bash-2' }, { run_in_background: true }).backgroundJob).toEqual({
      id: 'bash-2',
      promoted: false,
    });
    expect(zh('In background')).toBe('后台');
    // History: DSH never logs the value the id came from.
    const replayed = deriveToolRowView(
      run(
        'bash',
        { command: 'npm run dev', run_in_background: true },
        {
          output: 'started background job bash-2',
        }
      )
    );
    expect(replayed.backgroundJob).toEqual({ promoted: false });
  });

  it('a promoted command replayed from history is an ordinary row: no text matching', () => {
    const view = deriveToolRowView(
      run(
        'bash',
        { command: 'npm test' },
        {
          output: 'x\n[still running after 120000ms; moved to background job bash-3]\n…',
        }
      )
    );
    expect(view.backgroundJob).toBeUndefined();
  });

  it('a call that never ran, or failed, left nothing behind', () => {
    const notStarted = deriveToolRowView(
      run(
        'bash',
        { command: 'npm run dev', run_in_background: true },
        {
          status: 'failed',
          output: 'The run ended before this call started.',
          result: { content: [], details: { notStarted: true } },
        }
      )
    );
    expect(notStarted.backgroundJob).toBeUndefined();
  });
});

describe('the todo_write row opens onto the list (decision 118’s handoff)', () => {
  it('draws the list, not JSON and not DSH’s acknowledgement', () => {
    const view = deriveToolRowView(
      run(DSH_TOOL_NAMES.todoWrite, { todos: TODOS }, { output: 'Todos updated' })
    );
    expect(view.body).toBe('todos');
    expect(view.expandable).toBe(true);
    expect(view.todos).toEqual(TODOS);
    expect(view.input).toBeUndefined();
    expect(view.output).toBeUndefined();
  });

  it('a failed write keeps its error body', () => {
    const view = deriveToolRowView(
      run(
        DSH_TOOL_NAMES.todoWrite,
        { todos: TODOS },
        {
          status: 'failed',
          output: 'invalid todos',
          errorText: 'invalid todos',
        }
      )
    );
    expect(view.body).toBe('output');
    expect(view.todos).toBeUndefined();
  });

  it('an unknown status reads as pending, an empty item is dropped', () => {
    const view = deriveToolRowView(
      run(DSH_TOOL_NAMES.todoWrite, {
        todos: [
          { content: 'a', status: 'weird' },
          { content: '', status: 'completed' },
        ],
      })
    );
    expect(view.todos).toEqual([{ content: 'a', status: 'pending' }]);
  });
});

describe('handle arguments carry a label the painting leaf looks up', () => {
  it('names the handle and keeps a fallback text', () => {
    const job = deriveToolRowView(run(DSH_TOOL_NAMES.jobKill, { job_id: 'bash-3' }));
    expect(job.argRef).toEqual({ kind: 'job', id: 'bash-3', format: 'id-label' });
    const message = deriveToolRowView(
      run(DSH_TOOL_NAMES.sendMessage, { agent_id: 'aiclient-kid', message: 'hi' })
    );
    expect(message.argRef).toEqual({ kind: 'subagent', id: 'aiclient-kid', format: 'to-label' });
    const interrupt = deriveToolRowView(
      run(DSH_TOOL_NAMES.interruptAgent, { agent_id: 'aiclient-kid' })
    );
    expect(interrupt.argRef).toEqual({ kind: 'subagent', id: 'aiclient-kid', format: 'label' });
    expect(deriveToolRowView(run('read', { file_path: '/w/a.ts' })).argRef).toBeUndefined();
  });

  it('composes 「bash-3 · npm test」, 「→ 调研」 and the label; without one, the fallback', () => {
    const job = { arg: 'bash-3', argKind: 'ident' as const };
    expect(
      composeRefArg(job, { kind: 'job', id: 'bash-3', format: 'id-label' }, 'npm test')
    ).toEqual({ text: 'bash-3 · npm test', kind: 'ident' });
    expect(
      composeRefArg(job, { kind: 'job', id: 'bash-3', format: 'id-label' }, undefined)
    ).toEqual({ text: 'bash-3', kind: 'ident' });
    const message = { arg: 'Also check X', argKind: undefined };
    expect(
      composeRefArg(message, { kind: 'subagent', id: 'k', format: 'to-label' }, '调研 goal 投影')
    ).toEqual({ text: '→ 调研 goal 投影', kind: 'prose' });
    expect(composeRefArg(message, { kind: 'subagent', id: 'k', format: 'to-label' }, '  ')).toEqual(
      { text: 'Also check X', kind: undefined }
    );
    expect(
      composeRefArg(
        { arg: 'k', argKind: 'ident' },
        { kind: 'subagent', id: 'k', format: 'label' },
        'Probe'
      )
    ).toEqual({ text: 'Probe', kind: 'prose' });
  });
});

describe('exit_plan_mode opens onto its plan as Markdown text', () => {
  it('uses the plan itself as the body, not an escaped JSON string', () => {
    const plan = '# Rework the rows\n\n- step one\n- step "two"';
    const view = deriveToolRowView(run(DSH_TOOL_NAMES.exitPlanMode, { plan }));
    expect(view.input).toBe(plan);
    // No heading: the first line stands for it.
    expect(
      deriveToolRowView(run(DSH_TOOL_NAMES.exitPlanMode, { plan: '\nJust do it\nnow' })).arg
    ).toBe('Just do it');
  });
});

/**
 * The icon decision lives in `toolIconKind`, the element in `ToolRows.tsx`'s
 * `ROW_ICONS` (the module the row model may not import). A kind with no entry
 * would silently fall back to the wrench there, so the map is read here.
 */
describe('every icon kind has an element', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../ToolRows.tsx'),
    'utf8'
  );
  const map = /const ROW_ICONS[^{]*\{([\s\S]*?)\n\};/.exec(source)?.[1] ?? '';

  it('read the map, not an empty match', () => {
    expect(map).toContain('terminal: SquareTerminal');
  });

  it.each([
    'image',
    'todo',
    'goal',
    'job',
    'workflow',
    'mcp',
    'deliver',
    'terminal',
    'delegate',
  ])('%s has an icon', (kind) => {
    expect(map).toMatch(new RegExp(`\\n\\s+${kind}: [A-Z]\\w+,`));
  });

  it('every kind a probe reaches is in the map', () => {
    for (const probe of Object.values(PROBES)) {
      expect(map, probe.icon).toMatch(new RegExp(`\\n\\s+${probe.icon}: [A-Z]\\w+,`));
    }
    expect(toolIconKind('acme_widget')).toBe('tool');
  });

  it('paints the P1-7c tails in the outcome slot, translated', () => {
    expect(source).toContain('data-slot="tool-row-job"');
    expect(source).toContain(
      "t(view.backgroundJob.promoted ? 'Moved to background' : 'In background')"
    );
    expect(source).toContain('data-slot="tool-row-exit"');
    expect(source).toContain("t('Exit code {{code}}', { code: view.exitCode })");
    expect(source).toContain("t('to background at {{limit}}'");
    expect(source).toContain("case 'todos':");
  });
});
