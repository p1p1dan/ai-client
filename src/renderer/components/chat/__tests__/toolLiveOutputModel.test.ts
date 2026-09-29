import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  initialToolLiveOutput,
  normalizeTerminalText,
  pruneToolLiveOutput,
  reduceToolLiveOutput,
  TOOL_LIVE_OUTPUT_MAX_CALLS,
  TOOL_LIVE_OUTPUT_MAX_CHARS,
  type ToolLiveOutputState,
} from '../toolLiveOutputModel';

/**
 * dsh-rebase P1-7b (decisions 072 rule 5, 119; the bash plan's LIVE-OUT-11~13
 * carried over): a running command's live tail — replaced whole, bounded,
 * cleaned of terminal escapes, gone when the call or the turn ends.
 */

function output(toolCallId: string, tail: string, sessionId = 's1', totalBytes = tail.length) {
  return {
    type: 'tool.output',
    seq: 1,
    timestamp: 1,
    sessionId,
    payload: { messageId: 'm1', toolCallId, jobId: 'bash-1', tail, omittedBytes: 0, totalBytes },
  } as RuntimeEvent;
}

function fold(events: RuntimeEvent[], from: ToolLiveOutputState = initialToolLiveOutput) {
  return events.reduce(reduceToolLiveOutput, from);
}

describe('reduceToolLiveOutput', () => {
  it('[P7B-LIVE-REPLACE] each tail replaces the last one of its call', () => {
    const state = fold([output('c1', 'one\n'), output('c1', 'one\ntwo\n', 's1', 8)]);
    expect(state.byCall.c1).toEqual({
      sessionId: 's1',
      jobId: 'bash-1',
      text: 'one\ntwo\n',
      omittedBytes: 0,
      totalBytes: 8,
    });
    expect(state.order).toEqual(['c1']);
  });

  it('[P7B-LIVE-END] the call’s completion ends it; a turn end or a lost engine ends its session’s', () => {
    const state = fold([output('c1', 'a'), output('c2', 'b'), output('c3', 'c', 's2')]);
    const completed = fold(
      [
        {
          type: 'tool.completed',
          seq: 2,
          timestamp: 2,
          sessionId: 's1',
          payload: { messageId: 'm1', toolCallId: 'c1', ok: true },
        } as RuntimeEvent,
      ],
      state
    );
    expect(Object.keys(completed.byCall)).toEqual(['c2', 'c3']);
    const stopped = fold(
      [
        {
          type: 'session.stopped',
          seq: 3,
          timestamp: 3,
          sessionId: 's1',
          payload: {},
        } as RuntimeEvent,
      ],
      completed
    );
    expect(Object.keys(stopped.byCall)).toEqual(['c3']);
    const lost = fold(
      [
        {
          type: 'session.status',
          seq: 4,
          timestamp: 4,
          sessionId: 's2',
          payload: { status: 'disconnected' },
        } as RuntimeEvent,
      ],
      stopped
    );
    expect(lost.byCall).toEqual({});
    // Anything else is the same state.
    expect(
      reduceToolLiveOutput(lost, {
        type: 'session.status',
        seq: 5,
        timestamp: 5,
        sessionId: 's2',
        payload: { status: 'running' },
      } as RuntimeEvent)
    ).toBe(lost);
  });

  it('[P7B-LIVE-BOUND] keeps at most the newest calls; prune drops sessions no longer live', () => {
    const events = Array.from({ length: TOOL_LIVE_OUTPUT_MAX_CALLS + 2 }, (_, index) =>
      output(`c${index}`, 'x', index % 2 === 0 ? 's1' : 's2')
    );
    const state = fold(events);
    expect(state.order).toHaveLength(TOOL_LIVE_OUTPUT_MAX_CALLS);
    expect(state.byCall.c0).toBeUndefined();
    expect(state.byCall.c1).toBeUndefined();
    const pruned = pruneToolLiveOutput(state, ['s2']);
    expect(Object.values(pruned.byCall).every((entry) => entry.sessionId === 's2')).toBe(true);
    expect(pruneToolLiveOutput(pruned, ['s2'])).toBe(pruned);
  });
});

describe('normalizeTerminalText', () => {
  it('[P7B-LIVE-ANSI] drops colour and cursor escapes and other control characters', () => {
    expect(normalizeTerminalText('\u001b[32mok\u001b[0m done\u0007')).toBe('ok done');
    expect(normalizeTerminalText('\u001b]0;title\u0007shown')).toBe('shown');
  });

  it('[P7B-LIVE-CR] a carriage return redraws its line; CRLF is a line end', () => {
    expect(normalizeTerminalText('progress 10%\rprogress 20%\nnext')).toBe('progress 20%\nnext');
    expect(normalizeTerminalText('abcdef\rXY')).toBe('XYcdef');
    expect(normalizeTerminalText('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('keeps the newest characters past the pane’s bound', () => {
    const long = `${'a'.repeat(TOOL_LIVE_OUTPUT_MAX_CHARS)}END`;
    const text = normalizeTerminalText(long);
    expect(text).toHaveLength(TOOL_LIVE_OUTPUT_MAX_CHARS);
    expect(text.endsWith('END')).toBe(true);
  });
});
