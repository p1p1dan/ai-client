import { describe, expect, it } from 'vitest';
import { type HostEvent, summarizeSdkHost } from '../lib/sdkEvents.ts';
import { summarizeEvents } from '../lib/toolMetrics.ts';

/**
 * The PiLab+SDK arm counts the main agent from the Claude SDK host's runtime
 * events and takes tokens, offered tools and subagent calls from the SDK's
 * message log. The script below is the one parsers.test.ts plays for the
 * other two clients (a failing test run, a missing file, an unknown tool, a
 * passing test run, the answer), in the shapes the host emitted against the
 * fake gateway (SDK 0.3.300): it must count the same.
 */

const lines = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join('\n');

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, t = 0): HostEvent => ({
  type,
  requestId: 'turn',
  payload,
  t: t + seq++,
});

function step(n: number, body: HostEvent[] = []): HostEvent[] {
  const messageId = `cc-s${n}`;
  return [
    ev('message.started', { messageId, role: 'assistant', model: 'claude/claude-opus-5-5' }),
    ...body.map((event) => ({ ...event, payload: { messageId, ...event.payload } })),
    ev('message.completed', { messageId }),
  ];
}

function call(
  id: string,
  name: string,
  input: unknown,
  result: { ok: boolean; output: unknown; error?: string }
): HostEvent[] {
  return [
    ev('tool.started', { toolCallId: id, name, input: { __streaming: { bytes: 0, lines: 0 } } }),
    ev('tool.updated', { toolCallId: id, input }),
    ev('tool.completed', { toolCallId: id, ...result }),
  ];
}

const HOST_EVENTS: HostEvent[] = [
  ev('session.status', { status: 'running' }),
  ev('message.started', { messageId: 'cc-user-1', role: 'user' }),
  ev('message.delta', { messageId: 'cc-user-1', text: 'fix the median' }),
  ...step(
    1,
    call(
      't1',
      'Bash',
      { command: 'node --test' },
      { ok: false, output: 'Exit code 1\n✖ median', error: 'Exit code 1\n✖ median' }
    )
  ),
  ...step(
    2,
    call(
      't2',
      'Read',
      { file_path: 'C:\\w\\missing.js' },
      { ok: false, output: 'File does not exist.', error: 'File does not exist.' }
    )
  ),
  ...step(3, [
    ev('message.delta', { text: 'Let me look up the symbol.' }),
    ...call(
      't3',
      'LookupSymbol',
      {},
      {
        ok: false,
        output: '<tool_use_error>Error: No such tool available: LookupSymbol</tool_use_error>',
      }
    ),
  ]),
  ...step(4, call('t4', 'Bash', { command: 'node --test' }, { ok: true, output: 'ok' })),
  ...step(5, [ev('message.delta', { text: 'Fixed.' })]),
  ev('session.completed', {}),
  ev('session.status', { status: 'idle' }),
];

function assistant(id: string, block: unknown, parent: string | null = null) {
  return { type: 'assistant', parent_tool_use_id: parent, message: { id, content: [block] } };
}

function toolResult(id: string, content: string, parent: string | null = null) {
  return {
    type: 'user',
    parent_tool_use_id: parent,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  };
}

/** The SDK message log of the same run, plus a subagent the host's events leave out. */
const MESSAGE_LOG = lines(
  {
    type: 'system',
    subtype: 'init',
    tools: ['Bash', 'Read', 'Edit', 'Task'],
    apiKeySource: 'ANTHROPIC_API_KEY',
    permissionMode: 'bypassPermissions',
  },
  assistant('m1', { type: 'tool_use', id: 't1', name: 'Bash', input: {} }),
  toolResult('t1', 'Exit code 1'),
  assistant('m2', { type: 'tool_use', id: 't2', name: 'Read', input: {} }),
  toolResult('t2', 'File does not exist.'),
  assistant('m3', { type: 'tool_use', id: 't3', name: 'LookupSymbol', input: {} }),
  toolResult('t3', 'No such tool available'),
  assistant('m4', { type: 'tool_use', id: 't4', name: 'Bash', input: {} }),
  assistant('sub1', { type: 'tool_use', id: 's1', name: 'Grep', input: {} }, 't4'),
  toolResult('s1', 'found', 't4'),
  toolResult('t4', 'ok'),
  assistant('m5', { type: 'text', text: 'Fixed.' }),
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Fixed.',
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: 500,
        outputTokens: 60,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 30,
      },
      'claude-haiku-5-5': { inputTokens: 10, outputTokens: 2 },
    },
  }
);

describe('summarizeSdkHost', () => {
  it('counts the shared script the way the other two clients do', () => {
    const trace = summarizeSdkHost(HOST_EVENTS, MESSAGE_LOG);
    const metrics = summarizeEvents(trace.events);
    expect(metrics.steps).toBe(5);
    expect(metrics.toolCalls).toBe(4);
    expect(metrics.toolErrors).toBe(1);
    expect(metrics.unknownToolCalls).toBe(1);
    expect(metrics.nonZeroExits).toBe(1);
    expect(metrics.pendingToolCalls).toBe(0);
    expect(metrics.categories.shell).toEqual({ calls: 2, errors: 0, unknown: 0, nonZeroExits: 1 });
    expect(trace.answer).toBe('Fixed.');
    expect(trace.offeredTools).toEqual(['Bash', 'Read', 'Edit', 'Task']);
  });

  it('keeps the streamed input, not the placeholder', () => {
    const trace = summarizeSdkHost(HOST_EVENTS, MESSAGE_LOG);
    const first = trace.events.find((event) => event.kind === 'tool');
    expect(first?.kind === 'tool' && first.input).toEqual({ command: 'node --test' });
  });

  it('takes tokens from the SDK result (every model) and subagent calls from the log', () => {
    const trace = summarizeSdkHost(HOST_EVENTS, MESSAGE_LOG);
    expect(trace.tokensSource).toBe('sdk-modelUsage');
    expect(trace.tokens).toEqual({ input: 510, cacheRead: 900, cacheWrite: 30, output: 62 });
    expect(summarizeEvents(trace.events).subagentToolCalls).toBe(1);
    expect(trace.crossCheck).toEqual({ hostSteps: 5, sdkSteps: 5, hostTools: 4, sdkTools: 4 });
  });

  it('marks a call the stop cut off as pending, not as an error', () => {
    const events = [
      ...step(1, [
        ev('tool.started', { toolCallId: 'x', name: 'Bash', input: {} }),
        ev('tool.completed', {
          toolCallId: 'x',
          ok: false,
          output: { content: [{ type: 'text', text: 'interrupted' }], details: { stopped: true } },
          error: 'interrupted',
        }),
      ]),
      ev('session.stopped', {}),
    ];
    const metrics = summarizeEvents(summarizeSdkHost(events, '').events);
    expect(metrics.pendingToolCalls).toBe(1);
    expect(metrics.toolErrors).toBe(0);
  });

  it('falls back to the result text when no step said anything', () => {
    const trace = summarizeSdkHost(step(1), MESSAGE_LOG);
    expect(trace.answer).toBe('Fixed.');
  });
});
