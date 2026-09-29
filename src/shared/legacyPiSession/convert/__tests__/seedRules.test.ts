import { describe, expect, it } from 'vitest';
import { projectDshHistory } from '../../../dshHistory/projection.ts';
import {
  bindSeedImages,
  CHECKPOINT_PREAMBLE,
  checkSeed,
  convertPiSessionBytes,
  type DshSeedEvent,
  LEGACY_RECOVERED_RESULT_TEXT,
  OUTCOME_UNKNOWN_TEXT,
  type SeedConversion,
  seedSurface,
} from '../index.ts';
import { BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX, bashExecutionToText } from '../llmText.ts';
import { shadowedTokenCount } from '../tokenEstimate.ts';

/**
 * dsh-rebase P1-9b — the mapping rules of plan P1-9 shard 02, one small
 * synthetic session each. The corpus test covers real writer output; these
 * pin the rule itself.
 */

type Row = Record<string, unknown>;
const T0 = 1_800_000_000_000;

/** A native v4 file: rows chain on `main` unless they name a parent; time steps by 1 s. */
function v4(rows: Row[], extra: string[] = []): Uint8Array {
  const lines = [
    JSON.stringify({ kind: 'header', version: 4, id: 'rules', createdAt: T0, cwd: '/w' }),
  ];
  let parent: string | null = null;
  rows.forEach((row, index) => {
    const entry: Row = {
      kind: 'entry',
      lane: 'main',
      seq: index + 1,
      parentId: 'parentId' in row ? row.parentId : parent,
      timestamp: T0 + (index + 1) * 1000,
      ...row,
    };
    lines.push(JSON.stringify(entry));
    parent = entry.id as string;
  });
  lines.push(...extra);
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

const user = (id: string, content: unknown, more: Row = {}): Row => ({
  id,
  type: 'message',
  message: { role: 'user', content, timestamp: 1, ...more },
});
const reply = (id: string, content: unknown[], stopReason = 'stop', more: Row = {}): Row => ({
  id,
  type: 'message',
  message: {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'p',
    model: 'm',
    usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 15, cost: {} },
    stopReason,
    timestamp: 1,
    ...more,
  },
});
const text = (value: string, more: Row = {}) => ({ type: 'text', text: value, ...more });
const call = (id: string, name = 'read', args: unknown = { path: 'a' }) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const result = (id: string, callId: string, output: string, more: Row = {}): Row => ({
  id,
  type: 'message',
  message: {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'read',
    content: [text(output)],
    isError: false,
    timestamp: 1,
    ...more,
  },
});
const custom = (id: string, customType: string, data?: unknown): Row => ({
  id,
  type: 'custom',
  customType,
  ...(data !== undefined ? { data } : {}),
});

function convert(rows: Row[], extra?: string[]): SeedConversion {
  const converted = convertPiSessionBytes(v4(rows, extra), {
    sourceFile: '/s/rules.jsonl',
    cwd: '/w',
  });
  if (!converted.ok) throw new Error(`${converted.failure.code}: ${converted.message}`);
  expect(checkSeed(converted.seed)).toEqual([]);
  return converted;
}

const types = (seed: DshSeedEvent[]) => seed.map((event) => event.type);
const ofType = (seed: DshSeedEvent[], type: string) => seed.filter((event) => event.type === type);
const data = (event: DshSeedEvent | undefined) => event?.data as Row;
const messageOf = (event: DshSeedEvent | undefined) =>
  (event?.type === 'user/message' ? event.data : data(event)?.message) as Row;
const reasons = (seed: DshSeedEvent[]) =>
  ofType(seed, 'turn/end').map((event) => (data(event).reason as Row).kind);
const contextIds = (seed: DshSeedEvent[]) =>
  seedSurface(seed).map((seq) => String(messageOf(seed[seq]).id));

describe('turns, steps and the system head', () => {
  it('writes a prompt and its reply the way the loop does, under the pi entry ids', () => {
    const { seed } = convert([user('u1', 'hello'), reply('a1', [text('hi')])]);
    expect(types(seed)).toEqual([
      'turn/start',
      'step/start',
      'system/message',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ]);
    expect(messageOf(seed[2])).toEqual({
      id: 'u1:sys0',
      role: 'system',
      content: [],
      source: { kind: 'system-prompt' },
    });
    expect(messageOf(seed[3])).toEqual({
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    });
    expect(seedSurface(seed)[0]).toBe(2);
    expect(seed.map((event) => event.time)).toEqual([
      T0 + 1000,
      T0 + 1000,
      T0 + 1000,
      T0 + 1000,
      T0 + 2000,
      T0 + 2000,
      T0 + 2000,
    ]);
    expect(reasons(seed)).toEqual(['completed']);
  });

  it('opens a turn for a prompt and for a delegation report, not for other internal input', () => {
    const { seed } = convert([
      user('u1', 'go'),
      reply('a1', [call('c1')], 'toolUse'),
      result('r1', 'c1', 'x'),
      user('i1', 'instructions', { aiclientInternal: 'project-instructions' }),
      reply('a2', [text('done')]),
      user('rep', 'report', { aiclientInternal: 'subagent-report' }),
      reply('a3', [text('integrated')]),
    ]);
    expect(ofType(seed, 'turn/start')).toHaveLength(2);
    const internal = ofType(seed, 'user/message').map((event) => messageOf(event).source);
    expect(internal).toEqual([
      { kind: 'user' },
      { kind: 'aiclient-pi-internal', origin: 'project-instructions' },
      { kind: 'aiclient-pi-internal', origin: 'subagent-report' },
    ]);
    // The instructions open step 2 of the same turn.
    const i1 = seed.findIndex((event) => messageOf(event)?.id === 'i1');
    expect(data(seed[i1 - 1])).toEqual({ turn: 1, step: 2 });
    expect(projectDshHistory(seed).map((row) => row.id)).toEqual(['h:u1', 'h:a1', 'h:a2', 'h:a3']);
  });

  it('lets prompts that never got a reply share the turn of the next one', () => {
    const { seed } = convert([user('u1', 'one'), user('u2', 'two'), reply('a1', [text('both')])]);
    expect(ofType(seed, 'turn/start')).toHaveLength(1);
    expect(reasons(seed)).toEqual(['completed']);
  });

  it('opens a turn for context that arrives after a run ended, and keeps the model order', () => {
    const { seed } = convert([
      user('u1', 'one'),
      reply('a1', [text('done')]),
      {
        id: 'b1',
        type: 'message',
        message: {
          role: 'bashExecution',
          command: 'ls',
          output: 'x',
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1,
        },
      },
      user('u2', 'two'),
      reply('a2', [text('ok')]),
    ]);
    expect(reasons(seed)).toEqual(['completed', 'completed']);
    expect(contextIds(seed)).toEqual(['u1:sys0', 'u1', 'a1', 'b1', 'u2', 'a2']);
  });
});

describe('replies', () => {
  it('maps blocks, replay state and usage the way the pi-ai adapter would', () => {
    const { seed } = convert([
      user('u1', 'q'),
      reply(
        'a1',
        [
          { type: 'thinking', thinking: 'hmm', thinkingSignature: 'sig', redacted: false },
          text('reading', { textSignature: 'ts' }),
          { ...call('c1'), thoughtSignature: 'th' },
        ],
        'toolUse',
        { responseId: 'resp-1', providerThinkingLevel: 'high' }
      ),
      result('r1', 'c1', 'body', { details: { path: '/w/a', review: { version: 1 } } }),
      reply('a2', [text('done')]),
    ]);
    const [first] = ofType(seed, 'assistant/message');
    expect(data(first)).toEqual({
      turn: 1,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'hmm' },
          { type: 'text', text: 'reading' },
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' },
        ],
        source: {
          kind: 'model',
          provider: 'p',
          model: 'm',
          replayState: {
            response: {
              kind: 'pi-ai',
              version: 2,
              api: 'anthropic-messages',
              provider: 'p',
              model: 'm',
              responseId: 'resp-1',
              providerThinkingLevel: 'high',
              stopReason: 'toolUse',
            },
            blocks: [
              { type: 'reasoning', thinkingSignature: 'sig', redacted: false },
              { type: 'text', textSignature: 'ts' },
              { type: 'tool-call', thoughtSignature: 'th' },
            ],
          },
        },
      },
      stream: [],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 15, cacheReadTokens: 3 },
    });
    const [callEvent] = ofType(seed, 'tool/call');
    expect(data(callEvent)).toEqual({
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'read',
      arguments: '{"path":"a"}',
    });
    const [resultEvent] = ofType(seed, 'tool/result');
    expect(resultEvent?.sourceEventSeqs).toEqual([callEvent?.seq]);
    expect(data(resultEvent).meta).toEqual({
      aiclient: { piDetails: { path: '/w/a', review: { version: 1 } } },
    });
    expect(messageOf(resultEvent)).toMatchObject({
      id: 'r1',
      role: 'tool',
      toolCallId: 'c1',
      isError: false,
      source: { kind: 'tool', callId: 'c1' },
    });
  });

  it('drops an assistant image block and the replay state that no longer lines up', () => {
    const converted = convert([
      user('u1', 'q'),
      reply('a1', [text('see'), { type: 'image', data: 'AAAA', mimeType: 'image/png' }]),
    ]);
    const message = messageOf(ofType(converted.seed, 'assistant/message')[0]);
    expect(message.content).toEqual([{ type: 'text', text: 'see' }]);
    expect((message.source as Row).replayState).toBeUndefined();
    expect(converted.report.lossy).toMatchObject({ droppedBlocks: 1, replayStateOmitted: 1 });
  });

  it('keeps a stopped reply with text as an interrupted message without its calls (decision 055)', () => {
    const converted = convert([
      user('u1', 'q'),
      reply('a1', [text('half'), text('  '), call('c1')], 'aborted'),
      custom('stop', 'aiclient.runStop', { cause: 'user_stop', runId: 'r' }),
    ]);
    const [message] = ofType(converted.seed, 'assistant/message');
    expect(data(message)).toMatchObject({ interrupted: true });
    expect(messageOf(message).content).toEqual([{ type: 'text', text: 'half' }]);
    expect((messageOf(message).source as Row).replayState).toBeUndefined();
    expect(ofType(converted.seed, 'tool/call')).toEqual([]);
    expect(data(ofType(converted.seed, 'turn/end')[0])).toEqual({
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    });
    expect(ofType(converted.seed, 'turn/end')[0]?.time).toBe(T0 + 3000);
    expect(converted.report.lossy).toMatchObject({ interruptedReplies: 1, strippedToolCalls: 1 });
    expect(projectDshHistory(converted.seed)[1]).toMatchObject({
      incomplete: true,
      stopReason: 'aborted',
      stopCause: 'user_stop',
    });
  });

  it('records a stopped reply without text as an attempt, and without a record as a legacy stop', () => {
    const { seed } = convert([user('u1', 'q'), reply('a1', [text(' ')], 'aborted')]);
    expect(types(seed)).toContain('assistant/attempt');
    expect(ofType(seed, 'assistant/message')).toEqual([]);
    expect(data(ofType(seed, 'turn/end')[0]).reason).toEqual({
      kind: 'aborted',
      reason: { kind: 'legacy' },
    });
  });

  it('ends an interjected run with the interject hook cause', () => {
    const { seed } = convert([
      user('u1', 'q'),
      reply('a1', [call('c1')], 'toolUse'),
      result('r1', 'c1', 'x'),
      custom('stop', 'aiclient.runStop', { cause: 'interjected', runId: 'r' }),
      user('u2', 'now'),
      reply('a2', [text('ok')]),
    ]);
    expect(ofType(seed, 'turn/end').map((event) => data(event).reason)).toEqual([
      { kind: 'aborted', reason: { kind: 'hook', reason: 'aiclient-interject' } },
      { kind: 'completed' },
    ]);
  });

  it('records a failed reply as an attempt and ends its turn with the error', () => {
    const converted = convert([
      user('u1', 'q'),
      reply('a1', [text('half an answer')], 'error', { errorMessage: '400: rejected' }),
    ]);
    expect(types(converted.seed)).toContain('assistant/attempt');
    expect(data(ofType(converted.seed, 'turn/end')[0]).reason).toEqual({
      kind: 'error',
      error: { message: '400: rejected', code: 'UNKNOWN' },
    });
    expect(converted.report.lossy?.errorReplyBodies).toBe(1);
  });

  it('ends a turn that hit the output ceiling as max-tokens', () => {
    const { seed } = convert([user('u1', 'q'), reply('a1', [text('cut')], 'length')]);
    expect(reasons(seed)).toEqual(['max-tokens']);
  });

  it('writes no usage and no replay state for an imported reply', () => {
    const { seed } = convert([
      user('u1', 'q'),
      reply('a1', [text('old')], 'stop', { provider: 'legacy-import', api: 'legacy-import' }),
    ]);
    const [event] = ofType(seed, 'assistant/message');
    expect(data(event).usage).toBeUndefined();
    expect((messageOf(event).source as Row).replayState).toBeUndefined();
  });
});

describe('crashes', () => {
  it('closes a call left without a result as outcome-unknown, and the turn as interrupted', () => {
    const { seed } = convert([user('u1', 'q'), reply('a1', [text('w'), call('c1')], 'toolUse')]);
    const [closer] = ofType(seed, 'tool/result');
    expect(data(closer)).toMatchObject({
      message: {
        id: 'a1:unknown-result:c1',
        content: [{ type: 'text', text: OUTCOME_UNKNOWN_TEXT }],
        isError: true,
      },
      error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
    });
    expect(reasons(seed)).toEqual(['interrupted']);
  });

  it('flags 1.0.x’s own recovered result as outcome-unknown', () => {
    const { seed } = convert([
      user('u1', 'q'),
      reply('a1', [call('c1')], 'toolUse'),
      result('r1', 'c1', LEGACY_RECOVERED_RESULT_TEXT, { isError: true }),
      user('u2', 'back?'),
      reply('a2', [text('yes')]),
    ]);
    expect(data(ofType(seed, 'tool/result')[0]).error).toEqual({
      name: 'LegacyInterrupted',
      code: 'TOOL_OUTCOME_UNKNOWN',
    });
    expect(reasons(seed)).toEqual(['interrupted', 'completed']);
  });

  it('ends a prompt that never got a reply as interrupted', () => {
    const { seed } = convert([user('u1', 'q')]);
    expect(types(seed)).toEqual([
      'turn/start',
      'step/start',
      'system/message',
      'user/message',
      'step/end',
      'turn/end',
    ]);
    expect(reasons(seed)).toEqual(['interrupted']);
  });

  it('adds an empty interrupted turn for a run the SDK started and never finished', () => {
    const converted = convert(
      [user('u1', 'q'), reply('a1', [text('a')])],
      [
        JSON.stringify({
          kind: 'record',
          type: 'operation_started',
          id: 'op',
          seq: 3,
          lane: 'main',
          timestamp: T0 + 9000,
          intent: { kind: 'run' },
        }),
      ]
    );
    expect(reasons(converted.seed)).toEqual(['completed', 'interrupted']);
    expect(converted.report.lossy?.crashedRuns).toBe(1);
  });

  it('keeps a result with no open call as a record, off the model context', () => {
    const converted = convert([
      user('u1', 'q'),
      reply('a1', [text('a')]),
      result('r1', 'ghost', 'x'),
    ]);
    const [record] = ofType(converted.seed, 'aiclient/pi-entry');
    expect(record?.ignorable).toBe(true);
    expect(data(record)).toMatchObject({ entryId: 'r1', message: { toolCallId: 'ghost' } });
    expect(converted.report.lossy?.orphanResults).toBe(1);
  });
});

describe('context pi rendered as user text', () => {
  it('renders bash, extension messages and branch summaries the way convertToLlm did', () => {
    const bash = {
      role: 'bashExecution',
      command: 'ls',
      output: 'x',
      exitCode: 2,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    };
    const converted = convert([
      user('u1', 'q'),
      reply('a1', [text('a')]),
      { id: 'b1', type: 'message', message: bash },
      { id: 'b2', type: 'message', message: { ...bash, excludeFromContext: true } },
      {
        id: 'x1',
        type: 'message',
        message: {
          role: 'custom',
          customType: 'ext',
          content: 'note',
          display: false,
          timestamp: 1,
        },
      },
      { id: 's1', type: 'branch_summary', fromId: 'a1', summary: 'went elsewhere' },
      { id: 's2', type: 'branch_summary', fromId: 'a1', summary: '' },
    ]);
    const inputs = ofType(converted.seed, 'user/message').slice(1).map(messageOf);
    expect(inputs).toEqual([
      {
        id: 'b1',
        role: 'user',
        content: [{ type: 'text', text: bashExecutionToText(bash as never) }],
        source: { kind: 'aiclient-pi-bash' },
      },
      {
        id: 'x1',
        role: 'user',
        content: [{ type: 'text', text: 'note' }],
        source: { kind: 'aiclient-pi-custom', customType: 'ext' },
      },
      {
        id: 's1',
        role: 'user',
        content: [
          { type: 'text', text: `${BRANCH_SUMMARY_PREFIX}went elsewhere${BRANCH_SUMMARY_SUFFIX}` },
        ],
        source: { kind: 'aiclient-pi-branch-summary' },
      },
    ]);
    expect(converted.report.lossy).toMatchObject({ excludedFromContext: 1, emptySummaries: 1 });
    // None of them is a bubble, as in 1.0.x; the branch summary reads as the
    // "Context summary" row 1.0.x showed for it (P1-4a projection rule).
    const rows = projectDshHistory(converted.seed);
    expect(rows.map((row) => row.id)).toEqual(['h:u1', 'h:a1', 'h:s1']);
    expect(rows[2]).toMatchObject({
      role: 'system',
      blocks: [{ type: 'text', text: 'Context summary\n\nwent elsewhere' }],
    });
  });
});

describe('compaction', () => {
  const checkpointOf = (seed: DshSeedEvent[]) =>
    seed.find(
      (event) => (messageOf(event)?.source as Row | undefined)?.kind === 'compact-checkpoint'
    ) as DshSeedEvent;

  it('keeps the original tail when pi kept a suffix of the branch (CLI, v1–v3)', () => {
    const { seed } = convert([
      user('u1', 'one'),
      reply('a1', [text('1')]),
      user('u2', 'two', { timestamp: 22 }),
      reply('a2', [text('2')]),
      {
        id: 'k',
        type: 'compaction',
        summary: 'S',
        tokensBefore: 9,
        firstKeptEntryId: 'u2',
        retainedTail: [
          { role: 'user', content: 'two', timestamp: 22 },
          {
            role: 'assistant',
            content: [text('2')],
            api: 'x',
            provider: 'p',
            model: 'm',
            usage: {},
            stopReason: 'stop',
            timestamp: 1,
          },
        ],
      },
      user('u3', 'three'),
      reply('a3', [text('3')]),
    ]);
    const checkpoint = checkpointOf(seed);
    expect(messageOf(checkpoint)).toEqual({
      id: 'k',
      role: 'user',
      content: [
        { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>` },
        { type: 'text', text: 'S' },
        { type: 'text', text: '</compacted-summary>' },
      ],
      source: { kind: 'compact-checkpoint', compactionId: 'k' },
    });
    const u1 = seed.findIndex((event) => messageOf(event)?.id === 'u1');
    const a1 = seed.findIndex((event) => messageOf(event)?.id === 'a1');
    expect(checkpoint.surfaceOp).toEqual({ op: 'replace', startSeq: u1, endSeq: a1 });
    expect(contextIds(seed)).toEqual(['u1:sys0', 'k', 'u2', 'a2', 'u3', 'a3']);
    // DSH's transaction around it (P1-9c E1): between runs, so standalone.
    expect(types(seed).slice(checkpoint.seq - 3, checkpoint.seq + 2)).toEqual([
      'turn/end',
      'compaction/start',
      'compaction/summary',
      'user/message',
      'compaction/end',
    ]);
    const start = checkpoint.seq - 2;
    const summary = checkpoint.seq - 1;
    expect(data(seed[start])).toEqual({ compactionId: 'k', turn: null });
    expect(data(seed[checkpoint.seq + 1])).toEqual({ compactionId: 'k', turn: null });
    expect(data(seed[summary])).toEqual({
      compactionId: 'k',
      summary: [{ type: 'text', text: 'S' }],
      shadowedRange: { start: u1, end: a1 },
      shadowedSeqs: [u1, a1],
      shadowedTokenCount: shadowedTokenCount(seed, [u1, a1]),
      provider: 'p',
      model: 'm',
    });
    // DSH's heuristic: ceil(chars / 4) + 4 a block, + 4 a message.
    expect(shadowedTokenCount(seed, [u1, a1])).toBe(9 + 9);
    expect(checkpoint.sourceEventSeqs).toEqual([start, summary, u1, a1]);
  });

  it('re-adds the prompt 1.0.x kept, hidden, when it summarized the rest of the turn', () => {
    const converted = convert([
      user('u1', 'go', { timestamp: 11 }),
      reply('a1', [call('c1', 'new_context')], 'toolUse'),
      result('r1', 'c1', 'queued'),
      {
        id: 'k',
        type: 'compaction',
        summary: 'S',
        tokensBefore: 9,
        firstKeptEntryId: 'u1',
        retainedTail: [{ role: 'user', content: 'go (truncated)', timestamp: 11 }],
      },
      reply('a2', [text('continuing')]),
    ]);
    const { seed } = converted;
    expect(contextIds(seed)).toEqual(['u1:sys0', 'k', 'k:retained:0', 'a2']);
    expect(messageOf(seed.find((event) => messageOf(event)?.id === 'k:retained:0'))).toEqual({
      id: 'k:retained:0',
      role: 'user',
      content: [{ type: 'text', text: 'go (truncated)' }],
      source: { kind: 'aiclient-pi-retained', compactionId: 'k' },
    });
    // Mid-run: the checkpoint sits inside the turn, between its steps, and
    // the turn owns its transaction.
    expect(ofType(seed, 'turn/start')).toHaveLength(1);
    expect(data(ofType(seed, 'compaction/start')[0])).toEqual({ compactionId: 'k', turn: 1 });
    expect(data(ofType(seed, 'compaction/end')[0])).toEqual({ compactionId: 'k', turn: 1 });
    expect(converted.report.result?.checkpoints).toEqual({
      keptOriginals: 0,
      retainedCopies: 1,
      summaryOnly: 0,
      appended: 0,
    });
    // The timeline still shows the prompt once, and the summary.
    expect(projectDshHistory(seed).map((row) => row.id)).toEqual(['h:u1', 'h:a1', 'h:k', 'h:a2']);
  });

  it('keeps the summary alone when pi kept nothing, or the kept tail cannot be placed', () => {
    const nothing = convert([
      user('u1', 'one'),
      reply('a1', [text('1')]),
      { id: 'k', type: 'compaction', summary: 'S', tokensBefore: 9, retainedTail: [] },
    ]);
    expect(contextIds(nothing.seed)).toEqual(['u1:sys0', 'k']);
    const lost = convert([
      user('u1', 'one'),
      reply('a1', [text('1')]),
      {
        id: 'k',
        type: 'compaction',
        summary: 'S',
        tokensBefore: 9,
        retainedTail: [
          {
            role: 'assistant',
            content: [text('elsewhere')],
            api: 'x',
            provider: 'p',
            model: 'm',
            usage: {},
            stopReason: 'stop',
            timestamp: 999,
          },
        ],
      },
    ]);
    expect(contextIds(lost.seed)).toEqual(['u1:sys0', 'k']);
    expect(lost.report.lossy?.compactionAnchorsMissing).toBe(1);
  });

  it('names the legacy route when no reply before the compaction names one', () => {
    const { seed } = convert([
      user('u1', 'one'),
      { id: 'k', type: 'compaction', summary: 'S', tokensBefore: 9, retainedTail: [] },
    ]);
    const summary = data(ofType(seed, 'compaction/summary')[0]);
    expect([summary.provider, summary.model]).toEqual(['legacy', 'legacy']);
    // The prompt's run is still open: the turn owns the transaction.
    expect(data(ofType(seed, 'compaction/start')[0])?.turn).toBe(1);
  });

  it('wraps no transaction around a checkpoint that shadows nothing', () => {
    const { seed } = convert([
      { id: 'k', type: 'compaction', summary: 'S', tokensBefore: 9, retainedTail: [] },
      user('u1', 'one'),
      reply('a1', [text('1')]),
    ]);
    expect(checkpointOf(seed).surfaceOp).toBe('append');
    expect(types(seed).filter((type) => type.startsWith('compaction/'))).toEqual([]);
  });
});

describe('records that are not conversation', () => {
  it('keeps delegation records, labels and unknown custom entries as ignorable events; drops bookkeeping', () => {
    const converted = convert(
      [
        { id: 'm', type: 'model_change', provider: 'p', modelId: 'm' },
        custom('perm', 'aiclient.permissions', { mode: 'plan', gear: 'ask' }),
        user('u1', 'q'),
        reply('a1', [call('t1', 'Task')], 'toolUse'),
        custom('sub', 'aiclient.subagent', {
          kind: 'started',
          delegationId: 'd',
          parentToolCallId: 't1',
        }),
        custom('g', 'aiclient.permissionGrants', {
          version: 2,
          grants: [{ kind: 'command', prefix: 'ls', root: '/w' }],
        }),
        result('r1', 't1', 'started'),
        custom('lg', 'aiclient.loopGuard', { rule: 'x' }),
        reply('a2', [text('done')]),
      ],
      [JSON.stringify({ kind: 'fact', fact: 'label', targetId: 'a2', label: 'good', seq: 10 })]
    );
    const records = converted.seed.filter((event) => event.ignorable);
    expect(records.map((event) => [event.type, event.data])).toEqual([
      [
        'aiclient/pi-subagent',
        { kind: 'started', delegationId: 'd', parentToolCallId: 't1', entryId: 'sub' },
      ],
      [
        'aiclient/pi-entry',
        { entryId: 'lg', customType: 'aiclient.loopGuard', data: { rule: 'x' } },
      ],
      ['aiclient/pi-label', { targetMessageId: 'a2', label: 'good' }],
    ]);
    expect(converted.grants).toEqual({
      version: 2,
      grants: [{ kind: 'command', prefix: 'ls', root: '/w' }],
    });
    expect(converted.legacyPermissions).toEqual({ mode: 'plan', gear: 'ask' });
    expect(converted.report.lossy).toMatchObject({ bookkeeping: 3, labels: 1 });
    expect(converted.report.result?.grants).toBe(1);
  });

  it('writes no sidecar when the last grant record is empty', () => {
    const converted = convert([
      custom('g1', 'aiclient.permissionGrants', {
        version: 2,
        grants: [{ kind: 'command', prefix: 'ls', root: '/w' }],
      }),
      custom('g2', 'aiclient.permissionGrants', { version: 2, grants: [] }),
      user('u1', 'q'),
      reply('a1', [text('a')]),
    ]);
    expect(converted.grants).toBeNull();
  });
});

describe('images', () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

  it('holds images for admission, then binds or replaces them', () => {
    const converted = convert([
      user('u1', [
        text('look'),
        { type: 'image', data: png, mimeType: 'image/png', aiclientName: 'a.png' },
      ]),
      reply('a1', [call('c1')], 'toolUse'),
      result('r1', 'c1', 'x', { content: [{ type: 'image', data: png, mimeType: 'image/png' }] }),
      reply('a2', [text('ok')]),
    ]);
    expect(
      converted.images.map((image) => [image.key.startsWith('img-'), image.name ?? null])
    ).toEqual([
      [true, 'a.png'],
      [true, null],
    ]);
    const [first, second] = converted.images;
    expect(messageOf(ofType(converted.seed, 'user/message')[0]).content).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'image',
        attachment: { pendingImage: first?.key, mediaType: 'image/png', name: 'a.png' },
      },
    ]);
    expect(projectDshHistory(converted.seed)[0]?.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', name: 'a.png' },
    ]);
    expect(
      checkSeed(converted.seed, { images: 'bound' }).map((violation) => violation.rule)
    ).toEqual(['shape/image', 'shape/image']);
    const ref = {
      attachmentId: 'sha',
      mediaType: 'image/png',
      bytes: 70,
      width: 1,
      height: 1,
      name: 'a.png',
    };
    const bound = bindSeedImages(converted.seed, new Map([[first?.key as string, ref]]));
    expect(bound).toMatchObject({ bound: 1, failed: 1 });
    expect(checkSeed(bound.events, { images: 'bound' })).toEqual([]);
    expect(messageOf(ofType(bound.events, 'user/message')[0]).content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', attachment: ref },
    ]);
    expect(messageOf(ofType(bound.events, 'tool/result')[0]).content).toEqual([
      { type: 'text', text: '[image not migrated: image/png]' },
    ]);
    expect(second).toBeDefined();
    // Binding leaves the unbound seed as it was.
    expect(messageOf(ofType(converted.seed, 'tool/result')[0]).content).toEqual([
      { type: 'image', attachment: { pendingImage: second?.key, mediaType: 'image/png' } },
    ]);
  });

  it('restates a compaction’s shadow price over the bound reference', () => {
    const converted = convert([
      user('u1', [text('look'), { type: 'image', data: png, mimeType: 'image/png' }]),
      reply('a1', [text('ok')]),
      { id: 'k', type: 'compaction', summary: 'S', tokensBefore: 9, retainedTail: [] },
    ]);
    const priceOf = (seed: DshSeedEvent[]) =>
      data(ofType(seed, 'compaction/summary')[0]).shadowedTokenCount;
    const shadowed = data(ofType(converted.seed, 'compaction/summary')[0]).shadowedSeqs as number[];
    const ref = {
      attachmentId: 'a'.repeat(64),
      mediaType: 'image/png',
      bytes: 70,
      width: 1,
      height: 1,
    };
    const bound = bindSeedImages(
      converted.seed,
      new Map([[converted.images[0]?.key as string, ref]])
    );
    expect(priceOf(converted.seed)).toBe(shadowedTokenCount(converted.seed, shadowed));
    expect(priceOf(bound.events)).toBe(shadowedTokenCount(bound.events, shadowed));
    expect(priceOf(bound.events)).not.toBe(priceOf(converted.seed));
    expect(checkSeed(bound.events, { images: 'bound' })).toEqual([]);
  });
});

describe('legacy formats', () => {
  it('converts a legacy file in memory with ids that depend only on its bytes', () => {
    const legacy = [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'old',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/w',
      }),
      JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'hi', timestamp: 1 },
      }),
      JSON.stringify({
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [text('yo')],
          api: 'x',
          provider: 'p',
          model: 'm',
          usage: {},
          stopReason: 'stop',
          timestamp: 2,
        },
      }),
    ].join('\n');
    const bytes = new TextEncoder().encode(`${legacy}\n`);
    const once = convertPiSessionBytes(bytes, { sourceFile: '/s/old.jsonl', cwd: '/w' });
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(once.report.source.generation).toBe('pi-v3');
    expect(once.origin).toMatchObject({
      kind: 'pi-session',
      sourceSessionId: 'old',
      sourceFormat: 'pi-v3',
    });
    expect(convertPiSessionBytes(bytes, { sourceFile: '/s/old.jsonl', cwd: '/w' })).toEqual(once);
    expect(ofType(once.seed, 'assistant/message').map((event) => messageOf(event).id)).toEqual([
      'm2',
    ]);
  });

  it('refuses what cannot be read, with a stage and a code and no path in the report', () => {
    const big = new Uint8Array(32 * 1024 * 1024 + 1);
    const tooLarge = convertPiSessionBytes(big, { sourceFile: '/s/secret-name.jsonl', cwd: '/w' });
    expect(tooLarge).toMatchObject({
      ok: false,
      failure: { stage: 'read', code: 'source_too_large' },
    });
    const garbage = convertPiSessionBytes(new TextEncoder().encode('not json\n'), {
      sourceFile: '/s/secret-name.jsonl',
      cwd: '/w',
    });
    expect(garbage).toMatchObject({
      ok: false,
      failure: { stage: 'decode', code: 'session_invalid' },
    });
    expect(JSON.stringify(garbage.report)).not.toContain('secret-name');
  });
});
