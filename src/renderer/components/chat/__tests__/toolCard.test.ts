import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  classifyTool,
  deriveAggregateRow,
  deriveRepoName,
  deriveToolGroupRows,
  deriveToolRowView,
  formatToolArg,
  formatToolArgKind,
  groupTimeline,
  normalizeToolOutput,
  pairToolBlocks,
  shortPath,
  type ToolGroupEntry,
  type ToolRun,
  toolVerb,
} from '../toolCard';

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

function message(blocks: ChatBlock[]): ChatMessage {
  return { id: 'm1', sessionId: 's1', role: 'assistant', blocks };
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
    expect(toolVerb('Bash', false)).toBe('Ran');
    expect(toolVerb('Bash', true)).toBe('Running');
    expect(toolVerb('Grep', false)).toBe('Grepped');
    expect(toolVerb('Grep', true)).toBe('Grepping');
    expect(toolVerb('Glob', false)).toBe('Searched files');
    expect(toolVerb('Glob', true)).toBe('Searching files');
    expect(toolVerb('Read', false)).toBe('Read');
    expect(toolVerb('Read', true)).toBe('Reading');
    expect(toolVerb('Edit', false)).toBe('Edited');
    expect(toolVerb('Edit', true)).toBe('Editing');
  });

  it('falls back to Ran/Running for an unknown tool name', () => {
    expect(toolVerb('SomeUnknownTool', false)).toBe('Ran');
    expect(toolVerb('SomeUnknownTool', true)).toBe('Running');
  });

  it('classifies an mcp__server__tool call as action, so it never aggregates', () => {
    expect(classifyTool('mcp__server__tool')).toBe('action');
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
