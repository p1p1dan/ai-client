import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  classifyTool,
  countPermissionRecords,
  deriveAggregateRow,
  deriveRepoName,
  deriveToolGroupRows,
  deriveToolRowView,
  formatToolArg,
  formatToolArgKind,
  groupTimeline,
  isDelegationTool,
  joinResolvedPermissions,
  normalizeToolOutput,
  type PermissionJoinable,
  pairToolBlocks,
  shortPath,
  TOOL_VERBS,
  type ToolGroupEntry,
  type ToolRun,
  toolRowPermissionClass,
  toolRowPermissionNoteClass,
  toolRunWasRefused,
  toolVerb,
  UNKNOWN_TOOL_VERB,
} from '../toolCard';

const toolCardSource = readFileSync(
  fileURLToPath(new URL('../toolCard.ts', import.meta.url)),
  'utf8'
);

/**
 * Comments stripped. A negative scan must never be tripped by prose that spells
 * out the very thing it forbids — the head notes below explain WHY the decision
 * words are not re-spelled here, and would otherwise fail the rule they explain.
 */
const strippedToolCardSource = toolCardSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * Source text of one top-level `export function name(...) { ... }` body, read
 * from the comment-stripped source. Skips the parameter list first — an inline
 * param type (`view: { ... }`) would otherwise be mistaken for the body.
 */
function functionSource(name: string): string {
  const source = strippedToolCardSource;
  const start = source.indexOf(`export function ${name}`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let parens = 0;
  let afterParams = -1;
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (parens === 0) {
        afterParams = i + 1;
        break;
      }
    }
  }
  if (afterParams === -1) throw new Error(`unbalanced parens in ${name}`);
  const open = source.indexOf('{', afterParams);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function call(id: string, toolName: string, input: unknown = {}): ChatBlock {
  return { id, type: 'tool_call', toolCallId: id, toolName, toolInput: input };
}

function result(callId: string, overrides: Partial<ChatBlock> = {}): ChatBlock {
  return {
    id: `${callId}-result`,
    type: 'tool_result',
    toolCallId: callId,
    toolOk: true,
    ...overrides,
  };
}

function textBlock(id: string, text = 'hello'): ChatBlock {
  return { id, type: 'text', text };
}

function thinkingBlock(id: string, text = 'thinking...'): ChatBlock {
  return { id, type: 'thinking', text };
}

function message(blocks: ChatBlock[], id = 'm1'): ChatMessage {
  return { id, sessionId: 's1', role: 'assistant', blocks };
}

function makeRun(
  toolCallId: string,
  toolName: string,
  input: unknown = {},
  status: ToolRun['status'] = 'ok',
  overrides: Partial<ToolRun> = {}
): ToolRun {
  return {
    toolCallId,
    blockIndex: 0,
    blockId: toolCallId,
    toolName,
    input,
    status,
    output: status === 'ok' ? 'output text' : undefined,
    ...overrides,
  };
}

function runEntry(run: ToolRun): ToolGroupEntry {
  return { kind: 'run', run };
}

function thinkEntry(block: ChatBlock, blockIndex = 0): ToolGroupEntry {
  return { kind: 'thinking', block, blockIndex };
}

describe('pairToolBlocks', () => {
  it('pairs adjacent call/result blocks by toolCallId', () => {
    const runs = pairToolBlocks([call('c1', 'Read'), result('c1')]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ toolCallId: 'c1', toolName: 'Read', status: 'ok' });
  });

  it('pairs parallel call/result arrival (call A, call B, result A, result B) without cross-wiring', () => {
    const blocks = [call('a', 'Read'), call('b', 'Grep'), result('a'), result('b')];
    const runs = pairToolBlocks(blocks);
    expect(runs.map((run) => run.toolCallId)).toEqual(['a', 'b']);
    expect(runs.every((run) => run.status === 'ok')).toBe(true);
  });

  it('marks a call with no result as running', () => {
    const runs = pairToolBlocks([call('c1', 'Bash')]);
    expect(runs[0].status).toBe('running');
    expect(runs[0].output).toBeUndefined();
  });

  it('marks toolOk === false as failed, with errorText taken from tool_result.text', () => {
    const blocks = [call('c1', 'Bash'), result('c1', { toolOk: false, text: 'boom' })];
    const runs = pairToolBlocks(blocks);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].errorText).toBe('boom');
  });

  it('drops an orphan tool_result with no matching call', () => {
    expect(pairToolBlocks([result('ghost')])).toHaveLength(0);
  });

  it('preserves tool_call appearance order', () => {
    const blocks = [call('b', 'Grep'), call('a', 'Read'), result('a'), result('b')];
    const runs = pairToolBlocks(blocks);
    expect(runs.map((run) => run.toolCallId)).toEqual(['b', 'a']);
  });
});

describe('normalizeToolOutput', () => {
  it('returns a string as-is', () => {
    expect(normalizeToolOutput('hello')).toBe('hello');
  });

  it('joins a [{type:"text",text}] array with newlines', () => {
    const output = [
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ];
    expect(normalizeToolOutput(output)).toBe('line 1\nline 2');
  });

  it('JSON.stringifies a plain object with 2-space indent', () => {
    expect(normalizeToolOutput({ foo: 'bar' })).toBe(JSON.stringify({ foo: 'bar' }, null, 2));
  });

  it('falls back to the error text on empty output; both empty yields undefined', () => {
    expect(normalizeToolOutput(undefined, 'err')).toBe('err');
    expect(normalizeToolOutput('', 'err')).toBe('err');
    expect(normalizeToolOutput(undefined, undefined)).toBeUndefined();
    expect(normalizeToolOutput('', '')).toBeUndefined();
  });
});

describe('groupTimeline', () => {
  it('lets a text block break the tool group into two groups', () => {
    const blocks = [
      call('a', 'Read'),
      result('a'),
      textBlock('t1'),
      call('b', 'Grep'),
      result('b'),
    ];
    const items = groupTimeline(message(blocks));
    expect(items.map((item) => item.kind)).toEqual(['toolGroup', 'text', 'toolGroup']);
  });

  it('does not let a thinking block break the tool group', () => {
    const blocks = [call('a', 'Read'), thinkingBlock('th1'), result('a')];
    const items = groupTimeline(message(blocks));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('toolGroup');
    if (items[0].kind === 'toolGroup') {
      expect(items[0].entries.map((entry) => entry.kind)).toEqual(['run', 'thinking']);
    }
  });

  it('lets a question block break the tool group', () => {
    const blocks: ChatBlock[] = [call('a', 'Read'), result('a'), { id: 'q1', type: 'question' }];
    const items = groupTimeline(message(blocks));
    expect(items.map((item) => item.kind)).toEqual(['toolGroup', 'question']);
  });

  it('lets a permission block break the tool group', () => {
    const blocks: ChatBlock[] = [
      call('a', 'Read'),
      result('a'),
      { id: 'p1', type: 'permission_request', toolName: 'Bash' },
    ];
    const items = groupTimeline(message(blocks));
    expect(items.map((item) => item.kind)).toEqual(['toolGroup', 'permission']);
  });

  it('still produces a toolGroup when it holds only thinking entries', () => {
    const items = groupTimeline(message([thinkingBlock('th1')]));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('toolGroup');
  });

  it('never turns a tool_result block into its own item', () => {
    const items = groupTimeline(message([call('a', 'Read'), result('a')]));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('toolGroup');
  });

  it('returns an empty array for empty blocks', () => {
    expect(groupTimeline(message([]))).toEqual([]);
  });
});

describe('deriveToolGroupRows', () => {
  it('aggregates two consecutive explore runs into one row with two detail rows', () => {
    const entries = [
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
      runEntry(makeRun('b', 'Grep', { pattern: 'foo' })),
    ];
    const rows = deriveToolGroupRows(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].verb).toBe('Explored');
    expect(rows[0].detail).toHaveLength(2);
  });

  it('does not aggregate a single explore run (A07 :2348)', () => {
    const entries = [runEntry(makeRun('a', 'Read', { file_path: 'a.ts' }))];
    const rows = deriveToolGroupRows(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toBeUndefined();
    expect(rows[0].verb).toBe('Read');
  });

  it('keeps Edited + Ran as two separate rows, never aggregated (A07 :1769-1772)', () => {
    const entries = [
      runEntry(makeRun('a', 'Edit', { file_path: 'a.ts' })),
      runEntry(makeRun('b', 'Bash', { command: 'ls' })),
    ];
    const rows = deriveToolGroupRows(entries);
    expect(rows.map((row) => row.verb)).toEqual(['Edited', 'Ran']);
  });

  it('folds a thinking entry inside an explore run into detail without breaking aggregation (A07 :2370)', () => {
    const entries = [
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
      thinkEntry(thinkingBlock('th1')),
      runEntry(makeRun('b', 'Grep', { pattern: 'foo' })),
    ];
    const rows = deriveToolGroupRows(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toHaveLength(3);
    expect(rows[0].detail?.[1].body).not.toBe('output');
  });

  it('keeps a still-running call out of the aggregate: 1 completed + 1 running -> not aggregated, two independent rows (T-05 adversarial fix #1)', () => {
    const entries = [
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' }, 'ok')),
      runEntry(makeRun('b', 'Grep', { pattern: 'foo' }, 'running', { output: undefined })),
    ];
    const rows = deriveToolGroupRows(entries);
    expect(rows).toHaveLength(2);
    expect(rows[0].verb).toBe('Read');
    expect(rows[0].running).toBe(false);
    expect(rows[1].verb).toBe('Grepping');
    expect(rows[1].running).toBe(true);
    expect(rows[1].expandable).toBe(false);
  });

  it('aggregates the completed prefix (>= 2 runs) and appends a still-running call after it, in original order (T-05 adversarial fix #1)', () => {
    const entries = [
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' }, 'ok')),
      runEntry(makeRun('b', 'Grep', { pattern: 'foo' }, 'ok')),
      runEntry(makeRun('c', 'WebSearch', { query: 'bar' }, 'running', { output: undefined })),
    ];
    const rows = deriveToolGroupRows(entries);
    expect(rows).toHaveLength(2);
    expect(rows[0].verb).toBe('Explored');
    expect(rows[0].running).toBe(false);
    expect(rows[0].detail).toHaveLength(2);
    expect(rows[1].verb).toBe('Searching');
    expect(rows[1].running).toBe(true);
    expect(rows[1].expandable).toBe(false);
  });

  it('never lets a detail row carry its own nested detail (flat, depth 0)', () => {
    const entries = [
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
      runEntry(makeRun('b', 'Grep', { pattern: 'foo' })),
    ];
    const rows = deriveToolGroupRows(entries);
    expect(rows[0].detail?.every((row) => row.detail === undefined)).toBe(true);
  });
});

describe('buildThoughtRow empty-block behavior (via deriveToolGroupRows)', () => {
  // T-05 intended change, approved & registered in the T-05 ledger: an
  // empty-text thinking block renders as a bare, non-expandable row instead
  // of the old expandable-but-empty placeholder shell — the bare row is the
  // honest Cursor form. This locks that intended behavior, not a regression.
  it('renders an empty-text standalone thinking block as a bare row with no chevron', () => {
    const entries = [thinkEntry(thinkingBlock('th1', ''))];
    const rows = deriveToolGroupRows(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].expandable).toBe(false);
    expect(rows[0].body).toBeUndefined();
  });

  it('marks the Thought row arg as prose (D25 §2.4): "for Ns" is sans, not mono', () => {
    const entries = [thinkEntry(thinkingBlock('th1'))];
    const rows = deriveToolGroupRows(entries, { thinkingDurationMs: () => 12_000 });
    expect(rows[0].arg).toBe('for 12s');
    expect(rows[0].argKind).toBe('prose');
  });
});

describe('deriveAggregateRow', () => {
  it('3 Read + 11 Grep -> "Explored 3 files, 11 searches"', () => {
    const entries = [
      ...['a.ts', 'b.ts', 'c.ts'].map((path, i) =>
        runEntry(makeRun(`r${i}`, 'Read', { file_path: path }))
      ),
      ...Array.from({ length: 11 }, (_, i) =>
        runEntry(makeRun(`g${i}`, 'Grep', { pattern: `p${i}` }))
      ),
    ];
    const row = deriveAggregateRow(entries);
    expect(`${row.verb} ${row.arg}`).toBe('Explored 3 files, 11 searches');
    // D25 §2.4: "N files, M searches" is a number+prose summary, sans -- not mono.
    expect(row.argKind).toBe('prose');
  });

  it('omits the searches segment when only Read runs are present', () => {
    const entries = [
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
      runEntry(makeRun('b', 'Read', { file_path: 'b.ts' })),
    ];
    const row = deriveAggregateRow(entries);
    expect(`${row.verb} ${row.arg}`).toBe('Explored 2 files');
  });

  it('omits the files segment when only search-class runs are present', () => {
    const entries = Array.from({ length: 4 }, (_, i) =>
      runEntry(makeRun(`g${i}`, 'Grep', { pattern: `p${i}` }))
    );
    const row = deriveAggregateRow(entries);
    expect(`${row.verb} ${row.arg}`).toBe('Explored 4 searches');
  });

  it('uses singular wording for exactly one file/search', () => {
    const entries = [
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
      runEntry(makeRun('b', 'Grep', { pattern: 'p' })),
    ];
    expect(deriveAggregateRow(entries).arg).toBe('1 file, 1 search');
  });

  it('counts a repeated file_path across Read runs only once', () => {
    const entries = [
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
      runEntry(makeRun('b', 'Read', { file_path: 'a.ts' })),
    ];
    expect(deriveAggregateRow(entries).arg).toBe('1 file');
  });

  // F-B14 (T-31 §4.5) covered a third "ran N command(s)" counting segment.
  // Withdrawn in the T-31 review: `classifyTool` calls Bash an `action`, and
  // `deriveToolGroupRows` splits every action out to a standalone row BEFORE
  // aggregation, so no production render could ever reach the branch — the
  // three cases here asserted a code path only a direct unit call could enter.
  // The F-B numbering is deliberately not re-flowed; F-B14 stays retired so the
  // spec's own numbering still traces. Reinstating it needs a baseline revision
  // of A07 :1769-1772 ("an action call is always its own row"), which is a
  // user-accepted ruling.

  it('uses the running verb when any run is still running', () => {
    const entries = [
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' }, 'ok')),
      runEntry(makeRun('b', 'Read', { file_path: 'b.ts' }, 'running', { output: undefined })),
    ];
    expect(deriveAggregateRow(entries).verb).toBe('Exploring');
  });

  it('propagates failure: any child call with toolOk === false makes the aggregate row destructive with the failing detail row intact (T-05 adversarial fix #2)', () => {
    const entries = [
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' }, 'ok')),
      runEntry(
        makeRun('b', 'Grep', { pattern: 'foo' }, 'failed', { output: undefined, errorText: 'boom' })
      ),
    ];
    const row = deriveAggregateRow(entries);
    expect(row.failed).toBe(true);
    expect(row.detail).toHaveLength(2);
    expect(row.detail?.[1].failed).toBe(true);
    // ToolRows.tsx's existing `defaultOpen={view.failed}` chain (unchanged)
    // auto-expands this row purely off `failed` — body/expandable already
    // carry the 'detail' shape regardless of failure.
    expect(row.expandable).toBe(true);
    expect(row.body).toBe('detail');
  });
});

describe('toolVerb / classifyTool', () => {
  it('matches the A07 :2539 verb table', () => {
    expect(toolVerb('Bash', 'done')).toBe('Ran');
    expect(toolVerb('Bash', 'running')).toBe('Running');
    expect(toolVerb('Grep', 'done')).toBe('Grepped');
    expect(toolVerb('Grep', 'running')).toBe('Grepping');
    expect(toolVerb('Glob', 'done')).toBe('Searched files');
    expect(toolVerb('Glob', 'running')).toBe('Searching files');
    expect(toolVerb('Read', 'done')).toBe('Read');
    expect(toolVerb('Read', 'running')).toBe('Reading');
    expect(toolVerb('Edit', 'done')).toBe('Edited');
    expect(toolVerb('Edit', 'running')).toBe('Editing');
  });

  it('falls back to Ran/Running for an unknown tool name', () => {
    expect(toolVerb('SomeUnknownTool', 'done')).toBe('Ran');
    expect(toolVerb('SomeUnknownTool', 'running')).toBe('Running');
  });

  it('classifies an mcp__server__tool call as action, so it never aggregates', () => {
    expect(classifyTool('mcp__server__tool')).toBe('action');
  });

  // T-34 probe: cometix 2.1.212 names the delegation tool `Agent`; older
  // CLIs said `Task`. Both spellings get the Delegated treatment — before
  // this, the live `Agent` rows fell through to the unknown-tool "Ran".
  it('treats Task and Agent as the same delegation tool', () => {
    for (const name of ['Task', 'Agent']) {
      expect(toolVerb(name, 'done')).toBe('Delegated');
      expect(toolVerb(name, 'running')).toBe('Delegating');
      expect(classifyTool(name)).toBe('action');
      expect(isDelegationTool(name)).toBe(true);
    }
  });

  it('isDelegationTool rejects every non-delegation action tool', () => {
    for (const name of ['Bash', 'Edit', 'TodoWrite', 'mcp__server__tool', 'SomeUnknownTool']) {
      expect(isDelegationTool(name)).toBe(false);
    }
  });

  it('deriveToolRowView never sets defaultOpen — the failed-only fallback stays in charge', () => {
    expect(deriveToolRowView(makeRun('a', 'Agent', { description: 'probe' }))).not.toHaveProperty(
      'defaultOpen'
    );
  });
});

describe('formatToolArg', () => {
  it('shows the last two path segments for Read', () => {
    const run = makeRun('a', 'Read', { file_path: '/repo/src/chat/questionBridge.ts' });
    expect(formatToolArg(run)).toBe('chat/questionBridge.ts');
  });

  it('appends L{offset}-{offset+limit-1} when Read carries offset/limit', () => {
    const run = makeRun('a', 'Read', {
      file_path: '/repo/src/chat/questionBridge.ts',
      offset: 1,
      limit: 80,
    });
    expect(formatToolArg(run)).toBe('chat/questionBridge.ts L1-80');
  });

  it('appends " in {repo}" for Grep when repoName is given', () => {
    const run = makeRun('a', 'Grep', { pattern: 'foo' });
    expect(formatToolArg(run, { repoName: 'ai-client' })).toBe('foo in ai-client');
  });

  it('omits the repo tail for Grep without a repoName', () => {
    const run = makeRun('a', 'Grep', { pattern: 'foo' });
    expect(formatToolArg(run)).toBe('foo');
  });

  it('appends " in {repo}" for Glob', () => {
    const run = makeRun('a', 'Glob', { pattern: '**/*Question*' });
    expect(formatToolArg(run, { repoName: 'ai-client' })).toBe('**/*Question* in ai-client');
  });

  it('prefers description over command for Bash', () => {
    const withDescription = makeRun('a', 'Bash', { command: 'ls -la', description: 'List files' });
    expect(formatToolArg(withDescription)).toBe('List files');
    const withoutDescription = makeRun('b', 'Bash', { command: 'ls -la' });
    expect(formatToolArg(withoutDescription)).toBe('ls -la');
  });

  it('falls back through common fields for an unknown tool, then toolName when none match', () => {
    const withField = makeRun('a', 'mcp__server__tool', { description: 'do a thing' });
    expect(formatToolArg(withField)).toBe('do a thing');
    const withNoFields = makeRun('b', 'mcp__server__tool', {});
    expect(formatToolArg(withNoFields)).toBe('mcp__server__tool');
  });

  it('returns an overlong argument untouched (truncation is CSS-only, not this function)', () => {
    const long = 'x'.repeat(500);
    const run = makeRun('a', 'WebSearch', { query: long });
    expect(formatToolArg(run)).toBe(long);
  });

  it('shows description (falling back to subagent_type) for both delegation spellings', () => {
    for (const name of ['Task', 'Agent']) {
      const withDescription = makeRun('a', name, {
        description: 'shape probe',
        subagent_type: 'general-purpose',
        prompt: 'do the thing',
      });
      expect(formatToolArg(withDescription)).toBe('shape probe');
      const withoutDescription = makeRun('b', name, { subagent_type: 'general-purpose' });
      expect(formatToolArg(withoutDescription)).toBe('general-purpose');
    }
  });
});

describe('formatToolArgKind (D25 §2.4 arg font-domain)', () => {
  it('classifies Read/NotebookRead/Edit/Write/NotebookEdit paths as ident', () => {
    expect(formatToolArgKind(makeRun('a', 'Read', { file_path: 'a.ts' }))).toBe('ident');
    expect(formatToolArgKind(makeRun('a', 'NotebookRead', { file_path: 'a.ipynb' }))).toBe('ident');
    expect(formatToolArgKind(makeRun('a', 'Edit', { file_path: 'a.ts' }))).toBe('ident');
    expect(formatToolArgKind(makeRun('a', 'MultiEdit', { file_path: 'a.ts' }))).toBe('ident');
    expect(formatToolArgKind(makeRun('a', 'Write', { file_path: 'a.ts' }))).toBe('ident');
    expect(formatToolArgKind(makeRun('a', 'NotebookEdit', { file_path: 'a.ipynb' }))).toBe('ident');
  });

  it('classifies WebFetch url as ident', () => {
    expect(formatToolArgKind(makeRun('a', 'WebFetch', { url: 'https://example.com' }))).toBe(
      'ident'
    );
  });

  it('classifies Bash with a description as prose, falling back to ident for a bare command', () => {
    const withDescription = makeRun('a', 'Bash', { command: 'ls -la', description: 'List files' });
    expect(formatToolArgKind(withDescription)).toBe('prose');
    const withoutDescription = makeRun('b', 'Bash', { command: 'ls -la' });
    expect(formatToolArgKind(withoutDescription)).toBe('ident');
  });

  it('leaves argKind undefined for a branch D25 §2.4 does not cover (safe sans default)', () => {
    expect(formatToolArgKind(makeRun('a', 'Grep', { pattern: 'foo' }))).toBeUndefined();
  });
});

describe('deriveToolRowView', () => {
  it('forces body "output" and expandable=true when failed', () => {
    const run = makeRun('a', 'Bash', { command: 'false' }, 'failed', {
      output: undefined,
      errorText: 'boom',
    });
    const view = deriveToolRowView(run);
    expect(view.failed).toBe(true);
    expect(view.body).toBe('output');
    expect(view.expandable).toBe(true);
  });

  it('shows body "output" (collapsed by default at the component layer) when ok with output', () => {
    const run = makeRun('a', 'Bash', { command: 'ls' }, 'ok', { output: 'file1\nfile2' });
    const view = deriveToolRowView(run);
    expect(view.body).toBe('output');
    expect(view.output).toBe('file1\nfile2');
  });

  it('has no chevron (expandable=false) when ok with no output', () => {
    const run = makeRun('a', 'Bash', { command: 'true' }, 'ok', { output: undefined });
    const view = deriveToolRowView(run);
    expect(view.expandable).toBe(false);
    expect(view.body).toBeUndefined();
  });

  it('is never expandable while running', () => {
    const run = makeRun('a', 'Bash', { command: 'sleep 5' }, 'running', { output: undefined });
    expect(deriveToolRowView(run).expandable).toBe(false);
  });

  it('gives a Read row a file link with path/line/endLine', () => {
    const run = makeRun('a', 'Read', { file_path: '/repo/a.ts', offset: 10, limit: 5 });
    expect(deriveToolRowView(run).link).toEqual({ path: '/repo/a.ts', line: 10, endLine: 14 });
  });

  it('carries argKind onto the view (D25 §2.4): ident for a path, prose for a Bash description', () => {
    const read = makeRun('a', 'Read', { file_path: '/repo/a.ts' });
    expect(deriveToolRowView(read).argKind).toBe('ident');
    const bashWithDescription = makeRun('b', 'Bash', {
      command: 'ls -la',
      description: 'List files',
    });
    expect(deriveToolRowView(bashWithDescription).argKind).toBe('prose');
  });

  it('carries the raw output as hitSource for Grep/Glob', () => {
    const run = makeRun('a', 'Grep', { pattern: 'foo' }, 'ok', { output: 'a.ts\nb.ts' });
    expect(deriveToolRowView(run).hitSource).toBe('a.ts\nb.ts');
  });

  it('picks the 46vh scroll window for Bash and 60vh for Read', () => {
    const bash = makeRun('a', 'Bash', { command: 'ls' }, 'ok', { output: 'x' });
    const read = makeRun('b', 'Read', { file_path: '/a.ts' }, 'ok', { output: 'x' });
    expect(deriveToolRowView(bash).outputMaxHeightClass).toBe('max-h-[46vh]');
    expect(deriveToolRowView(read).outputMaxHeightClass).toBe('max-h-[60vh]');
  });

  it('shows a 240px input body only when structured input has fields the arg summary does not already cover (T-05 adversarial fix #3)', () => {
    const withExtraFields = makeRun(
      'a',
      'Edit',
      { file_path: '/repo/a.ts', old_string: 'foo', new_string: 'bar' },
      'ok',
      { output: undefined }
    );
    const withExtraView = deriveToolRowView(withExtraFields);
    expect(withExtraView.input).toContain('old_string');
    expect(withExtraView.inputMaxHeightClass).toBe('max-h-[240px]');
    expect(withExtraView.expandable).toBe(true);

    // file_path is the only field Edit's arg summary needs -> no input body,
    // and (with no output either) the row stays non-expandable.
    const argOnly = makeRun('b', 'Edit', { file_path: '/repo/a.ts' }, 'ok', { output: undefined });
    const argOnlyView = deriveToolRowView(argOnly);
    expect(argOnlyView.input).toBeUndefined();
    expect(argOnlyView.expandable).toBe(false);
  });
});

describe('deriveRepoName / shortPath', () => {
  it('takes the basename of a workspace path', () => {
    expect(deriveRepoName('/home/dan/projects/ai-client')).toBe('ai-client');
  });

  it('tolerates a trailing slash and Windows backslashes', () => {
    expect(deriveRepoName('/home/dan/projects/ai-client/')).toBe('ai-client');
    expect(deriveRepoName('C:\\Users\\dan\\ai-client')).toBe('ai-client');
  });

  it('returns null for an empty or missing path', () => {
    expect(deriveRepoName('')).toBeNull();
    expect(deriveRepoName(undefined)).toBeNull();
    expect(deriveRepoName(null)).toBeNull();
  });

  it('returns shortPath as-is when it has fewer segments than requested', () => {
    expect(shortPath('a.ts', 2)).toBe('a.ts');
    expect(shortPath('a/b.ts', 3)).toBe('a/b.ts');
  });
});

// ---------------------------------------------------------------------------
// FB7 — one authorization round-trip renders as ONE row
// ---------------------------------------------------------------------------

/**
 * The tool_call block id IS the permission id on the Claude path, so a joining
 * fixture passes the SAME string for both. A fixture that wants the fallback
 * passes a permission id no tool_call carries (a synthesised `perm-…`, or the
 * Codex `codex:<session>:<rpcId>` shape).
 */
function permission(id: string, overrides: Partial<ChatBlock> = {}): ChatBlock {
  return {
    id,
    type: 'permission_request',
    toolName: 'Write',
    permissionId: id,
    resolved: true,
    allowed: true,
    ...overrides,
  };
}

/** What `flattenTurnItems` hands the join: every message's items, stamped and concatenated. */
function turnItems(...messages: ChatMessage[]) {
  return messages.flatMap((msg) =>
    groupTimeline(msg).map((item) => ({ ...item, messageId: msg.id }))
  );
}

function runsOf(items: readonly PermissionJoinable[]): ToolRun[] {
  return items.flatMap((item) =>
    item.kind === 'toolGroup'
      ? item.entries.flatMap((entry) => (entry.kind === 'run' ? [entry.run] : []))
      : []
  );
}

function runFor(items: readonly PermissionJoinable[], blockId: string): ToolRun {
  const run = runsOf(items).find((candidate) => candidate.blockId === blockId);
  if (!run) throw new Error(`no run for block ${blockId}`);
  return run;
}

describe('[FB7-1] a resolved permission merges into the tool row it settled', () => {
  it('Allowed arm: the standalone permission item is gone and the run carries the decision', () => {
    const items = turnItems(message([call('a', 'Write'), result('a'), permission('a')]));
    expect(items.map((item) => item.kind)).toEqual(['toolGroup', 'permission']);

    const joined = joinResolvedPermissions(items);
    expect(joined.map((item) => item.kind)).toEqual(['toolGroup']);
    expect(deriveToolRowView(runFor(joined, 'a')).permissionVerb).toBe('Allowed');
  });

  // G-9 (2026-08-23, real deny on a live turn) settled what this arm is worth:
  // a denied call DOES get a tool_call block, with input and a
  // "User denied permission" result, so the merged shape is not some rare
  // corner — it is what every refusal looks like.
  it('Denied arm: same merge, and the decision word is the refusal', () => {
    const items = turnItems(
      message([
        call('a', 'Write'),
        result('a', { toolOk: false, text: 'User denied permission' }),
        permission('a', { allowed: false, permissionDecision: 'deny' }),
      ])
    );
    const joined = joinResolvedPermissions(items);
    expect(joined.map((item) => item.kind)).toEqual(['toolGroup']);

    const view = deriveToolRowView(runFor(joined, 'a'));
    expect(view.permissionVerb).toBe('Denied');
    expect(view.failed).toBe(true);
  });

  it('Denied arm: "Denied, turn stopped" survives as its own word, not folded into Denied', () => {
    const items = turnItems(
      message([
        call('a', 'Bash'),
        result('a', { toolOk: false }),
        permission('a', { allowed: false, permissionDecision: 'cancel' }),
      ])
    );
    const joined = joinResolvedPermissions(items);
    expect(deriveToolRowView(runFor(joined, 'a')).permissionVerb).toBe('Denied, turn stopped');
  });

  /**
   * The three carriers a denied decision can land on. Only the first is what
   * G-9 observed; the other two follow from `pairToolBlocks`'s status rule
   * (`result ? toolOk === false : running`) and are pinned so the shape is a
   * contract rather than an accident.
   *
   * The third one reads as a contradiction on screen ("Editing x.txt · Denied")
   * — that is the registered present/past-tense verb defect, tracked as its own
   * ticket. When it lands, THIS case goes red on purpose: it is the handoff
   * point, not a regression.
   */
  it('Denied arm: the badge does not depend on the carrier being failed or finished', () => {
    const failedFree = turnItems(
      message([
        call('a', 'Write'),
        result('a', { toolOk: true }),
        permission('a', { allowed: false, permissionDecision: 'deny' }),
      ])
    );
    const settled = deriveToolRowView(runFor(joinResolvedPermissions(failedFree), 'a'));
    expect(settled.permissionVerb).toBe('Denied');
    expect(settled.failed).toBe(false);

    const noResult = turnItems(
      message([call('a', 'Write'), permission('a', { allowed: false, permissionDecision: 'deny' })])
    );
    const running = deriveToolRowView(runFor(joinResolvedPermissions(noResult), 'a'));
    expect(running.permissionVerb).toBe('Denied');
    expect(running.running).toBe(true);
    expect(running.failed).toBe(false);
  });

  /**
   * The join adds a record; it never edits the run's status. Colouring a denied
   * row by writing `failed = true` here would erase the difference between
   * "allowed, then the tool failed" and "denied" — the two are told apart by
   * whether the row carries a decision at all, not by colour.
   */
  it('leaves run status exactly as pairToolBlocks computed it', () => {
    const blocks = [call('a', 'Write'), result('a', { toolOk: true }), permission('a')];
    const before = pairToolBlocks(blocks).map((run) => run.status);
    const after = runsOf(joinResolvedPermissions(turnItems(message(blocks)))).map(
      (run) => run.status
    );
    expect(after).toEqual(before);
  });
});

describe('[FB7-2] an unpairable permission keeps its own row', () => {
  it('Allowed arm: a synthesised perm-… id matches no tool_call and falls back', () => {
    const items = turnItems(
      message([
        call('a', 'Write'),
        result('a'),
        permission('p1', { permissionId: 'perm-1755900000000-3' }),
      ])
    );
    const joined = joinResolvedPermissions(items);
    expect(joined.map((item) => item.kind)).toEqual(['toolGroup', 'permission']);
    expect(runFor(joined, 'a').permission).toBeUndefined();
  });

  // The Codex path derives its permission id from the JSON-RPC request id, which
  // has nothing to do with any tool item id — so EVERY Codex approval lands here.
  it('Denied arm: the Codex correlation id falls back with the refusal intact', () => {
    const items = turnItems(
      message([
        call('a', 'Bash'),
        result('a', { toolOk: false }),
        permission('p1', {
          permissionId: 'codex:s1:7',
          allowed: false,
          permissionDecision: 'deny',
        }),
      ])
    );
    const joined = joinResolvedPermissions(items);
    expect(joined.map((item) => item.kind)).toEqual(['toolGroup', 'permission']);
    expect(countPermissionRecords(joined)).toBe(1);
  });
});

describe('[FB7-3] a merged permission no longer breaks the tool group', () => {
  it('[tool, permission(hit), tool] becomes ONE group, not two', () => {
    const items = turnItems(
      message([call('a', 'Write'), result('a'), permission('a'), call('b', 'Read'), result('b')])
    );
    expect(items.map((item) => item.kind)).toEqual(['toolGroup', 'permission', 'toolGroup']);

    const joined = joinResolvedPermissions(items);
    expect(joined.map((item) => item.kind)).toEqual(['toolGroup']);
    expect(runsOf(joined).map((run) => run.blockId)).toEqual(['a', 'b']);
  });

  it('does NOT stitch two groups that were already adjacent for other reasons', () => {
    const items = turnItems(
      message([call('a', 'Read'), result('a')], 'm1'),
      message([call('b', 'Read'), result('b')], 'm2')
    );
    expect(joinResolvedPermissions(items).map((item) => item.kind)).toEqual([
      'toolGroup',
      'toolGroup',
    ]);
  });

  it('an unpaired permission still breaks the group (the shape shipping today)', () => {
    const items = turnItems(
      message([
        call('a', 'Write'),
        result('a'),
        permission('p1', { permissionId: 'perm-9' }),
        call('b', 'Read'),
        result('b'),
      ])
    );
    expect(joinResolvedPermissions(items).map((item) => item.kind)).toEqual([
      'toolGroup',
      'permission',
      'toolGroup',
    ]);
  });
});

describe('[FB7-4] authorization records are conserved', () => {
  /**
   * The one assertion this whole feature cannot be shipped without: a merged
   * record still counts as one, and a record that could not be merged is never
   * dropped. Authorization history is an audit surface — `defaultTurnProcessOpen`
   * and `hasUnresolvedPermission` both assume it stays visible.
   */
  it('a mixed turn carries the same count before and after the join', () => {
    const items = turnItems(
      message([
        call('a', 'Write'),
        result('a'),
        permission('a'),
        call('b', 'Bash'),
        result('b', { toolOk: false }),
        permission('b', { allowed: false, permissionDecision: 'deny' }),
        permission('p3', { permissionId: 'codex:s1:2' }),
        permission('p4', { resolved: false }),
      ])
    );
    expect(countPermissionRecords(items)).toBe(4);
    expect(countPermissionRecords(joinResolvedPermissions(items))).toBe(4);
  });

  it('holds when nothing pairs at all', () => {
    const items = turnItems(
      message([
        permission('p1', { permissionId: 'perm-1' }),
        permission('p2', { permissionId: 'perm-2' }),
      ])
    );
    expect(countPermissionRecords(joinResolvedPermissions(items))).toBe(2);
  });
});

describe('[FB7-5] one tool_call never claims two permissions', () => {
  it('the first claims, the second falls back rather than overwriting it', () => {
    const items = turnItems(
      message([
        call('a', 'Write'),
        result('a'),
        permission('p1', { permissionId: 'a', permissionDecision: 'allow' }),
        permission('p2', { permissionId: 'a', allowed: false, permissionDecision: 'deny' }),
      ])
    );
    const joined = joinResolvedPermissions(items);
    expect(joined.map((item) => item.kind)).toEqual(['toolGroup', 'permission']);
    expect(runFor(joined, 'a').permission?.id).toBe('p1');
    expect(countPermissionRecords(joined)).toBe(2);
  });
});

describe('[FB7-6] the auto: provenance survives the merge', () => {
  it('a Host-answered approval keeps its reason on the merged row', () => {
    const items = turnItems(
      message([
        call('a', 'Write'),
        result('a', { toolOk: false }),
        permission('a', {
          allowed: false,
          permissionDecision: 'deny',
          permissionAutoReason: 'timed_out',
        }),
      ])
    );
    const view = deriveToolRowView(runFor(joinResolvedPermissions(items), 'a'));
    expect(view.permissionVerb).toBe('Denied');
    expect(view.permissionAutoNote).toBe('auto: timed_out');
  });

  it('a human-answered approval carries no note', () => {
    const items = turnItems(message([call('a', 'Write'), result('a'), permission('a')]));
    expect(
      deriveToolRowView(runFor(joinResolvedPermissions(items), 'a')).permissionAutoNote
    ).toBeUndefined();
  });

  /**
   * Source half. Both strings above are reproducible by hand, so a faithful
   * copy of the decision vocabulary into this module would pass the behaviour
   * assertions and still leave two definitions of "what a refusal is called"
   * to drift apart (the [FB8-2] lesson). This pins the reuse itself.
   */
  it('reads the words through the shared derivations, never re-spells them', () => {
    const body = functionSource('deriveToolRowView');
    expect(body).toContain('derivePermissionVerb(');
    expect(body).toContain('derivePermissionAutoNote(');
    for (const word of ['Allowed', 'Denied', 'auto:']) {
      expect(strippedToolCardSource).not.toContain(`'${word}`);
    }
  });
});

describe('[FB7-7] the decision badge stays a plain tool-row word (D24)', () => {
  it('carries no chrome — no background, no border, no icon', () => {
    for (const cls of [toolRowPermissionClass(), toolRowPermissionNoteClass()]) {
      expect(cls).not.toMatch(/\bbg-/);
      expect(cls).not.toMatch(/border/);
      expect(cls).not.toMatch(/Icon|Chevron|lucide/);
    }
  });

  /**
   * The colour half, and the reason it is a SHAPE assertion rather than a value
   * one: a denied row is already `text-destructive` and an allowed row is
   * `text-muted-foreground`, so the badge must inherit. Pinning one token here
   * would put a grey word inside a red row (or a red word inside a grey one),
   * and pinning "the same token in both arms" is exactly the bug — so the rule
   * is that these assemblers name no colour at all.
   */
  it('names no colour, so it inherits whichever colour the row already decided', () => {
    for (const cls of [toolRowPermissionClass(), toolRowPermissionNoteClass()]) {
      expect(cls).not.toMatch(/\btext-(?!markdown\b|left\b|code\b)/);
    }
    for (const name of ['toolRowPermissionClass', 'toolRowPermissionNoteClass']) {
      expect(functionSource(name)).not.toContain('failed');
    }
  });

  it('the closed-set decision word never truncates; the free-text note does', () => {
    expect(toolRowPermissionClass()).toContain('shrink-0');
    expect(toolRowPermissionClass()).not.toContain('truncate');
    expect(toolRowPermissionNoteClass()).toContain('truncate');
    expect(toolRowPermissionNoteClass()).toContain('min-w-0');
  });
});

describe('[FB7-8] a pending permission is never merged away', () => {
  /**
   * The blocker this feature was one line away from shipping. An unresolved card
   * matches the join condition perfectly — the store appends it while the
   * tool_call block with the SAME id is already there — and
   * `MessageTimeline.tsx`'s `case 'permission'` is the only Allow/Deny surface
   * in the app. Merging it would leave the turn waiting forever on an answer the
   * user has no way to give. Note that [FB7-4] cannot catch this: a card folded
   * into a run still counts as one record.
   */
  it('keeps its own item even though a tool_call shares its id', () => {
    for (const pending of [{ resolved: false }, {}]) {
      const items = turnItems(
        message([call('a', 'Write'), permission('a', { resolved: undefined, ...pending })])
      );
      const joined = joinResolvedPermissions(items);
      expect(joined.map((item) => item.kind)).toEqual(['toolGroup', 'permission']);
      expect(runFor(joined, 'a').permission).toBeUndefined();
    }
  });

  it('does not stitch the groups around it either', () => {
    const items = turnItems(
      message([
        call('a', 'Write'),
        permission('a', { resolved: false }),
        call('b', 'Read'),
        result('b'),
      ])
    );
    expect(joinResolvedPermissions(items).map((item) => item.kind)).toEqual([
      'toolGroup',
      'permission',
      'toolGroup',
    ]);
  });
});

describe('[FB7-9] the search domain is the turn, not one message', () => {
  /**
   * The store routes the two halves by different rules: a `tool_call` lands on
   * the message its event names, a `permission_request` lands on "the last
   * non-history assistant message". They coincide in the common ordering and
   * nothing structural makes them, so a message-scoped join would quietly stop
   * merging the moment a new assistant message opened in between — with every
   * message-scoped test still green.
   */
  it('merges a permission that landed on a later message than its tool_call', () => {
    const items = turnItems(
      message([call('a', 'Write'), result('a')], 'm1'),
      message([permission('a')], 'm2')
    );
    const joined = joinResolvedPermissions(items);
    expect(joined.map((item) => item.kind)).toEqual(['toolGroup']);
    expect(deriveToolRowView(runFor(joined, 'a')).permissionVerb).toBe('Allowed');
  });

  it('merges backwards across a message boundary too', () => {
    const items = turnItems(
      message([call('a', 'Write'), result('a')], 'm1'),
      message([textBlock('t1'), call('b', 'Bash'), result('b')], 'm2'),
      message([permission('a')], 'm3')
    );
    const joined = joinResolvedPermissions(items);
    expect(joined.map((item) => item.kind)).toEqual(['toolGroup', 'text', 'toolGroup']);
    expect(runFor(joined, 'a').permission?.id).toBe('a');
  });
});

describe('[FB7-10] a row carrying a decision never aggregates away', () => {
  /**
   * "Explored 3 files, 2 searches" hides its members until the detail body is
   * opened. An authorization record that only shows up after an expand is the
   * collapsed-away-approval shape the permission red line exists to prevent, so
   * a run that carries one renders standalone even when its neighbours would
   * otherwise fold it in.
   */
  it('two explore runs still aggregate when neither carries a decision', () => {
    const items = turnItems(
      message([call('a', 'Read'), call('b', 'Read'), result('a'), result('b')])
    );
    const group = joinResolvedPermissions(items)[0];
    if (group.kind !== 'toolGroup') throw new Error('expected a toolGroup');
    const rows = deriveToolGroupRows(group.entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('detail');
  });

  it('but the one with a decision breaks out into its own visible row', () => {
    const items = turnItems(
      message([call('a', 'Read'), call('b', 'Read'), result('a'), result('b'), permission('b')])
    );
    const group = joinResolvedPermissions(items)[0];
    if (group.kind !== 'toolGroup') throw new Error('expected a toolGroup');
    const rows = deriveToolGroupRows(group.entries);
    expect(rows.map((row) => row.permissionVerb)).toEqual([undefined, 'Allowed']);
    expect(rows.every((row) => row.body !== 'detail')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A refused call never ran, and nothing may say otherwise
// ---------------------------------------------------------------------------

describe('refused calls are not described in the past tense', () => {
  /**
   * Found on a live turn (G-9): a denied Write still produces a `tool_call`
   * block AND a `tool_result`, so the row rendered with the COMPLETED verb —
   * `Edited tmp/x.txt` for a write that was refused and never happened. Red
   * colour and the expanded body carried the truth; the collapsed row, which is
   * what a reader actually sees, said the opposite. FB7 then merged the decision
   * onto that same row, putting `Edited …` and `Denied` side by side.
   */
  it('a denied run reads as the operation, not as a completed action', () => {
    const items = turnItems(
      message([
        call('a', 'Write'),
        result('a', { toolOk: false, text: 'User denied permission' }),
        permission('a', { allowed: false, permissionDecision: 'deny' }),
      ])
    );
    const view = deriveToolRowView(runFor(joinResolvedPermissions(items), 'a'));
    expect(view.verb, 'the past tense is the defect').toBe('Edit');
    expect(view.permissionVerb).toBe('Denied');
  });

  it('an ALLOWED run keeps the completed verb', () => {
    const items = turnItems(message([call('a', 'Write'), result('a'), permission('a')]));
    expect(deriveToolRowView(runFor(joinResolvedPermissions(items), 'a')).verb).toBe('Edited');
  });

  it('an UNRESOLVED permission is not a refusal — the user has not answered', () => {
    const items = turnItems(message([call('a', 'Write'), permission('a', { resolved: false })]));
    // Still running, so still the present tense.
    expect(deriveToolRowView(runFor(joinResolvedPermissions(items), 'a')).verb).toBe('Editing');
  });

  /**
   * `allowed === false` is the test, not a decision-name list. `cancel`
   * ("Denied, turn stopped") is a deny and `allow_session` is an allow, and the
   * Host derives the same boolean from the same decision — a second reading of
   * the vocabulary here could disagree with it.
   */
  it('reads the boolean, so every refusal decision counts and every allow does not', () => {
    const refused = (overrides: Partial<ChatBlock>) =>
      toolRunWasRefused({
        permission: { id: 'p', type: 'permission_request', resolved: true, ...overrides },
      });
    expect(refused({ allowed: false, permissionDecision: 'deny' })).toBe(true);
    expect(refused({ allowed: false, permissionDecision: 'cancel' })).toBe(true);
    expect(refused({ allowed: true, permissionDecision: 'allow_session' })).toBe(false);
    expect(toolRunWasRefused({ permission: undefined })).toBe(false);
  });

  it('every tool has a refused form, and none of them is the completed one', () => {
    for (const [name, verbs] of Object.entries(TOOL_VERBS)) {
      expect(verbs.refused, `${name} has no refused form`).toBeTruthy();
      // `Read` is the one word that is legitimately both — English, not an
      // oversight — so it is the only permitted collision.
      if (verbs.done !== 'Read') {
        expect(verbs.refused, `${name} still reads as completed`).not.toBe(verbs.done);
      }
    }
    expect(UNKNOWN_TOOL_VERB.refused).toBe('Run');
  });
});
