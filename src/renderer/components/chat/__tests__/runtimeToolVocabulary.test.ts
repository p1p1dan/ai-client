/**
 * subagent-data-06 — the row tables have to speak THIS app's tool dialect.
 *
 * `piToolVocabulary.test.ts` is the same shape one layer up: it pinned pi's own
 * lowercase built-ins after a backend swap made every lookup miss. This file
 * pins the next drift of the same kind, which the 2026-09-14 audit caught. The
 * 1.0.x runtime did not register pi's built-ins at all — it registered its own
 * (in the since-deleted `src/runtime`), and the two lists disagree on the one
 * name that matters most: the SDK calls its glob tool `find`, 1.0.x `glob`.
 *
 * The miss is silent in exactly the way the earlier one was — no type error,
 * `TOOL_VERBS` falls back to "Ran", `formatToolArgDetail` falls into `default:`
 * whose probe order finds `path` before `pattern` — so a `glob` row read
 * "Ran src" and never said what was being searched for.
 *
 * Both surfaces are asserted, because there is one derivation behind them and
 * the audit's report only mentioned one: the delegation panel builds its child
 * rows with `deriveToolRowView` (`subagentActivityModel.ts`), and so does the
 * main timeline.
 */

import { type Translate, translate, zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  deriveSubagentPanelRows,
  initialSubagentActivity,
  reduceSubagentActivity,
  type SubagentActivityState,
} from '../subagentActivityModel';
import {
  ARG_COVERED_FIELDS,
  classifyTool,
  deriveFileLink,
  deriveToolRowView,
  formatToolArg,
  formatToolArgKind,
  MCP_TOOL_VERB,
  mcpToolLabel,
  outputMaxHeightClass,
  RUNTIME_TOOL_NAMES,
  TOOL_RUN_OUTCOME_LABEL,
  TOOL_VERBS,
  type ToolClass,
  type ToolRun,
  toolRunOutcome,
  toolVerb,
  UNKNOWN_TOOL_VERB,
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

describe('this runtime’s tools have verbs of their own', () => {
  it.each([
    [RUNTIME_TOOL_NAMES.glob, 'Searched files', 'Searching files'],
    [RUNTIME_TOOL_NAMES.browserPreview, 'Previewed', 'Previewing'],
    [RUNTIME_TOOL_NAMES.ask, 'Asked', 'Asking'],
    [RUNTIME_TOOL_NAMES.skill, 'Loaded skill', 'Loading skill'],
    [RUNTIME_TOOL_NAMES.newContext, 'Started a new context', 'Starting a new context'],
    [RUNTIME_TOOL_NAMES.taskWait, 'Waited for subagents', 'Waiting for subagents'],
    [RUNTIME_TOOL_NAMES.taskList, 'Listed subagents', 'Listing subagents'],
    [RUNTIME_TOOL_NAMES.taskStop, 'Stopped subagents', 'Stopping subagents'],
  ])('%s reads as "%s"', (tool, done, running) => {
    expect(toolVerb(tool, 'done')).toBe(done);
    expect(toolVerb(tool, 'running')).toBe(running);
    // The point of the case: none of these is the unknown-tool fallback, which
    // is what every one of them printed before.
    expect(toolVerb(tool, 'done')).not.toBe(UNKNOWN_TOOL_VERB.done);
  });

  it('keeps Task on the delegation verb it already had', () => {
    expect(toolVerb(RUNTIME_TOOL_NAMES.task, 'done')).toBe('Delegated');
  });

  it('gives every MCP-bridged tool a verb by prefix, since no table can list them', () => {
    expect(toolVerb('mcp__github__create_issue', 'done')).toBe(MCP_TOOL_VERB.done);
    expect(toolVerb('mcp__github__create_issue', 'running')).toBe(MCP_TOOL_VERB.running);
    // Not a blanket rule: a name that is not MCP still falls back to "Ran".
    expect(toolVerb('SomethingElse', 'done')).toBe(UNKNOWN_TOOL_VERB.done);
  });
});

describe('the argument shown is what the call was about', () => {
  it('shows glob’s pattern, not the directory it was narrowed to', () => {
    // The exact shape from the audit: `glob({pattern, path})` rendered as
    // "Ran src" because `default:` probes `path` before `pattern`.
    expect(
      formatToolArg(run(RUNTIME_TOOL_NAMES.glob, { pattern: '**/*.test.ts', path: 'src' }))
    ).toBe('**/*.test.ts');
  });

  it('names the repo for glob when one is given, like every other search', () => {
    expect(
      formatToolArg(run(RUNTIME_TOOL_NAMES.glob, { pattern: 'TODO' }), { repoName: 'ai-client' })
    ).toBe('TODO in ai-client');
  });

  it('classifies glob as a search, so a burst of them aggregates', () => {
    expect(classifyTool(RUNTIME_TOOL_NAMES.glob)).toBe('search');
  });

  it('shows browser_preview’s path as an identifier', () => {
    const preview = run(RUNTIME_TOOL_NAMES.browserPreview, {
      path: '/w/site/index.html',
      focus: true,
    });
    expect(formatToolArg(preview)).toBe('site/index.html');
    expect(formatToolArgKind(preview)).toBe('ident');
  });

  it('shows what Task delegated to when the model gave no description', () => {
    expect(formatToolArg(run('Task', { agent: 'explorer', task: 'a very long brief…' }))).toBe(
      'explorer'
    );
    // A description still wins: it is what the model wrote for the user.
    expect(formatToolArg(run('Task', { agent: 'explorer', description: 'map the store' }))).toBe(
      'map the store'
    );
  });

  it('counts what TaskWait is waiting on rather than printing ids', () => {
    expect(formatToolArg(run(RUNTIME_TOOL_NAMES.taskWait, { delegationIds: ['a', 'b'] }))).toBe(
      '2 delegations'
    );
    expect(formatToolArg(run(RUNTIME_TOOL_NAMES.taskWait, { delegationIds: ['a'] }))).toBe(
      '1 delegation'
    );
    // No ids: what the call said, never a claim that anything is running.
    expect(formatToolArg(run(RUNTIME_TOOL_NAMES.taskWait, {}))).toBe('no delegation named');
    expect(formatToolArg(run(RUNTIME_TOOL_NAMES.taskWait, { delegationIds: [] }))).toBe(
      'no delegation named'
    );
  });

  // chat-tool-03: the four arg strings T020 wrote were bare literals, so a
  // Chinese window read 「已开新上下文 a fresh window」 -- our own verb beside our own
  // untranslated object. The `(s)` was the giveaway: no Chinese sentence needs it.
  it('writes its own arg copy in the window’s language, not only in English', () => {
    expect(formatToolArg(run(RUNTIME_TOOL_NAMES.newContext, {}), { t: zh })).toBe(
      zhTranslations['a fresh window']
    );
    expect(formatToolArg(run(RUNTIME_TOOL_NAMES.taskList, {}), { t: zh })).toBe(
      zhTranslations['all delegations']
    );
    expect(formatToolArg(run(RUNTIME_TOOL_NAMES.taskStop, {}), { t: zh })).toBe(
      zhTranslations['no delegation named']
    );
    // The 2026-09-24 loop: 「全部运行中」/「运行中的子 Agent」 on a row read as the
    // tool reporting live subagents after every one had finished.
    for (const input of [{}, { delegationIds: [] }]) {
      for (const tool of [
        RUNTIME_TOOL_NAMES.taskList,
        RUNTIME_TOOL_NAMES.taskStop,
        RUNTIME_TOOL_NAMES.taskWait,
      ]) {
        expect(formatToolArg(run(tool, input), { t: zh })).not.toContain('运行中');
      }
    }
    // Singular and plural are separate keys, the way every other counted arg in
    // this module already is -- one key plus "(s)" cannot be translated.
    expect(
      formatToolArg(run(RUNTIME_TOOL_NAMES.taskWait, { delegationIds: ['a'] }), { t: zh })
    ).toBe(translate('zh', '{{count}} delegation', { count: 1 }));
    expect(
      formatToolArg(run(RUNTIME_TOOL_NAMES.taskWait, { delegationIds: ['a', 'b'] }), { t: zh })
    ).toBe(translate('zh', '{{count}} delegations', { count: 2 }));
    // The same leftovers, under the same rule: pi's argument-less `ls`, and the
    // plan tools a replayed Claude-era transcript still carries.
    expect(formatToolArg(run('ls', {}), { t: zh })).toBe(zhTranslations['working directory']);
    expect(formatToolArg(run('TodoWrite', {}), { t: zh })).toBe(zhTranslations['next moves']);
  });

  it('shows an MCP call as its server and tool, not as a wire identifier', () => {
    expect(mcpToolLabel('mcp__github__create_issue')).toBe('github · create_issue');
    expect(formatToolArg(run('mcp__github__create_issue', {}))).toBe('github · create_issue');
  });

  // chat-tool-09: the wire name is `mcp__<server>__<tool>` and BOTH halves can
  // contain underscores, so the separator is the LAST `__`, not the first.
  it('splits an MCP name at the separator the producer used, not at the first underscore pair', () => {
    // A server named `jira_` composes `mcp__jira___createIssue`. Splitting at
    // the first pair moved the stray underscore onto the tool and dropped it
    // from the server, so `jira` and `jira_` were drawn under one name.
    expect(mcpToolLabel('mcp__jira___createIssue')).toBe('jira_ · createIssue');
    // A server whose own name contains `__` was cut in half and the rest glued
    // onto the tool.
    expect(mcpToolLabel('mcp__my__srv__x')).toBe('my__srv · x');
    // Unchanged in the ordinary case, which is the whole point.
    expect(mcpToolLabel('mcp__notion__search')).toBe('notion · search');
    // No separator at all: the name IS the server, and there is no tool half to
    // invent one for.
    expect(mcpToolLabel('mcp__notion')).toBe('notion');
    // Nothing after the prefix, or not an MCP name: no label, so every caller
    // keeps whatever it was going to print anyway.
    expect(mcpToolLabel('mcp__')).toBeUndefined();
    expect(mcpToolLabel('Bash')).toBeUndefined();
  });

  it('shows the skill a skill call loaded', () => {
    expect(formatToolArg(run(RUNTIME_TOOL_NAMES.skill, { name: 'plan-tree' }))).toBe('plan-tree');
  });
});

describe('the same words reach both surfaces', () => {
  const PARENT = 'toolu_parent_1';

  function panelRowsFor(input: Record<string, string | number>, name: string) {
    const events = [
      {
        type: 'subagent.activity',
        sessionId: 's1',
        payload: {
          parentToolCallId: PARENT,
          kind: 'started',
          agentId: 'agent-1',
          agentType: 'explorer',
        },
      },
      {
        type: 'subagent.activity',
        sessionId: 's1',
        payload: {
          parentToolCallId: PARENT,
          kind: 'tool.started',
          agentId: 'agent-1',
          toolCallId: 'child-1',
          name,
          input,
        },
      },
    ];
    const state = events.reduce<SubagentActivityState>(
      (accumulated, event) => reduceSubagentActivity(accumulated, event),
      initialSubagentActivity
    );
    return deriveSubagentPanelRows(state.lanes[PARENT], { parentRunning: true });
  }

  it('renders a delegate’s glob row with the pattern in the panel', () => {
    const rows = panelRowsFor({ pattern: '**/*.test.ts', path: 'src' }, RUNTIME_TOOL_NAMES.glob);
    const child = rows[0]?.detail?.find((row) => row.verb === 'Searching files');
    expect(child).toBeDefined();
    expect(child?.arg).toBe('**/*.test.ts');
  });

  it('renders the parent’s glob row the same way in the main timeline', () => {
    const view = deriveToolRowView(
      run(RUNTIME_TOOL_NAMES.glob, { pattern: '**/*.test.ts', path: 'src' })
    );
    expect(view.verb).toBe('Searched files');
    expect(view.arg).toBe('**/*.test.ts');
  });

  it('renders a delegate’s browser_preview row with its file', () => {
    const rows = panelRowsFor({ path: '/w/site/index.html' }, RUNTIME_TOOL_NAMES.browserPreview);
    const child = rows[0]?.detail?.find((row) => row.verb === 'Previewing');
    expect(child?.arg).toBe('site/index.html');
  });

  it('renders an MCP row on both surfaces by its server and tool', () => {
    const rows = panelRowsFor({}, 'mcp__github__create_issue');
    const child = rows[0]?.detail?.find((row) => row.verb === MCP_TOOL_VERB.running);
    expect(child?.arg).toBe('github · create_issue');

    const view = deriveToolRowView(run('mcp__github__create_issue', {}));
    expect(view.verb).toBe(MCP_TOOL_VERB.done);
    expect(view.arg).toBe('github · create_issue');
  });

  it('renders a TaskWait row on the main timeline with its own words', () => {
    const view = deriveToolRowView(run(RUNTIME_TOOL_NAMES.taskWait, { delegationIds: ['a'] }));
    expect(view.verb).toBe('Waited for subagents');
    expect(view.arg).toBe('1 delegation');
  });
});

// ---------------------------------------------------------------------------
// N5 (devbox 2026-09-24) — a call that never did its work does not read as done
// ---------------------------------------------------------------------------

/**
 * D2: the runtime refused five repeated idle `TaskStop` / `TaskWait` calls
 * ("Refused: … has nothing left to act on"), and every one read as an ordinary
 * grey 「已停止子 Agent / 已等待子 Agent」. D1: a loop-guard cut left 47 calls
 * none of which executed, and they read 「已列出 / 已停止 / 已等待」 in red.
 *
 * The judgement is the result's structured `details` (`ToolOutcomeDetails`),
 * which the projector forwards live and the history projection writes on
 * replay — never the English prose next to it.
 */
describe('a call that never did its work', () => {
  const refusedText =
    'Refused: TaskWait has nothing left to act on, and this run has already said so.';
  const refused = (tool: string) =>
    run(
      tool,
      {},
      {
        output: refusedText,
        result: {
          content: [{ type: 'text', text: refusedText }],
          details: { refused: true },
        },
      }
    );
  const notStarted = (tool: string, input: unknown = {}) =>
    run(tool, input, {
      status: 'failed',
      output: 'The run ended before this call started.',
      errorText: 'The run ended before this call started.',
      result: {
        content: [{ type: 'text', text: 'The run ended before this call started.' }],
        details: { notStarted: true },
      },
    });

  it.each([
    [RUNTIME_TOOL_NAMES.taskWait, 'Wait for subagents', '等待子 Agent'],
    [RUNTIME_TOOL_NAMES.taskStop, 'Stop subagents', '停止子 Agent'],
    [RUNTIME_TOOL_NAMES.taskList, 'List subagents', '列出子 Agent'],
  ])('[N5-REFUSED-1] a refused %s reads as the request plus 「已拒绝」', (tool, verb, zhVerb) => {
    const view = deriveToolRowView(refused(tool));
    expect(view.verb, 'the operation asked for, not a completed one').toBe(verb);
    expect(view.outcome).toBe('refused');
    expect(view.failed, 'a refusal is not a tool failure').toBe(false);
    expect(zh(view.verb)).toBe(zhVerb);
    expect(zh(TOOL_RUN_OUTCOME_LABEL.refused)).toBe('已拒绝');
    // The runtime's reason stays one click away: it is the only account of why.
    expect(view.body).toBe('output');
    expect(view.output).toBe(refusedText);
  });

  it.each([
    [RUNTIME_TOOL_NAMES.taskList, 'List subagents'],
    [RUNTIME_TOOL_NAMES.read, 'Read'],
    [RUNTIME_TOOL_NAMES.bash, 'Run'],
  ])('[N5-NOTSTARTED-1] a %s the run ended before reads 「未执行」, not done and not red', (tool, verb) => {
    const view = deriveToolRowView(notStarted(tool, PROBES[tool]?.input ?? {}));
    expect(view.verb).toBe(verb);
    expect(view.outcome).toBe('notStarted');
    expect(view.failed, 'nothing was attempted, so nothing failed').toBe(false);
    expect(view.running).toBe(false);
    expect(zh(TOOL_RUN_OUTCOME_LABEL.notStarted)).toBe('未执行');
    // No output of its own: only the runtime's English note, which the row's
    // own word already says in the reader's language.
    expect(view.body).toBeUndefined();
    expect(view.output).toBeUndefined();
  });

  it.each([
    [RUNTIME_TOOL_NAMES.bash, 'Ran'],
    [RUNTIME_TOOL_NAMES.read, 'Read'],
  ])('[P1-4a-UNKNOWN-1] a %s whose outcome the engine never recorded reads 「结果未知」, done form, not red', (tool, verb) => {
    // dsh-rebase decision 032: the engine's note is prose for the model.
    const note =
      'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown.';
    const view = deriveToolRowView(
      run(tool, PROBES[tool]?.input ?? {}, {
        status: 'failed',
        output: note,
        errorText: note,
        result: { content: [{ type: 'text', text: note }], details: { outcomeUnknown: true } },
      })
    );
    expect(view.outcome).toBe('outcomeUnknown');
    expect(view.verb, 'it did start').toBe(verb);
    expect(view.failed, 'nobody knows it failed').toBe(false);
    expect(view.body).toBeUndefined();
    expect(zh(TOOL_RUN_OUTCOME_LABEL.outcomeUnknown)).toBe('结果未知');
  });

  it('[N5-STRUCT-1] the words alone decide nothing — only the structured flag does', () => {
    // The live payload before the projector forwarded the flag: text only.
    const textOnly = deriveToolRowView(
      run(RUNTIME_TOOL_NAMES.taskWait, {}, { output: refusedText })
    );
    expect(textOnly.outcome).toBeUndefined();
    expect(textOnly.verb).toBe('Waited for subagents');
    const failedText = deriveToolRowView(
      run(
        RUNTIME_TOOL_NAMES.bash,
        {},
        {
          status: 'failed',
          output: 'The run ended before this call started.',
          errorText: 'The run ended before this call started.',
        }
      )
    );
    expect(failedText.outcome).toBeUndefined();
    expect(failedText.failed).toBe(true);
    // An ordinary structured result (a file change) is not an outcome either.
    expect(toolRunOutcome({ result: { content: [], details: { review: {} } } })).toBeNull();
    expect(toolRunOutcome({ result: { content: [], details: { refused: 'yes' } } })).toBeNull();
  });

  it('[N5-I18N-1] every outcome word has its Chinese entry', () => {
    for (const key of Object.values(TOOL_RUN_OUTCOME_LABEL)) {
      expect(zhTranslations, `${key} is missing from zhTranslations`).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// chat-tool-08 — every 1.0.x tool name still reads right
// ---------------------------------------------------------------------------

/**
 * The cases above are point-named: they answer "does THIS tool read right".
 * They cannot answer "did a tool appear that no table knows about", which is
 * how `chat-tool-01` lived from T-05 to the 2026-09-15 audit — `glob` and
 * `grep` had verbs, so every case here passed, while their hit lists never
 * rendered once on the native backend.
 *
 * Until dsh-rebase P1-12 step 3 this section read the self-owned runtime's
 * tool registry as its fixture and reconciled `RUNTIME_TOOL_NAMES` against it.
 * The registry went with `src/runtime` (decision 147), so the list is frozen
 * at what 1.0.x registered: a migrated or read-only 1.0.x session still holds
 * rows under exactly these names, and each must keep its verb, Chinese entry,
 * argument and covered-field list.
 */
const LEGACY_TOOL_NAMES = [...Object.values(RUNTIME_TOOL_NAMES)].sort();

interface ToolProbe {
  /** A call the model could plausibly make, with the tool's own argument names. */
  input: Record<string, unknown>;
  /** What the row's one-line argument must read as. */
  arg: string;
  /** Aggregation bucket, for the tools that have one. */
  bucket?: ToolClass;
  /** This tool's output is a hit list the popover can parse. */
  hitList?: boolean;
  /** This tool's row opens the file it touched. */
  link?: string;
  /** Output scroll window, when the tool is not on the default tier. */
  outputHeight?: string;
}

const PROBES: Readonly<Record<string, ToolProbe>> = {
  read: {
    input: { path: '/w/src/a.ts' },
    arg: 'src/a.ts',
    bucket: 'read',
    link: '/w/src/a.ts',
  },
  write: { input: { path: '/w/src/a.ts' }, arg: 'src/a.ts', link: '/w/src/a.ts' },
  edit: { input: { path: '/w/src/a.ts' }, arg: 'src/a.ts', link: '/w/src/a.ts' },
  // The Bash-family output tier, which is keyed on the tool name like every
  // other table here and had only the capitalised spellings in it.
  bash: {
    input: { command: 'pnpm vitest run' },
    arg: 'pnpm vitest run',
    outputHeight: 'max-h-[46vh]',
  },
  glob: { input: { pattern: '**/*.ts' }, arg: '**/*.ts', bucket: 'search', hitList: true },
  grep: { input: { pattern: 'TODO' }, arg: 'TODO', bucket: 'search', hitList: true },
  browser_preview: { input: { path: '/w/site/index.html' }, arg: 'site/index.html' },
  ask: { input: { questions: [{ question: 'Which branch?' }] }, arg: 'Which branch?' },
  skill: { input: { name: 'plan-tree' }, arg: 'plan-tree' },
  new_context: { input: {}, arg: 'a fresh window' },
  Task: { input: { agent: 'explorer' }, arg: 'explorer' },
  TaskWait: { input: { delegationIds: ['a'] }, arg: '1 delegation' },
  TaskList: { input: {}, arg: 'all delegations' },
  TaskStop: { input: { delegationIds: ['a', 'b'] }, arg: '2 delegations' },
};

describe('the renderer speaks for every tool 1.0.x registered', () => {
  const registered = LEGACY_TOOL_NAMES;

  it('covers the whole frozen list, not an empty one', () => {
    // The failure mode every enumeration has: an empty list makes every
    // assertion below pass on nothing at all.
    expect(registered.length).toBeGreaterThanOrEqual(14);
    expect(registered).toContain('read');
    expect(registered).toContain('Task');
  });

  it('every 1.0.x tool has a probe in this file', () => {
    expect(Object.keys(PROBES).sort()).toEqual(registered);
  });

  it.each(registered)('%s has its own verb triple, in both languages', (tool) => {
    const verbs = TOOL_VERBS[tool];
    // Presence in the table, not inequality with the fallback: `bash` really is
    // "Ran", so comparing the words would let a missing entry pass.
    expect(verbs, `${tool} has no entry in TOOL_VERBS`).toBeDefined();
    for (const word of [verbs.done, verbs.running, verbs.refused]) {
      expect(zhTranslations, `${tool}: ${word} is missing from zhTranslations`).toHaveProperty(
        word
      );
    }
  });

  it.each(registered)('%s says what the call was about, not what it is called', (tool) => {
    const probe = PROBES[tool];
    const view = deriveToolRowView(run(tool, probe.input));
    expect(view.arg).toBe(probe.arg);
    // `default:`'s last resort is the wire name itself, which is the shape the
    // audit found on every unlisted tool.
    expect(view.arg).not.toBe(tool);
  });

  it.each(registered)('%s declares which fields its arg already covers', (tool) => {
    // Without an entry the row grows a full JSON input body under a summary
    // that already said everything it had.
    expect(ARG_COVERED_FIELDS[tool], `${tool} has no entry in ARG_COVERED_FIELDS`).toBeDefined();
  });

  it.each(registered)('%s lands in the aggregation bucket it belongs to', (tool) => {
    expect(classifyTool(tool)).toBe(PROBES[tool].bucket ?? 'action');
  });

  it.each(registered)('%s offers a hit list exactly when its output is one', (tool) => {
    const probe = PROBES[tool];
    const view = deriveToolRowView(run(tool, probe.input, { output: 'src/a.ts:1:TODO' }));
    if (probe.hitList) expect(view.hitSource).toBe('src/a.ts:1:TODO');
    else expect(view.hitSource).toBeUndefined();
  });

  it.each(registered)('%s opens the file it touched, when it touched one', (tool) => {
    const probe = PROBES[tool];
    const link = deriveFileLink(run(tool, probe.input));
    if (probe.link) expect(link).toMatchObject({ path: probe.link });
    else expect(link).toBeNull();
  });

  it.each(registered)('%s gets the output scroll window its output size needs', (tool) => {
    expect(outputMaxHeightClass(tool)).toBe(PROBES[tool].outputHeight ?? 'max-h-[60vh]');
  });
});
