import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseClaudeStream } from '../lib/claudeStream.ts';
import { decodeZstdFrames, summarizeDshSession } from '../lib/dshLog.ts';
import { summarizeEvents } from '../lib/toolMetrics.ts';

/**
 * Both clients' traces fold into the same counters. These transcripts copy the
 * shapes the real clients produced against the fake gateway (Claude Code
 * 2.1.295 stream-json, DSH 0.1.7-rc.2 session log v4): the same script must
 * count the same way on both sides, or the A/B report compares rules, not
 * clients.
 */

const lines = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join('\n');

function assistant(id: string, block: unknown, parent: string | null = null) {
  return {
    type: 'assistant',
    timestamp: '2026-10-14T10:00:01.000Z',
    parent_tool_use_id: parent,
    message: {
      id,
      content: [block],
      usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 0 },
    },
  };
}

function toolResult(id: string, content: string, isError?: boolean) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
      ],
    },
  };
}

const CLAUDE_TRANSCRIPT = lines(
  {
    type: 'system',
    subtype: 'init',
    tools: ['Bash', 'Read', 'Edit'],
    apiKeySource: 'ANTHROPIC_API_KEY',
  },
  assistant('m1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node --test' } }),
  toolResult('t1', 'Exit code 1\n✖ median', true),
  assistant('m2', {
    type: 'tool_use',
    id: 't2',
    name: 'Read',
    input: { file_path: 'C:\\w\\missing.js' },
  }),
  toolResult('t2', 'File does not exist.', true),
  assistant('m3', { type: 'text', text: 'Let me look up the symbol.' }),
  assistant('m3', { type: 'tool_use', id: 't3', name: 'LookupSymbol', input: {} }),
  toolResult(
    't3',
    '<tool_use_error>Error: No such tool available: LookupSymbol</tool_use_error>',
    true
  ),
  assistant('m4', { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'node --test' } }),
  toolResult('t4', 'ok'),
  assistant('m5', { type: 'text', text: 'Fixed.' }),
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1234,
    result: 'Fixed.',
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: 500,
        outputTokens: 60,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 30,
      },
      'claude-haiku-5-5': {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  }
);

describe('parseClaudeStream', () => {
  it('counts steps per message id, and splits errors, unknown tools and non-zero exits', () => {
    const stream = parseClaudeStream(CLAUDE_TRANSCRIPT, Date.parse('2026-10-14T10:00:00.000Z'));
    const metrics = summarizeEvents(stream.events);
    expect(metrics.steps).toBe(5);
    expect(metrics.toolCalls).toBe(4);
    expect(metrics.toolErrors).toBe(1);
    expect(metrics.unknownToolCalls).toBe(1);
    expect(metrics.nonZeroExits).toBe(1);
    expect(metrics.categories.shell).toEqual({ calls: 2, errors: 0, unknown: 0, nonZeroExits: 1 });
    expect(stream.answer).toBe('Fixed.');
    expect(stream.offeredTools).toEqual(['Bash', 'Read', 'Edit']);
    expect(stream.events[0].t).toBe(1000);
  });

  it('takes the totals from modelUsage, every model included', () => {
    const stream = parseClaudeStream(CLAUDE_TRANSCRIPT);
    expect(stream.tokensSource).toBe('modelUsage');
    expect(stream.tokens).toEqual({ input: 510, cacheRead: 900, cacheWrite: 30, output: 62 });
  });

  it('falls back to per-message usage when the run was cut before its result', () => {
    const cut = CLAUDE_TRANSCRIPT.split('\n').slice(0, -1).join('\n');
    const stream = parseClaudeStream(cut);
    expect(stream.tokensSource).toBe('messages');
    // Five distinct messages, the repeated m3 counted once.
    expect(stream.tokens.input).toBe(500);
    expect(stream.answer).toBe('Fixed.');
  });

  it('marks a call cut off before its result as pending', () => {
    const stream = parseClaudeStream(
      lines(
        assistant('m1', {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: 'sleep 60' },
        })
      )
    );
    expect(summarizeEvents(stream.events).pendingToolCalls).toBe(1);
  });
});

const DSH_LOG = [
  {
    type: 'request/header',
    data: {
      header: {
        tools: [{ name: 'pwsh' }, { name: 'read' }],
        config: { model: 'claude-opus-5-5', reasoningEffort: 'high' },
      },
    },
  },
  {
    type: 'system/message',
    data: { message: { content: [{ type: 'text', text: 'You are an agent.' }] } },
  },
  {
    type: 'assistant/message',
    time: 1000,
    data: {
      message: { content: [{ type: 'tool-call', name: 'pwsh' }] },
      usage: { inputTokens: 100, outputTokens: 24, cacheWriteTokens: 2000 },
    },
  },
  {
    type: 'tool/call',
    data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"node --test"}' },
  },
  {
    type: 'tool/result',
    data: {
      message: {
        toolCallId: 'c1',
        isError: false,
        content: [{ type: 'text', text: '✖ median\n[exit code: 1]' }],
      },
    },
  },
  {
    type: 'assistant/message',
    time: 2000,
    data: {
      message: { content: [] },
      usage: { inputTokens: 110, outputTokens: 24, cacheReadTokens: 2000, cacheWriteTokens: 150 },
    },
  },
  {
    type: 'tool/call',
    data: { callId: 'c2', name: 'read', arguments: '{"file_path":"C:\\\\w\\\\missing.js"}' },
  },
  {
    type: 'tool/result',
    data: {
      message: { toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'not found' }] },
      error: { name: 'FsError', code: 'FS_NOT_FOUND' },
    },
  },
  {
    type: 'assistant/message',
    time: 3000,
    data: { message: { content: [] }, usage: { inputTokens: 120, outputTokens: 24 } },
  },
  { type: 'tool/call', data: { callId: 'c3', name: 'LookupSymbol', arguments: '{}' } },
  {
    type: 'tool/result',
    data: {
      message: {
        toolCallId: 'c3',
        isError: true,
        content: [{ type: 'text', text: 'Error: unknown tool' }],
      },
      error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
    },
  },
  {
    type: 'assistant/message',
    time: 4000,
    data: { message: { content: [] }, usage: { inputTokens: 130, outputTokens: 24 } },
  },
  {
    type: 'tool/call',
    data: { callId: 'c4', name: 'pwsh', arguments: '{"command":"node --test"}' },
  },
  {
    type: 'tool/result',
    data: {
      message: { toolCallId: 'c4', isError: false, content: [{ type: 'text', text: 'ok\n' }] },
    },
  },
  { type: 'llm/retry', data: {} },
  {
    type: 'assistant/message',
    time: 5000,
    data: {
      message: { content: [{ type: 'text', text: 'Fixed.' }] },
      usage: { inputTokens: 140, outputTokens: 9 },
    },
  },
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
];

describe('summarizeDshSession', () => {
  it('counts the same script the same way Claude Code does', () => {
    const summary = summarizeDshSession(DSH_LOG, { subagent: false, startedAt: 500 });
    const metrics = summarizeEvents(summary.events);
    expect(metrics.steps).toBe(5);
    expect(metrics.toolCalls).toBe(4);
    expect(metrics.toolErrors).toBe(1);
    expect(metrics.unknownToolCalls).toBe(1);
    expect(metrics.nonZeroExits).toBe(1);
    expect(summary.answer).toBe('Fixed.');
    expect(summary.systemPrompt).toBe('You are an agent.');
    expect(summary.config).toEqual({ model: 'claude-opus-5-5', reasoningEffort: 'high' });
    expect(summary.turnEnd).toEqual({ kind: 'completed' });
    expect(summary.retries).toBe(1);
    expect(summary.tokens).toEqual({ input: 600, cacheRead: 2000, cacheWrite: 2150, output: 105 });
    expect(summary.events[0].t).toBe(500);
  });

  it('keeps a subagent session out of the main counters', () => {
    const summary = summarizeDshSession(DSH_LOG, { subagent: true });
    const metrics = summarizeEvents(summary.events);
    expect(metrics.steps).toBe(0);
    expect(metrics.toolCalls).toBe(0);
    expect(metrics.subagentToolCalls).toBe(4);
  });
});

describe('decodeZstdFrames', () => {
  it('reads every appended frame, not only the first', () => {
    const frames = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'].map((text) =>
      zstdCompressSync(Buffer.from(text))
    );
    expect(decodeZstdFrames(Buffer.concat(frames))).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
  });

  it('reads a plain log as text', () => {
    expect(decodeZstdFrames(Buffer.from('{"a":1}\n'))).toBe('{"a":1}\n');
  });
});
