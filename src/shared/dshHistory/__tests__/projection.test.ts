import { describe, expect, it } from 'vitest';
import { translate } from '../../i18n.ts';
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
} from '../../legacyPiSession/convert/llmText.ts';
import { projectPiSessionHistory } from '../../legacyPiSession/timeline.ts';
import { REVIEW_PATCH_BYTES } from '../../sessionFileChange.ts';
import type { HistoryMessage } from '../../types/sessionHistory.ts';
import {
  aiclientEventName,
  DshHistoryFold,
  dshHistoryEntryType,
  IMPORTED_HISTORY_NOTICE_KEY,
  INTERRUPTED_TURN_NOTICE_KEY,
  projectDshHistory,
} from '../projection.ts';
import {
  type DshLogEvent,
  PI_BRANCH_SUMMARY_PREFIX,
  PI_BRANCH_SUMMARY_SUFFIX,
  REVIEW_PATCH_MAX_LENGTH,
} from '../types.ts';

/**
 * dsh-rebase P1-4a — one rule of the DSH history projection per case (plan
 * P1-4 shard 03 §1, decisions 026 and 032). The golden recordings in
 * `dshHistoryGolden.test.ts` cover the same rules on real DSH logs.
 */

const T0 = 1_790_000_000_000;

/** A small log builder: seq and time advance with every event. */
function log() {
  const events: DshLogEvent[] = [];
  let seq = 0;
  const add = (type: string, data: unknown, extra: Partial<DshLogEvent> = {}) => {
    events.push({ type, seq, time: T0 + seq * 1000, data, ...extra });
    seq += 1;
    return api;
  };
  const api = {
    events,
    add,
    turn: (turn: number) => add('turn/start', { turn }),
    user: (
      id: string,
      text: string,
      source: Record<string, unknown> = { kind: 'user' },
      more: unknown[] = []
    ) =>
      add('user/message', {
        id,
        role: 'user',
        content: [...(text ? [{ type: 'text', text }] : []), ...more],
        source,
      }),
    assistant: (
      turn: number,
      step: number,
      id: string,
      content: unknown[],
      extra: Record<string, unknown> = {}
    ) =>
      add('assistant/message', {
        turn,
        step,
        message: {
          id,
          role: 'assistant',
          content,
          source: { kind: 'model', provider: 'aiclient-gateway', model: 'fake-1' },
        },
        stream: [],
        ...extra,
      }),
    call: (turn: number, step: number, callId: string, name: string, args: unknown) =>
      add('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) }),
    result: (
      turn: number,
      step: number,
      id: string,
      callId: string,
      text: string,
      extra: { isError?: boolean; error?: unknown; meta?: unknown; content?: unknown[] } = {}
    ) =>
      add('tool/result', {
        turn,
        step,
        message: {
          id,
          role: 'tool',
          toolCallId: callId,
          source: { kind: 'tool', callId },
          content: extra.content ?? [{ type: 'text', text }],
          ...(extra.isError ? { isError: true } : {}),
        },
        ...(extra.error ? { error: extra.error } : {}),
        ...(extra.meta ? { meta: extra.meta } : {}),
      }),
    end: (turn: number, reason: unknown) => add('turn/end', { turn, reason }),
  };
  return api;
}

const text = (value: string) => ({ type: 'text', text: value });
const toolCall = (id: string, name: string, args: unknown) => ({
  type: 'tool-call',
  id,
  name,
  arguments: JSON.stringify(args),
});

function ids(messages: readonly HistoryMessage[]): string[] {
  return messages.map((message) => message.id);
}

describe('projectDshHistory — human messages', () => {
  it('turns a human prompt into one bubble keyed by its MessageId', () => {
    const { events } = log().turn(1).user('u1', 'hello there');
    expect(projectDshHistory(events)).toEqual([
      {
        id: 'h:u1',
        entryId: 'u1',
        role: 'user',
        timestamp: T0 + 1000,
        blocks: [{ type: 'text', id: 'h:u1:text:0', text: 'hello there' }],
      },
    ]);
  });

  it('recovers attachment names and types from image and file blocks, text or none', () => {
    const { events } = log()
      .turn(1)
      .user('u1', '', { kind: 'user' }, [
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha',
            mediaType: 'image/png',
            bytes: 3,
            width: 1,
            height: 1,
            name: 'shot.png',
          },
        },
        { type: 'image', attachment: { attachmentId: 'sha2', mediaType: 'image/webp' } },
        { type: 'file', attachment: { attachmentId: 'sha3', name: 'notes.md', bytes: 9 } },
      ]);
    const [message] = projectDshHistory(events);
    expect(message?.blocks).toEqual([]);
    expect(message?.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', name: 'shot.png' },
      { kind: 'image', mediaType: 'image/webp' },
      { kind: 'text', mediaType: 'text/plain', name: 'notes.md' },
    ]);
  });

  it('shows a compaction checkpoint as a Context summary row, without its framing', () => {
    const { events } = log().add('user/message', {
      id: 'c1',
      role: 'user',
      content: [
        text('This is an automatically generated checkpoint ...\n\n<compacted-summary>'),
        text('## Current Work\n- (none)'),
        text('</compacted-summary>'),
      ],
      source: { kind: 'compact-checkpoint', compactionId: 'x' },
    });
    const [row] = projectDshHistory(events);
    expect(row).toMatchObject({
      id: 'h:c1',
      role: 'system',
      blocks: [
        {
          type: 'text',
          id: 'h:c1:summary:0',
          text: 'Context summary\n\n## Current Work\n- (none)',
        },
      ],
    });
    expect(row && dshHistoryEntryType(row)).toBe('compaction');
  });

  it('shows a notice-form context message as a system note with its summary', () => {
    const { events } = log()
      .user('n1', 'full job output ...', {
        kind: 'tool-jobs',
        form: 'notice',
        summary: 'Background job finished: npm test',
      })
      .user('n2', 'goal wrap-up body', { kind: 'tool-goal', form: 'notice', summary: '' });
    const rows = projectDshHistory(events);
    expect(
      rows.map((row) => [row.id, row.role, row.blocks[0]?.type === 'text' && row.blocks[0].text])
    ).toEqual([
      ['h:n1', 'system', 'Background job finished: npm test'],
      ['h:n2', 'system', 'goal wrap-up body'],
    ]);
    expect(rows[0] && dshHistoryEntryType(rows[0])).toBe('notice');
  });

  it.each([
    'runtime-context',
    'agent-instructions',
    'skill-catalog',
    'skill-invocation',
    'goal',
    'subagent-settled',
    'model-selection',
    'plan-mode',
    'repeat-tool-reminder',
    'a-kind-this-build-never-heard-of',
  ])('keeps %s context off the timeline', (kind) => {
    const { events } = log().turn(1).user('u1', 'prompt').user('x1', 'context body', { kind });
    expect(ids(projectDshHistory(events))).toEqual(['h:u1']);
  });
});

describe('projectDshHistory — steps and tool results', () => {
  it('makes one message per step: thinking, text and tool calls with the row input alias', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'read it')
      .assistant(1, 1, 'a1', [
        { type: 'reasoning', text: 'thinking...' },
        text('Reading.'),
        toolCall('call-1', 'read', { file_path: '/w/a.txt' }),
      ]);
    const [, step] = projectDshHistory(events);
    expect(step).toEqual({
      id: 'h:a1',
      entryId: 'a1',
      role: 'assistant',
      timestamp: T0 + 2000,
      model: 'aiclient-gateway/fake-1',
      blocks: [
        { type: 'thinking', id: 'h:a1:thinking:0', text: 'thinking...' },
        { type: 'text', id: 'h:a1:text:1', text: 'Reading.' },
        {
          type: 'tool_call',
          id: 'h:a1:tool-call:call-1',
          toolCallId: 'call-1',
          name: 'read',
          input: { file_path: '/w/a.txt', path: '/w/a.txt' },
        },
      ],
    });
  });

  it('folds each tool result into the step that asked for it, dated as settledAt', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [toolCall('c1', 'bash', { command: 'ls' })])
      .call(1, 1, 'c1', 'bash', { command: 'ls' })
      .result(1, 1, 'r1', 'c1', 'a\nb\n');
    const [, step] = projectDshHistory(events);
    expect(step?.blocks.at(-1)).toEqual({
      type: 'tool_result',
      id: 'h:r1:tool-result:c1',
      toolCallId: 'c1',
      ok: true,
      output: 'a\nb\n',
    });
    expect(step?.settledAt).toBe(T0 + 4000);
  });

  it.each([
    ['ABORTED_BEFORE_DISPATCH', { notStarted: true }],
    ['TOOL_NOT_STARTED', { notStarted: true }],
    ['TOOL_OUTCOME_UNKNOWN', { outcomeUnknown: true }],
    ['ABORTED', { stopped: true }],
    ['SOME_TOOL_FAILURE', {}],
  ])('flags a failed result with error code %s', (code, flags) => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [toolCall('c1', 'bash', {})])
      .result(1, 1, 'r1', 'c1', 'it went wrong', { isError: true, error: { name: 'E', code } });
    const result = projectDshHistory(events)[1]?.blocks.at(-1);
    expect(result).toEqual({
      type: 'tool_result',
      id: 'h:r1:tool-result:c1',
      toolCallId: 'c1',
      ok: false,
      output: 'it went wrong',
      error: 'it went wrong',
      ...flags,
    });
  });

  it('reads a bash result aborted in its own meta as stopped', () => {
    const { events } = log()
      .turn(1)
      .assistant(1, 1, 'a1', [toolCall('c1', 'bash', {})])
      .result(1, 1, 'r1', 'c1', 'partial', { meta: { exitCode: null, aborted: true } });
    expect(projectDshHistory(events)[0]?.blocks.at(-1)).toMatchObject({ ok: true, stopped: true });
  });

  it('bounds tool output and names an image-only result', () => {
    const long = 'x'.repeat(4_100);
    const { events } = log()
      .turn(1)
      .assistant(1, 1, 'a1', [toolCall('c1', 'bash', {}), toolCall('c2', 'read_image', {})])
      .result(1, 1, 'r1', 'c1', long)
      .result(1, 1, 'r2', 'c2', '', {
        content: [{ type: 'image', attachment: { attachmentId: 's', mediaType: 'image/png' } }],
      });
    const blocks = projectDshHistory(events)[0]?.blocks ?? [];
    const [first, second] = blocks.filter((block) => block.type === 'tool_result');
    expect(first?.type === 'tool_result' && first.output).toBe(`${'x'.repeat(4_000)}\n[truncated]`);
    expect(second?.type === 'tool_result' && second.output).toBe('(image)');
  });

  it('keeps a result that matches no call as a row of its own, named from tool/call', () => {
    const { events } = log()
      .turn(1)
      .call(1, 1, 'lost', 'grep', { pattern: 'x' })
      .result(1, 1, 'r9', 'lost', 'found');
    expect(projectDshHistory(events)).toEqual([
      {
        id: 'h:r9',
        entryId: 'r9',
        role: 'assistant',
        timestamp: T0 + 2000,
        blocks: [
          { type: 'tool_call', id: 'h:r9:tool-call:lost', toolCallId: 'lost', name: 'grep' },
          {
            type: 'tool_result',
            id: 'h:r9:tool-result:lost',
            toolCallId: 'lost',
            ok: true,
            output: 'found',
          },
        ],
      },
    ]);
  });

  it('settles a call still unanswered when its turn ends as never run', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [toolCall('c1', 'bash', {})])
      .end(1, { kind: 'completed' });
    expect(projectDshHistory(events)[1]?.blocks.at(-1)).toEqual({
      type: 'tool_result',
      id: 'h:a1:tool-result:c1',
      toolCallId: 'c1',
      ok: false,
      error: 'The run ended before this call started.',
      notStarted: true,
    });
  });
});

describe('projectDshHistory — how a turn ended', () => {
  it('marks text cut short by Stop as incomplete, and the turn as user_stop', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [text('half an ans')], { interrupted: true })
      .add('step/end', { turn: 1, step: 1 })
      .end(1, { kind: 'aborted', reason: { kind: 'user' } });
    const [, step] = projectDshHistory(events);
    expect(step).toMatchObject({
      id: 'h:a1',
      incomplete: true,
      stopReason: 'aborted',
      stopCause: 'user_stop',
      settledAt: T0 + 4000,
    });
  });

  it('gives a turn stopped before any step a placeholder that carries the cause', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .end(1, { kind: 'aborted', reason: { kind: 'user' } });
    expect(projectDshHistory(events)[1]).toEqual({
      id: 'h:u1:end',
      entryId: 'u1:end',
      role: 'assistant',
      timestamp: T0 + 2000,
      blocks: [],
      incomplete: true,
      stopReason: 'aborted',
      stopCause: 'user_stop',
    });
  });

  it('reads the Ctrl+Enter hook cancel as interjected', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [text('done with step one')])
      .end(1, { kind: 'aborted', reason: { kind: 'hook', reason: 'aiclient-interject' } });
    expect(projectDshHistory(events)[1]).toMatchObject({ stopCause: 'interjected' });
  });

  it.each([
    [{ kind: 'hook', reason: 'someone-else' }],
    [{ kind: 'parent' }],
    [{ kind: 'disposed' }],
    [{ kind: 'legacy' }],
  ])('gives no stop cause to an abort the user did not ask for (%o)', (reason) => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [text('step')])
      .end(1, { kind: 'aborted', reason });
    expect(projectDshHistory(events)[1]).not.toHaveProperty('stopCause');
  });

  it('stands in for a failed request with an incomplete error placeholder, even after a tool step', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [toolCall('c1', 'bash', {})])
      .result(1, 1, 'r1', 'c1', 'ok')
      .add('assistant/attempt', { turn: 1, step: 2, stream: [] })
      .end(1, { kind: 'error', error: { message: '500', code: 'SERVER' } });
    const rows = projectDshHistory(events);
    expect(ids(rows)).toEqual(['h:u1', 'h:a1', 'h:u1:end']);
    expect(rows[2]).toMatchObject({
      role: 'assistant',
      blocks: [],
      incomplete: true,
      stopReason: 'error',
    });
  });

  it('notes a turn the engine never closed, and marks its last step incomplete', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [toolCall('c1', 'bash', {})])
      .call(1, 1, 'c1', 'bash', {})
      .result(1, 1, 'interrupted-tool-result-c1-5', 'c1', 'The tool call was interrupted ...', {
        isError: true,
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
      })
      .add('step/end', { turn: 1, step: 1 })
      .end(1, { kind: 'interrupted' })
      .add('session/end-seed', {});
    const rows = projectDshHistory(events);
    expect(ids(rows)).toEqual(['h:u1', 'h:a1', 'h:u1:interrupted']);
    expect(rows[1]).toMatchObject({ incomplete: true, stopReason: 'interrupted' });
    expect(rows[1]?.blocks.at(-1)).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(rows[2]).toEqual({
      id: 'h:u1:interrupted',
      entryId: 'u1:interrupted',
      role: 'system',
      timestamp: T0 + 6000,
      blocks: [
        {
          type: 'text',
          id: 'h:u1:interrupted:interrupted:0',
          text: INTERRUPTED_TURN_NOTICE_KEY,
          notice: { key: INTERRUPTED_TURN_NOTICE_KEY },
        },
      ],
    });
    expect(rows[2] && dshHistoryEntryType(rows[2])).toBe('notice');
  });

  it('has the note translated: the renderer runs its key through the dictionary', () => {
    expect(translate('zh', INTERRUPTED_TURN_NOTICE_KEY)).not.toBe(INTERRUPTED_TURN_NOTICE_KEY);
    expect(translate('en', INTERRUPTED_TURN_NOTICE_KEY)).toBe(INTERRUPTED_TURN_NOTICE_KEY);
  });

  it('keeps the stop reason an interrupted step already had', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [text('part')], { interrupted: true })
      .end(1, { kind: 'interrupted' });
    expect(projectDshHistory(events)[1]).toMatchObject({ incomplete: true, stopReason: 'aborted' });
  });

  it('marks a step cut at the output ceiling as length', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [text('very long')])
      .end(1, { kind: 'max-tokens' });
    expect(projectDshHistory(events)[1]).toMatchObject({ stopReason: 'length' });
  });

  it.each(['completed', 'blocked', 'forked'])('adds nothing for a %s turn', (kind) => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [text('fine')])
      .end(1, { kind });
    const rows = projectDshHistory(events);
    expect(ids(rows)).toEqual(['h:u1', 'h:a1']);
    expect(rows[1]).not.toHaveProperty('incomplete');
    expect(rows[1]).not.toHaveProperty('stopReason');
  });

  it('adds no placeholder for a turn that never had a message', () => {
    const { events } = log()
      .turn(1)
      .end(1, { kind: 'error', error: { message: 'x', code: 'X' } });
    expect(projectDshHistory(events)).toEqual([]);
  });
});

describe('projectDshHistory — retry continuations (decision 028)', () => {
  const retryNote = {
    kind: 'aiclient-retry',
    form: 'notice',
    summary: 'Retry after a failed request',
  };

  it.each([
    ['error', { kind: 'error', error: { message: '500', code: 'SERVER' } }, 'h:u1:end'],
    ['aborted', { kind: 'aborted', reason: { kind: 'user' } }, 'h:u1:end'],
    ['interrupted', { kind: 'interrupted' }, 'h:u1:interrupted'],
  ])('hides the %s placeholder when the next turn continues it, and the note itself', (_label, reason, hidden) => {
    const failed = log().turn(1).user('u1', 'go').end(1, reason);
    expect(ids(projectDshHistory(failed.events))).toContain(hidden);
    const { events } = failed
      .turn(2)
      .user(
        'retry-1',
        'The previous model request failed. Continue from where it stopped.',
        retryNote
      )
      .assistant(2, 1, 'a2', [text('continued')])
      .end(2, { kind: 'completed' });
    expect(ids(projectDshHistory(events))).toEqual(['h:u1', 'h:a2']);
  });

  it('keeps the placeholder when the next turn is a new prompt', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .end(1, { kind: 'error', error: { message: '500', code: 'SERVER' } })
      .turn(2)
      .user('u2', 'something else');
    expect(ids(projectDshHistory(events))).toEqual(['h:u1', 'h:u1:end', 'h:u2']);
  });

  it('keeps a failed retry visible under its own anchor', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .end(1, { kind: 'error', error: { message: '500', code: 'SERVER' } })
      .turn(2)
      .user('retry-1', 'continue', retryNote)
      .end(2, { kind: 'error', error: { message: '500', code: 'SERVER' } });
    expect(ids(projectDshHistory(events))).toEqual(['h:u1', 'h:retry-1:end']);
  });
});

describe('projectDshHistory — migration seeds (decision 053)', () => {
  it.each(['aiclient/', 'plugin:aiclient/'])('reads %s events alike', (prefix) => {
    const events: DshLogEvent[] = [
      {
        type: `${prefix}legacy-provenance`,
        seq: 0,
        time: T0,
        data: { version: 1, sourceKind: 'codex', sourceSessionId: 'abc' },
        ignorable: true,
      },
      {
        type: `${prefix}legacy-display`,
        seq: 1,
        time: T0 + 1,
        data: {
          version: 1,
          displayKind: 'tool',
          title: 'Shell',
          toolName: 'shell',
          toolCallId: 't1',
          input: { cmd: 'ls' },
          output: 'a',
          isError: false,
        },
        ignorable: true,
      },
      {
        type: `${prefix}legacy-display`,
        seq: 2,
        time: T0 + 2,
        data: { version: 1, displayKind: 'text', title: 'Plan', body: 'step one' },
        ignorable: true,
      },
      {
        type: `${prefix}pi-entry`,
        seq: 3,
        time: T0 + 3,
        data: { customType: 'x' },
        ignorable: true,
      },
      { type: `${prefix}some-future-record`, seq: 4, time: T0 + 4, data: {}, ignorable: true },
    ];
    const rows = projectDshHistory(events);
    expect(ids(rows)).toEqual([
      'h:aiclient-legacy-provenance-0',
      'h:aiclient-legacy-display-1',
      'h:aiclient-legacy-display-2',
    ]);
    expect(rows[0]?.blocks[0]).toMatchObject({
      notice: {
        key: IMPORTED_HISTORY_NOTICE_KEY,
        params: { sourceKind: 'codex', sourceSessionId: 'abc' },
      },
    });
    expect(rows[1]?.blocks).toEqual([
      {
        type: 'tool_call',
        id: 'h:aiclient-legacy-display-1:legacy-tool-call:0',
        toolCallId: 't1',
        name: 'shell',
        input: { cmd: 'ls' },
      },
      {
        type: 'tool_result',
        id: 'h:aiclient-legacy-display-1:legacy-tool-result:0',
        toolCallId: 't1',
        ok: true,
        output: 'a',
      },
    ]);
    expect(rows[2]?.blocks[0]).toMatchObject({ text: 'Plan\n\nstep one' });
  });

  it('names only the two prefixes', () => {
    expect(aiclientEventName('aiclient/pi-label')).toBe('pi-label');
    expect(aiclientEventName('plugin:aiclient/pi-label')).toBe('pi-label');
    expect(aiclientEventName('plugin:other/pi-label')).toBeUndefined();
    expect(aiclientEventName('aiclient/')).toBeUndefined();
    expect(aiclientEventName('user/message')).toBeUndefined();
  });

  it('uses the pi projection’s banner key, so both render one dictionary entry', () => {
    const [pi] = projectPiSessionHistory({
      getBranch: () => [
        {
          type: 'custom',
          id: 'p1',
          customType: 'aiclient.legacy-import.provenance',
          data: { sourceKind: 'codex', sourceSessionId: 'abc' },
        },
      ],
    });
    const block = pi?.blocks[0];
    expect(block?.type === 'text' && block.notice?.key).toBe(IMPORTED_HISTORY_NOTICE_KEY);
  });
});

/**
 * The three rules P1-9b left to P1-4a (decision 076): a migrated session
 * renders as its 1.0.x preview did, row ids included, so the renderer's merge
 * sees one timeline before and after the migration.
 */
describe('projectDshHistory — migrated pi sessions (P1-9b rules)', () => {
  it('keys display and provenance rows by the pi entry id they carry', () => {
    const events: DshLogEvent[] = [
      {
        type: 'aiclient/legacy-provenance',
        seq: 0,
        time: T0,
        data: { version: 1, sourceKind: 'codex', sourceSessionId: 'abc', entryId: 'e-prov' },
        ignorable: true,
      },
      {
        type: 'plugin:aiclient/legacy-display',
        seq: 1,
        time: T0 + 1,
        data: {
          version: 1,
          displayKind: 'tool',
          title: 'Shell',
          output: 'a',
          entryId: 'e-tool',
        },
        ignorable: true,
      },
      {
        type: 'aiclient/legacy-display',
        seq: 2,
        time: T0 + 2,
        data: { version: 1, displayKind: 'text', title: 'Plan', entryId: 'e-text' },
        ignorable: true,
      },
    ];
    const rows = projectDshHistory(events);
    expect(rows.map((row) => [row.id, row.entryId])).toEqual([
      ['h:e-prov', 'e-prov'],
      ['h:e-tool', 'e-tool'],
      ['h:e-text', 'e-text'],
    ]);
    expect(rows[0]?.blocks[0]?.id).toBe('h:e-prov:provenance:0');
    // The fallback call id is the pi projection's `<entry id>-display`.
    expect(
      rows[1]?.blocks.map((block) => [block.id, block.type === 'tool_call' && block.toolCallId])
    ).toEqual([
      ['h:e-tool:legacy-tool-call:0', 'e-tool-display'],
      ['h:e-tool:legacy-tool-result:0', false],
    ]);
    expect(rows[2]?.blocks[0]).toMatchObject({ id: 'h:e-text:legacy-display:0', text: 'Plan' });
  });

  it('renders the same provenance and display rows as the pi preview of the same entries', () => {
    const data = {
      provenance: { version: 1, sourceKind: 'claude-code', sourceSessionId: 's-9' },
      display: {
        version: 1,
        displayKind: 'tool',
        title: 'Bash',
        toolName: 'bash',
        toolCallId: 'c-1',
        input: { command: 'ls' },
        output: 'boom',
        isError: true,
      },
    };
    const pi = projectPiSessionHistory({
      getBranch: () => [
        {
          type: 'custom',
          id: 'p1',
          timestamp: new Date(T0).toISOString(),
          customType: 'aiclient.legacy-import.provenance',
          data: data.provenance,
        },
        {
          type: 'custom',
          id: 'p2',
          timestamp: new Date(T0 + 1).toISOString(),
          customType: 'aiclient.legacy-import.display',
          data: data.display,
        },
      ],
    });
    const dsh = projectDshHistory([
      {
        type: 'aiclient/legacy-provenance',
        seq: 0,
        time: T0,
        data: { ...data.provenance, entryId: 'p1' },
        ignorable: true,
      },
      {
        type: 'aiclient/legacy-display',
        seq: 1,
        time: T0 + 1,
        data: { ...data.display, entryId: 'p2' },
        ignorable: true,
      },
    ]);
    expect(dsh).toEqual(pi);
  });

  it('shows a migrated branch summary as a Context summary row, as 1.0.x did', () => {
    const summary = 'Tried an idea and came back.';
    const { events } = log()
      .turn(1)
      .user('b1', `${PI_BRANCH_SUMMARY_PREFIX}${summary}${PI_BRANCH_SUMMARY_SUFFIX}`, {
        kind: 'aiclient-pi-branch-summary',
      })
      .user('u1', 'next question');
    const rows = projectDshHistory(events);
    expect(ids(rows)).toEqual(['h:b1', 'h:u1']);
    const [pi] = projectPiSessionHistory({
      getBranch: () => [
        { type: 'branch_summary', id: 'b1', timestamp: new Date(T0 + 1000).toISOString(), summary },
      ],
    });
    expect(rows[0]).toEqual(pi);
    expect(dshHistoryEntryType(rows[0] as HistoryMessage)).toBe('compaction');
  });

  it('skips an empty branch summary and reads one whose framing drifted', () => {
    const rows = projectDshHistory(
      log()
        .turn(1)
        .user('b0', `${PI_BRANCH_SUMMARY_PREFIX}${PI_BRANCH_SUMMARY_SUFFIX}`, {
          kind: 'aiclient-pi-branch-summary',
        })
        .user('b1', 'Earlier:\n<summary>\n  kept  \n</summary>\n', {
          kind: 'aiclient-pi-branch-summary',
        })
        .user('b2', 'no tags at all', { kind: 'aiclient-pi-branch-summary' }).events
    );
    expect(rows.map((row) => row.blocks[0]?.type === 'text' && row.blocks[0].text)).toEqual([
      'Context summary\n\nkept',
      'Context summary\n\nno tags at all',
    ]);
  });

  it('restores the tool row flags 1.0.x read off the result details', () => {
    const review = {
      version: 1,
      path: '/repo/a.txt',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-a\n+b\n',
      extra: 'dropped',
    };
    const details = {
      write: { review, patch: 'diff --git a b' },
      refused: { refused: true },
      stopped: { stopped: true },
      failed: { review, patch: 'kept only on success' },
      list: { stopped: ['d1'] },
      badReview: { review: { version: 2, path: '/repo/a.txt', status: 'modified' } },
    };
    const calls = Object.keys(details);
    const failed = new Set(['failed']);
    const piEntries: unknown[] = [
      {
        type: 'message',
        id: 'a1',
        timestamp: new Date(T0).toISOString(),
        message: {
          role: 'assistant',
          content: calls.map((name) => ({
            type: 'toolCall',
            id: name,
            name: 'tool',
            arguments: {},
          })),
          stopReason: 'toolUse',
        },
      },
      ...calls.map((name, index) => ({
        type: 'message',
        id: `r-${name}`,
        timestamp: new Date(T0 + index + 1).toISOString(),
        message: {
          role: 'toolResult',
          toolCallId: name,
          toolName: 'tool',
          content: [{ type: 'text', text: `out ${name}` }],
          details: details[name as keyof typeof details],
          isError: failed.has(name),
        },
      })),
    ];
    const dsh = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(
        1,
        1,
        'a1',
        calls.map((name) => toolCall(name, 'tool', {}))
      );
    for (const name of calls) {
      dsh.result(1, 1, `r-${name}`, name, `out ${name}`, {
        isError: failed.has(name),
        meta: { aiclient: { piDetails: details[name as keyof typeof details] } },
      });
    }
    const results = (messages: readonly HistoryMessage[]) =>
      messages.flatMap((message) => message.blocks).filter((block) => block.type === 'tool_result');
    const ours = results(projectDshHistory(dsh.events));
    expect(ours).toEqual(results(projectPiSessionHistory({ getBranch: () => piEntries })));
    expect(ours.map((block) => Object.keys(block).filter((key) => key !== 'id'))).toEqual([
      ['type', 'toolCallId', 'ok', 'output', 'review', 'patch'],
      ['type', 'toolCallId', 'ok', 'output', 'refused'],
      ['type', 'toolCallId', 'ok', 'output', 'stopped'],
      ['type', 'toolCallId', 'ok', 'output', 'error'],
      ['type', 'toolCallId', 'ok', 'output'],
      ['type', 'toolCallId', 'ok', 'output'],
    ]);
    // Validated as `parseSessionFileChange` does: unknown keys go.
    const { extra: _extra, ...kept } = review;
    expect(ours[0]?.type === 'tool_result' && ours[0].review).toEqual(kept);
  });

  it('keeps its copies of pi’s framing and the review bound in step with the originals', () => {
    expect(PI_BRANCH_SUMMARY_PREFIX).toBe(BRANCH_SUMMARY_PREFIX);
    expect(PI_BRANCH_SUMMARY_SUFFIX).toBe(BRANCH_SUMMARY_SUFFIX);
    expect(REVIEW_PATCH_MAX_LENGTH).toBe(REVIEW_PATCH_BYTES);
  });
});

describe('DshHistoryFold', () => {
  it('folds incrementally into the same timeline as the whole log, and reports its cursor', () => {
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [toolCall('c1', 'bash', {})])
      .result(1, 1, 'r1', 'c1', 'ok')
      .end(1, { kind: 'error', error: { message: 'x', code: 'X' } })
      .turn(2)
      .user('retry', 'continue', { kind: 'aiclient-retry', form: 'notice', summary: 's' })
      .assistant(2, 1, 'a2', [text('done')])
      .end(2, { kind: 'completed' });
    const fold = new DshHistoryFold();
    const snapshots: string[][] = [];
    for (const event of events) {
      fold.push(event);
      snapshots.push(ids(fold.messages()));
    }
    expect(fold.messages()).toEqual(projectDshHistory(events));
    expect(fold.cursor).toBe(events.length - 1);
    // The failed turn's placeholder showed until the retry continued it.
    expect(snapshots[4]).toEqual(['h:u1', 'h:a1', 'h:u1:end']);
    expect(snapshots.at(-1)).toEqual(['h:u1', 'h:a1', 'h:a2']);
  });

  it('never changes a timeline it already handed out', () => {
    const fold = new DshHistoryFold();
    const { events } = log()
      .turn(1)
      .user('u1', 'go')
      .assistant(1, 1, 'a1', [toolCall('c1', 'bash', {})])
      .result(1, 1, 'r1', 'c1', 'ok');
    for (const event of events.slice(0, 3)) fold.push(event);
    const before = fold.messages();
    const frozen = JSON.stringify(before);
    fold.push(events[3] as DshLogEvent);
    expect(JSON.stringify(before)).toBe(frozen);
    expect(fold.messages()).not.toBe(before);
  });

  it('skips what it cannot read instead of failing the read', () => {
    const fold = new DshHistoryFold();
    for (const event of [
      null,
      { type: 'user/message', seq: 0, time: T0, data: null },
      { type: 'assistant/message', seq: 1, time: T0, data: { message: 'nope' } },
      { type: 'tool/result', seq: 2, time: T0, data: {} },
      { type: 'turn/end', seq: 3, time: T0, data: { reason: 'weird' } },
      { type: 'request/header', seq: 4, time: T0, data: {} },
    ] as unknown as DshLogEvent[]) {
      expect(() => fold.push(event)).not.toThrow();
    }
    expect(fold.messages()).toEqual([]);
    expect(fold.cursor).toBe(4);
  });
});
