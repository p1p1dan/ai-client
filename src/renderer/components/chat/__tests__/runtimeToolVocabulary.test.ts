/**
 * subagent-data-06 — the row tables have to speak THIS app's tool dialect.
 *
 * `piToolVocabulary.test.ts` is the same shape one layer up: it pinned pi's own
 * lowercase built-ins after a backend swap made every lookup miss. This file
 * pins the next drift of the same kind, which the 2026-09-14 audit caught. Our
 * runtime does not register pi's built-ins at all — it registers its own
 * (`src/runtime/plugins/tools`), and the two lists disagree on the one name
 * that matters most: the SDK calls its glob tool `find`, we call it `glob`.
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

import { describe, expect, it } from 'vitest';
import {
  deriveSubagentPanelRows,
  initialSubagentActivity,
  reduceSubagentActivity,
  type SubagentActivityState,
} from '../subagentActivityModel';
import {
  classifyTool,
  deriveToolRowView,
  formatToolArg,
  formatToolArgKind,
  MCP_TOOL_VERB,
  mcpToolLabel,
  RUNTIME_TOOL_NAMES,
  type ToolRun,
  toolVerb,
  UNKNOWN_TOOL_VERB,
} from '../toolCard';

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
      '2 delegation(s)'
    );
    expect(formatToolArg(run(RUNTIME_TOOL_NAMES.taskWait, {}))).toBe('all running');
  });

  it('shows an MCP call as its server and tool, not as a wire identifier', () => {
    expect(mcpToolLabel('mcp__github__create_issue')).toBe('github · create_issue');
    expect(formatToolArg(run('mcp__github__create_issue', {}))).toBe('github · create_issue');
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
    expect(view.arg).toBe('1 delegation(s)');
  });
});
