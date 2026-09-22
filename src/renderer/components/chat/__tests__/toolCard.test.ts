import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { EMPTY_TOOL_EXPAND_MEMORY, resolveToolRowOpen } from '@/stores/toolExpansion';
import {
  classifyTool,
  countPermissionRecords,
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

/**
 * Decision 034 (2026-09-22, user decision): ONE ROW PER ENTRY.
 *
 * This block used to assert the opposite — decision 031's aggregate row, its
 * segmentation, and the separators that broke it. All of it is retired. The
 * user's own report after living with it: the aggregate cut the row COUNT but
 * not the noise, because it bought every fold with a third disclosure level.
 * The density fix moved down a layer (icon + two-character type label, capped
 * argument, no chevron) and this one went flat.
 */
describe('deriveToolGroupRows — one row per entry', () => {
  it('two consecutive runs are two rows, not one aggregate', () => {
    const rows = deriveToolGroupRows([
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
      runEntry(makeRun('b', 'Grep', { pattern: 'foo' })),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.verb)).toEqual(['Read', 'Grepped']);
    // Nothing on this surface summarises a count any more.
    expect(rows.every((row) => row.body !== 'detail')).toBe(true);
  });

  it('keeps every entry, in order, whatever the mix', () => {
    const rows = deriveToolGroupRows([
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
      thinkEntry(thinkingBlock('th1')),
      runEntry(makeRun('b', 'Bash', { command: 'ls' })),
      runEntry(makeRun('c', 'Write', { file_path: 'c.ts' })),
    ]);
    expect(rows.map((row) => row.verb)).toEqual(['Read', 'Thought', 'Ran', 'Edited']);
  });

  it('a running call keeps its own present-tense row beside the finished ones', () => {
    const rows = deriveToolGroupRows([
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
      runEntry(makeRun('b', 'Grep', { pattern: 'foo' }, 'running')),
    ]);
    expect(rows.map((row) => row.verb)).toEqual(['Read', 'Grepping']);
    expect(rows[1].running).toBe(true);
  });

  /**
   * ⚠️ FB7 red line, and what became of it.
   *
   * A run carrying a permission record used to be a SEPARATOR, so a decision
   * the user had been asked to make could never end up summarised as 「N 次工具
   * 调用」 behind two clicks. With no aggregate left the property holds by
   * construction — but it is still worth an assertion, because the failure it
   * guards against (a settled decision that is not visible without a click) is
   * about the DECISION being reachable, not about how rows are grouped.
   */
  it('[FB7] a run carrying a permission record renders its decision in place', () => {
    const permissioned = makeRun('b', 'Write', { file_path: 'b.ts' }, 'ok', {
      permission: { id: 'p-b', type: 'permission_request', resolved: true, allowed: true },
    });
    const rows = deriveToolGroupRows([
      runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
      runEntry(permissioned),
      runEntry(makeRun('d', 'Grep', { pattern: 'x' })),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[1].permissionVerb).toBe('Allowed');
    expect(rows[1].body).not.toBe('detail');
  });

  it('[034] every row carries an icon kind, and it agrees with its verb', () => {
    const rows = deriveToolGroupRows([
      runEntry(makeRun('a', 'Bash', { command: 'ls' })),
      runEntry(makeRun('b', 'Write', { file_path: 'b.ts' })),
      runEntry(makeRun('c', 'Read', { file_path: 'c.ts' })),
      runEntry(makeRun('d', 'Grep', { pattern: 'x' })),
      thinkEntry(thinkingBlock('th1')),
    ]);
    expect(rows.map((row) => row.iconKind)).toEqual([
      'terminal',
      'edit',
      'read',
      'search',
      'thinking',
    ]);
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

/**
 * A thought that is still arriving must be READABLE without a click — and
 * foldable WITH one (user decision 2026-09-19).
 *
 * Two shapes collapsed into one here. `showBody` used to be
 * `!streaming && hasText`, so a thought in flight had no collapsible at all:
 * its text went to a `liveText` field that painted a bare, control-less
 * paragraph. That kept the text visible (the point) but left no way to put a
 * long think away while it happened (the complaint). A streaming thought is now
 * an ordinary expandable row that happens to carry `defaultOpen` — visible
 * without a click, foldable at any time, and `resolveToolRowOpen` is what
 * carries the fold across the moment it settles.
 *
 * `liveText` retired with the branch: one shape, one code path.
 */
describe('buildThoughtRow streaming body (via deriveToolGroupRows)', () => {
  it('gives a streaming thought a body, a chevron and an open default', () => {
    const entries = [thinkEntry(thinkingBlock('th1', 'Let me check the catalog'))];
    const rows = deriveToolGroupRows(entries, { isStreamingBlockId: 'th1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].running).toBe(true);
    expect(rows[0].expandable).toBe(true);
    expect(rows[0].body).toBe('thinking');
    expect(rows[0].output).toBe('Let me check the catalog');
    // Without this the row would mount collapsed and the wait would look
    // frozen again — the defect the live text was introduced for.
    expect(rows[0].defaultOpen).toBe(true);
  });

  it('grows the body as deltas land (the append the store already does)', () => {
    const first = deriveToolGroupRows([thinkEntry(thinkingBlock('th1', 'Let me '))], {
      isStreamingBlockId: 'th1',
    });
    const second = deriveToolGroupRows([thinkEntry(thinkingBlock('th1', 'Let me check.'))], {
      isStreamingBlockId: 'th1',
    });
    expect(first[0].output).toBe('Let me ');
    expect(second[0].output).toBe('Let me check.');
  });

  it('keeps an empty streaming block bare — nothing to read, so nothing to open', () => {
    const rows = deriveToolGroupRows([thinkEntry(thinkingBlock('th1', ''))], {
      isStreamingBlockId: 'th1',
    });
    expect(rows[0].expandable).toBe(false);
    expect(rows[0].body).toBeUndefined();
    expect(rows[0].output).toBeUndefined();
  });

  it('a settled thought keeps the collapsible body and stops asking to be open', () => {
    const rows = deriveToolGroupRows([thinkEntry(thinkingBlock('th1', 'done thinking'))], {
      isStreamingBlockId: null,
    });
    expect(rows[0].running).toBe(false);
    expect(rows[0].expandable).toBe(true);
    expect(rows[0].body).toBe('thinking');
    expect(rows[0].output).toBe('done thinking');
    // The absence is what folds an untouched thought away once it ends.
    expect(rows[0].defaultOpen).toBeUndefined();
  });

  it('another block streaming leaves this thought settled', () => {
    const rows = deriveToolGroupRows([thinkEntry(thinkingBlock('th1', 'earlier thought'))], {
      isStreamingBlockId: 'some-other-block',
    });
    expect(rows[0].body).toBe('thinking');
    expect(rows[0].defaultOpen).toBeUndefined();
  });

  /**
   * ⚠️ DELETED 2026-09-19 (T105), and why it is a deletion rather than a
   * rewrite.
   *
   * This case read `re-stamps a streaming thought folded into an aggregate
   * detail row`: Read + Read + think, with the thought arriving last, folded
   * into the aggregate's `detail`. Under D4 a thinking entry BREAKS the
   * aggregate, so that shape — a thought inside an aggregate's detail — is now
   * unreachable by construction, and the thing the case was really protecting
   * (a live thought stays open and keeps its text) is asserted directly by the
   * two cases above and by `thinkingStreamRender.test.ts`. A rewritten version
   * would be asserting `applyThinkingDurations` on a branch nothing can enter,
   * which is the code-path-only-a-unit-call-can-reach shape T-31 already
   * retired once (see the withdrawn F-B14 note below).
   */

  it('a thought between calls keeps its live text and its auto-open', () => {
    // This used to be an assertion about `applyThinkingDurations` re-stamping
    // an aggregate's detail rows. With one row per entry (decision 034) the
    // thought is a top-level row built by `buildThoughtRow` directly, and what
    // still has to hold is the part the user sees: a thought that is still
    // arriving shows its text without a click.
    const rows = deriveToolGroupRows(
      [
        thinkEntry(thinkingBlock('th1', 'mid-turn thought')),
        runEntry(makeRun('a', 'Read', { file_path: 'a.ts' })),
        runEntry(makeRun('b', 'Read', { file_path: 'b.ts' })),
      ],
      { isStreamingBlockId: 'th1' }
    );
    expect(rows).toHaveLength(3);
    const thought = rows[0];
    expect(thought.key).toBe('th1');
    expect(thought.output).toBe('mid-turn thought');
    expect(thought.expandable).toBe(true);
    expect(thought.defaultOpen).toBe(true);
  });

  /**
   * `defaultOpen` is the LAST rule in `resolveToolRowOpen`, and it has to stay
   * there for the streaming thought as well: a reader who folds a think away
   * mid-stream is telling the app something about this row, and the row asking
   * to be open is only a default. Asserted against the real resolver rather
   * than by reading the field, because the precedence — not the flag — is what
   * keeps a collapsed think collapsed when the aggregate below re-mounts it.
   */
  it('a streaming thought’s open default loses to a remembered choice', () => {
    const rows = deriveToolGroupRows([thinkEntry(thinkingBlock('th1', 'thinking out loud'))], {
      isStreamingBlockId: 'th1',
    });
    expect(resolveToolRowOpen(rows[0], EMPTY_TOOL_EXPAND_MEMORY)).toBe(true);
    expect(resolveToolRowOpen(rows[0], { th1: false })).toBe(false);
    expect(resolveToolRowOpen(rows[0], { th1: true })).toBe(true);
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
    // subagent-data-06 changed the last resort for an MCP name only: the raw
    // `mcp__server__tool` is a wire identifier, and the row now says which
    // server and which tool instead. A field the server DID supply still wins,
    // which is the assertion above.
    const withNoFields = makeRun('b', 'mcp__server__tool', {});
    expect(formatToolArg(withNoFields)).toBe('server · tool');
    const notMcp = makeRun('c', 'SomethingElse', {});
    expect(formatToolArg(notMcp)).toBe('SomethingElse');
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
    // A tool whose whole input the one-line summary already covers. Bash is no
    // longer one of those — decision 033 D6 took `command` out of its covered
    // list, so a Bash row always has at least its command to disclose.
    const run = makeRun('a', 'Read', { file_path: '/tmp/a.ts' }, 'ok', { output: undefined });
    const view = deriveToolRowView(run);
    expect(view.expandable).toBe(false);
    expect(view.body).toBeUndefined();
  });

  it('[D6] a Bash command reaches the input body even when a description covers the summary', () => {
    // The 「指令太长了，没有办法看全」 bug: with `command` marked covered, a run
    // that carried a description generated NO input body, so the command was
    // unreachable — not truncated, absent. The row must disclose it.
    const command = `rg --files-with-matches ${'x'.repeat(200)} src`;
    const view = deriveToolRowView(
      makeRun('a', 'Bash', { command, description: 'Search sources' }, 'ok', { output: undefined })
    );
    expect(view.expandable).toBe(true);
    expect(view.input).toContain(command);
    // `ARG_COVERED_FIELDS` gates WHETHER a body exists, not what goes in it —
    // once one field is uncovered the body is the whole raw input, description
    // included. Keeping `description` covered is therefore only about not
    // minting a body for a run that has nothing else to show.
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

  /**
   * 2026-09-22 (user report 「已运行那一行，总是特别长，而且我也看不全指令」).
   *
   * The row was already one truncated line; what it spent that line on was the
   * repository path an agent prefixes to every call. Stripping it is a DISPLAY
   * change only — `input` keeps the command exactly as it ran.
   */
  it('[D6-b] the row summary drops a leading `cd <path> &&`, and the body keeps it', () => {
    const command =
      "cd /home/pi/code/ai-client-runtime && sed -n '452,500p' src/renderer/components/chat/ToolRows.tsx";
    const view = deriveToolRowView(makeRun('a', 'Bash', { command }));
    // The prefix is gone, so the width the row does spend goes on the command.
    expect(view.arg?.startsWith("sed -n '452,500p' src/")).toBe(true);
    expect(view.arg).not.toContain('cd /home/pi');
    // …and the rest is capped rather than left to fill the row.
    expect(view.arg?.endsWith('…')).toBe(true);
    expect(view.arg).toHaveLength(41);
    // The copy-and-rerun path is untouched.
    expect(view.input).toContain('cd /home/pi/code/ai-client-runtime &&');
  });

  it('[D6-c] a command that fits is left whole — the cap only cuts what exceeds it', () => {
    const view = deriveToolRowView(makeRun('a', 'Bash', { command: 'cd /repo && pnpm typecheck' }));
    expect(view.arg).toBe('pnpm typecheck');
  });

  it('[D6-b] a quoted path, a repeated cd, and a bare cd', () => {
    const arg = (command: string) => deriveToolRowView(makeRun('a', 'Bash', { command })).arg;
    expect(arg('cd "/home/with space/repo" && pnpm test')).toBe('pnpm test');
    expect(arg("cd '/tmp/a' && cd '/tmp/b' && ls")).toBe('ls');
    // Nothing follows it, so the row would be empty — the call really did only
    // change directory, and that is what it should say.
    expect(arg('cd /tmp/a')).toBe('cd /tmp/a');
  });

  it('[D6-b] a Bash description still wins over the command, prefix or not', () => {
    const view = deriveToolRowView(
      makeRun('a', 'Bash', { command: 'cd /repo && ls', description: 'List files' })
    );
    expect(view.arg).toBe('List files');
    expect(view.argKind).toBe('prose');
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
    expect(withExtraView.diff?.source).toBe('arguments');
    expect(withExtraView.input).toBeUndefined();
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
    // chat-event-07: the note is words now, not the worker's enum — this case
    // used to pin `timed_out`, underscore and all, into the transcript.
    expect(view.permissionAutoNote).toBe('auto: timed out');
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

describe('[FB7-10] a decision is never a click away', () => {
  /**
   * The shape this guards: an authorization record that only shows up after an
   * expand. Decision 031 answered it by keeping a permissioned run OUT of the
   * aggregate; decision 034 deleted the aggregate, so the property now holds
   * for every row — which is worth asserting from the other side, because the
   * thing that must stay true is "the decision is on screen", not "the row was
   * excluded from a group that no longer exists".
   */
  it('two explore runs render as two visible rows', () => {
    const items = turnItems(
      message([call('a', 'Read'), call('b', 'Read'), result('a'), result('b')])
    );
    const group = joinResolvedPermissions(items)[0];
    if (group.kind !== 'toolGroup') throw new Error('expected a toolGroup');
    const rows = deriveToolGroupRows(group.entries);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.body !== 'detail')).toBe(true);
  });

  it('and the one carrying a decision shows it on the row itself', () => {
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

/**
 * T101 — a tool row now exists before the call does.
 *
 * The projector opens the row on the model's FIRST partial arguments, so a row
 * can be on screen while the file it writes is still being dictated. Those
 * arguments are a redacted summary: the short identifying fields plus a
 * `__streaming` size marker standing for the withheld file body.
 *
 * What the derivations have to get right is all about that marker. A path that
 * never changes for minutes is indistinguishable from a wedged row, so the
 * size travels with it; and a diff built from a half-written file would show
 * the user a change that is not the one about to happen.
 */
describe('T101 · a tool row whose arguments are still streaming', () => {
  /** The shape the projector emits mid-stream; `content` is never in it. */
  const streaming = (fields: Record<string, unknown>, lines: number, bytes = lines * 10) => ({
    ...fields,
    __streaming: { bytes, lines },
  });

  it('a write row with partial arguments shows its target path and received line count', () => {
    const run = makeRun('w1', 'write', streaming({ path: 'src/index.html' }, 128), 'running');
    const view = deriveToolRowView(run);
    expect(view.running).toBe(true);
    expect(view.verb).toBe('Editing');
    expect(view.arg).toBe('src/index.html · 128 lines so far');
    // Still a path, so still the mono font domain (D25 §2.4).
    expect(view.argKind).toBe('ident');
  });

  it('a streaming row without a path shows only the tool name', () => {
    // The model has not finished typing the path yet. A bare "0 lines" names
    // nothing, so the row falls back to its verb alone rather than inventing a
    // placeholder target.
    const view = deriveToolRowView(makeRun('w2', 'write', streaming({}, 0, 0), 'running'));
    expect(view.arg).toBeUndefined();
    expect(view.verb).toBe('Editing');
    expect(formatToolArg(makeRun('w2', 'write', streaming({}, 0, 0), 'running'))).toBeUndefined();
  });

  it('no diff is computed until the full arguments arrive', () => {
    const partialRun = makeRun('w3', 'write', streaming({ path: 'a.txt' }, 2, 12), 'running');
    expect(deriveToolRowView(partialRun).diff).toBeUndefined();
    // And no raw-argument body either, so the size marker is never printed at
    // the user as JSON.
    expect(deriveToolRowView(partialRun).input).toBeUndefined();

    // The same row once the projector has replaced the summary with the real
    // arguments: the preview appears, which is the behaviour T12-b added.
    const settled = makeRun('w3', 'write', { path: 'a.txt', content: 'one\ntwo' }, 'running');
    const diff = deriveToolRowView(settled).diff;
    expect(diff?.source).toBe('write-content');
    expect(diff?.added).toBe(2);
  });

  it('leaves a settled row exactly as it was', () => {
    // The negative control for all three cases above: without the marker,
    // nothing about a Write row changes.
    const view = deriveToolRowView(makeRun('w4', 'write', { path: 'src/index.html' }, 'running'));
    expect(view.arg).toBe('src/index.html');
    expect(view.argKind).toBe('ident');
  });

  it('a Claude-era Write row reads the same way', () => {
    // `file_path` where pi says `path`; a replayed transcript still carries it,
    // and the streaming branch must not be reachable from only one spelling.
    const view = deriveToolRowView(
      makeRun('w5', 'Write', streaming({ file_path: 'docs/a.md' }, 7), 'running')
    );
    expect(view.arg).toBe('docs/a.md · 7 lines so far');
  });

  it('a streaming bash row still shows the command it is assembling', () => {
    // `command` is short enough to travel verbatim, so this row needs no size
    // note — the argument itself is what is growing.
    const view = deriveToolRowView(
      makeRun('b1', 'bash', streaming({ command: 'npm run bui' }, 0, 0), 'running')
    );
    expect(view.arg).toBe('npm run bui');
    expect(view.verb).toBe('Running');
  });
});
