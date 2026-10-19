import { describe, expect, it } from 'vitest';
import { projectSubagentTranscript } from '../subagentTranscript.ts';

// Decision 203: a subagent's sub-conversation, from the CLI's agent-<id>.jsonl (2.1.300 shape).
const rows = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Find the timing data' } },
  {
    type: 'assistant',
    uuid: 'a1',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      content: [{ type: 'thinking', thinking: 'Look in docs first.' }],
    },
  },
  {
    type: 'assistant',
    uuid: 'a2',
    message: {
      id: 'msg_1',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'ms' } }],
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'docs/a.md:3: 42 ms' }],
    },
  },
  {
    type: 'assistant',
    uuid: 'a3',
    message: { id: 'msg_2', content: [{ type: 'text', text: 'It takes 42 ms.' }] },
  },
];

describe('projectSubagentTranscript', () => {
  it('reads the prompt, the merged assistant message with its call and result, then the answer', () => {
    const raw = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n{"type":"assist`;
    const messages = projectSubagentTranscript(raw);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages[0]?.blocks).toEqual([
      { type: 'text', id: 'u1-text', text: 'Find the timing data' },
    ]);
    expect(messages[1]).toMatchObject({ model: 'claude-opus-5-5' });
    expect(messages[1]?.blocks.map((b) => b.type)).toEqual([
      'thinking',
      'tool_call',
      'tool_result',
    ]);
    expect(messages[1]?.blocks[2]).toMatchObject({
      toolCallId: 'toolu_1',
      ok: true,
      output: 'docs/a.md:3: 42 ms',
    });
    expect(messages[2]?.blocks).toEqual([{ type: 'text', id: 'a3-0', text: 'It takes 42 ms.' }]);
  });

  it('a failed call keeps its error; empty input reads as no messages', () => {
    const failed = projectSubagentTranscript(
      [
        rows[2],
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'no' },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')
    );
    expect(failed[0]?.blocks[1]).toMatchObject({ ok: false, error: 'no' });
    expect(projectSubagentTranscript('')).toEqual([]);
  });
});
