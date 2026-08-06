import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { EventNormalizer } from '../eventNormalizer.ts';
import { SUBAGENT_EVENTS_MAX_PER_DELEGATION } from '../subagentProjection.ts';

/**
 * T-34 acceptance ②, asserted at its source: the Host must not emit a
 * subagent's tool_use/tool_result as ordinary `tool.started`/`tool.completed`.
 * The renderer cannot undo that after the fact without touching the red-line
 * `chatSessions.ts`, so segregation has to be true HERE or it is not true.
 *
 * Most assertions below are therefore negative ("no main-stream event names a
 * subagent's inner tool id") rather than positive ("a subagent event was
 * emitted") — a positive-only suite would pass while the defect persisted
 * alongside the new events.
 */

const PARENT = 'toolu_parent_delegation';

interface Emitted {
  type?: unknown;
  sessionId?: unknown;
  requestId?: unknown;
  payload?: Record<string, unknown>;
}

function makeNormalizer(subagentActivityEnabled = true): {
  events: Emitted[];
  logs: unknown[][];
  n: EventNormalizer;
} {
  const events: Emitted[] = [];
  const logs: unknown[][] = [];
  const n = new EventNormalizer(
    'sess-sub',
    (e) => events.push(e as Emitted),
    (...args) => logs.push(args),
    subagentActivityEnabled
  );
  return { events, logs, n };
}

function types(events: Emitted[]): unknown[] {
  return events.map((e) => e.type);
}

function activities(events: Emitted[]): Record<string, unknown>[] {
  return events
    .filter((e) => e.type === 'subagent.activity')
    .map((e) => e.payload as Record<string, unknown>);
}

function kinds(events: Emitted[]): unknown[] {
  return activities(events).map((p) => p.kind);
}

// --- SDK message builders (shapes taken verbatim from the probe dumps) ------

function subAssistant(content: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    message: { model: 'claude-opus-4-8', id: 'msg_sub_1', role: 'assistant', content },
    parent_tool_use_id: PARENT,
    session_id: 'rt-1',
    uuid: 'uuid-sub-assistant',
    subagent_type: 'general-purpose',
    task_description: 'shape probe',
    ...overrides,
  };
}

function subUser(content: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: PARENT,
    session_id: 'rt-1',
    uuid: 'uuid-sub-user',
    ...overrides,
  };
}

function taskStarted(overrides: Record<string, unknown> = {}) {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent-123',
    tool_use_id: PARENT,
    description: 'shape probe',
    subagent_type: 'general-purpose',
    task_type: 'local_agent',
    prompt: 'Read package.json and report the name field',
    session_id: 'rt-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Segregation (acceptance ②)
// ---------------------------------------------------------------------------

describe('EventNormalizer — subagent segregation', () => {
  it("a subagent's tool_use never becomes a main-stream tool.started", () => {
    const { events, n } = makeNormalizer();
    n.ingest(
      subAssistant([
        {
          type: 'tool_use',
          id: 'toolu_inner_read',
          name: 'Read',
          input: { file_path: '/tmp/a.ts' },
        },
      ])
    );

    expect(types(events)).toEqual(['subagent.activity']);
    expect(events.some((e) => e.type === 'tool.started')).toBe(false);
    // No assistant envelope is minted either — a delegation must not create
    // or contaminate the main agent's message.
    expect(events.some((e) => e.type === 'message.started')).toBe(false);

    expect(events[0].payload).toMatchObject({
      parentToolCallId: PARENT,
      kind: 'tool.started',
      toolCallId: 'toolu_inner_read',
      name: 'Read',
      input: { file_path: '/tmp/a.ts' },
    });
  });

  it("a subagent's tool_result never becomes a main-stream tool.completed", () => {
    const { events, n } = makeNormalizer();
    n.ingest(
      subUser([{ type: 'tool_result', tool_use_id: 'toolu_inner_read', content: 'file body here' }])
    );

    expect(types(events)).toEqual(['subagent.activity']);
    expect(events.some((e) => e.type === 'tool.completed')).toBe(false);
    expect(events[0].payload).toMatchObject({
      kind: 'tool.completed',
      toolCallId: 'toolu_inner_read',
      ok: true,
    });
    // Success carries no body at all (T-34 L2) — the panel answers "what is
    // it doing", not "what did it read".
    expect(events[0].payload).not.toHaveProperty('errorText');
    expect(JSON.stringify(events[0].payload)).not.toContain('file body here');
  });

  it('a failed subagent tool result carries a clamped errorText and nothing else', () => {
    const { events, n } = makeNormalizer();
    n.ingest(
      subUser([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_inner_bash',
          content: [{ type: 'text', text: 'permission denied' }],
          is_error: true,
        },
      ])
    );

    expect(events[0].payload).toMatchObject({
      kind: 'tool.completed',
      ok: false,
      errorText: 'permission denied',
    });
  });

  it("a subagent's text and thinking forward as their own kinds, empty bodies drop", () => {
    const { events, n } = makeNormalizer();
    n.ingest(
      subAssistant([
        { type: 'thinking', thinking: 'weighing options' },
        { type: 'text', text: 'Reading the manifest now.' },
      ])
    );

    expect(kinds(events)).toEqual(['thinking', 'text']);
    expect(events.some((e) => e.type === 'thinking.started')).toBe(false);
    expect(events.some((e) => e.type === 'message.delta')).toBe(false);

    events.length = 0;
    // Probe C: summarized thinking legitimately arrives as an EMPTY body with
    // only a signature — a blank row would be noise pretending to be a fact.
    n.ingest(subAssistant([{ type: 'thinking', thinking: '', signature: 'ErUC…' }]));
    n.ingest(subAssistant([{ type: 'text', text: '' }]));
    expect(events).toHaveLength(0);
  });

  it('the delegation prompt echo (parent-set user text, no tool_result) is dropped whole', () => {
    const { events, n } = makeNormalizer();
    n.ingest(subUser([{ type: 'text', text: 'Read the file package.json and report…' }]));

    expect(events).toHaveLength(0);
  });

  it('a parent-set stream_event is dropped whole (no char stream into the store)', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'stream_event',
      parent_tool_use_id: PARENT,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'par' } },
    });
    n.ingest({
      type: 'stream_event',
      parent_tool_use_id: PARENT,
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_stream_inner', name: 'Read' },
      },
    });

    expect(events).toHaveLength(0);
  });

  it('a parent-set tool_progress is dropped (no tool.updated for an id the timeline does not own)', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'tool_progress',
      parent_tool_use_id: PARENT,
      tool_use_id: 'toolu_inner_read',
    });

    expect(events).toHaveLength(0);
  });

  it('projects subagent tool input — a Write body never reaches the event', () => {
    const { events, n } = makeNormalizer();
    n.ingest(
      subAssistant([
        {
          type: 'tool_use',
          id: 'toolu_inner_write',
          name: 'Write',
          input: { file_path: '/tmp/out.ts', content: 'SECRET_FILE_BODY'.repeat(500) },
        },
      ])
    );

    expect(events[0].payload).toMatchObject({ input: { file_path: '/tmp/out.ts' } });
    expect(JSON.stringify(events[0])).not.toContain('SECRET_FILE_BODY');
  });
});

// ---------------------------------------------------------------------------
// Regression red line: the main-agent path must be byte-for-byte pre-T-34
// ---------------------------------------------------------------------------

describe('EventNormalizer — main-agent path unchanged (regression red line)', () => {
  it('parent_tool_use_id null takes the ordinary path for text and tools', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 'toolu_main', name: 'Agent', input: { description: 'probe' } },
        ],
      },
    });
    n.ingest({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_main', content: 'done' }],
      },
    });

    expect(types(events)).toEqual([
      'message.started',
      'message.delta',
      'tool.started',
      'tool.completed',
    ]);
    expect(events[0].payload).toMatchObject({ role: 'assistant', model: 'claude-opus-4-8' });
    expect(events.some((e) => e.type === 'subagent.activity')).toBe(false);
  });

  it('a message with no parent_tool_use_id key at all behaves identically', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_main2', name: 'Read', input: {} }] },
    });

    expect(types(events)).toEqual(['message.started', 'tool.started']);
  });

  it("a subagent's model never becomes the turn's reported model", () => {
    const { events, n } = makeNormalizer();
    // Subagent speaks first (its own model), then the main agent.
    n.ingest(
      subAssistant([{ type: 'text', text: 'child' }], {
        message: { model: 'child-model', content: [{ type: 'text', text: 'child' }] },
      })
    );
    n.ingest({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { model: 'main-model', content: [{ type: 'text', text: 'parent' }] },
    });

    const started = events.find((e) => e.type === 'message.started');
    expect(started?.payload).toMatchObject({ model: 'main-model' });
  });
});

// ---------------------------------------------------------------------------
// system/task_* control events
// ---------------------------------------------------------------------------

describe('EventNormalizer — task_* control events', () => {
  it('task_started opens the carrier without carrying the prompt', () => {
    const { events, n } = makeNormalizer();
    n.ingest(taskStarted());

    expect(events[0].payload).toEqual({
      parentToolCallId: PARENT,
      kind: 'started',
      agentId: 'agent-123',
      agentType: 'general-purpose',
      description: 'shape probe',
      taskType: 'local_agent',
    });
    expect(JSON.stringify(events[0])).not.toContain('Read package.json');
  });

  it('task_progress forwards the live description plus the usage heartbeat', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'agent-123',
      tool_use_id: PARENT,
      description: 'Reading package.json',
      subagent_type: 'general-purpose',
      usage: { total_tokens: 23535, tool_uses: 1, duration_ms: 5476 },
      last_tool_name: 'Read',
    });

    expect(events[0].payload).toEqual({
      parentToolCallId: PARENT,
      kind: 'progress',
      agentId: 'agent-123',
      description: 'Reading package.json',
      lastToolName: 'Read',
      usage: { totalTokens: 23535, toolUses: 1, durationMs: 5476 },
    });
  });

  it('task_notification becomes a status and drops summary/output_file', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-123',
      tool_use_id: PARENT,
      status: 'completed',
      summary: 'The name field is jyw-ai-client.',
      output_file: '/tmp/tasks/agent-123.output',
      usage: { total_tokens: 26709, tool_uses: 1, duration_ms: 12583 },
    });

    expect(events[0].payload).toEqual({
      parentToolCallId: PARENT,
      kind: 'status',
      agentId: 'agent-123',
      status: 'completed',
      usage: { totalTokens: 26709, toolUses: 1, durationMs: 12583 },
    });
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('jyw-ai-client');
    expect(serialized).not.toContain('output_file');
    expect(serialized).not.toContain('.output');
  });

  it('task_updated resolves its carrier through the task_id map filled by task_started', () => {
    const { events, n } = makeNormalizer();
    n.ingest(taskStarted());
    events.length = 0;
    n.ingest({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'agent-123',
      patch: { status: 'completed', end_time: 1785970737084 },
    });

    expect(events[0].payload).toEqual({
      parentToolCallId: PARENT,
      kind: 'status',
      agentId: 'agent-123',
      status: 'completed',
      endedAt: 1785970737084,
    });
  });

  it('an unattachable task_updated is dropped and logged, never guessed at', () => {
    const { events, logs, n } = makeNormalizer();
    n.ingest({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'agent-never-announced',
      patch: { status: 'completed' },
    });

    expect(events).toHaveLength(0);
    expect(logs.flat().join(' ')).toContain('unattachable task control');
  });

  it('an unreadable status is skipped rather than invented into a terminal state', () => {
    const { events, n } = makeNormalizer();
    n.ingest(taskStarted());
    events.length = 0;
    n.ingest({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'agent-123',
      patch: { status: 'weird' },
    });
    n.ingest({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-123',
      tool_use_id: PARENT,
      status: 'also-weird',
    });

    expect(events).toHaveLength(0);
  });

  it('leaves system/init and system/api_retry handling untouched', () => {
    const { events, n } = makeNormalizer();
    n.ingest({ type: 'system', subtype: 'init', session_id: 'rt-1' });
    n.ingest({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 500,
    });

    expect(types(events)).toEqual(['session.status', 'session.status']);
    expect(events[1].payload).toMatchObject({ status: 'running', retry: { attempt: 2 } });
  });
});

// ---------------------------------------------------------------------------
// Structured terminal report
// ---------------------------------------------------------------------------

function reportUserMessage(extraResults: unknown[] = []) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    session_id: 'rt-1',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: PARENT,
          type: 'tool_result',
          content: [
            { type: 'text', text: 'The name field is jyw-ai-client.' },
            {
              type: 'text',
              text: 'agentId: agent-123 (use SendMessage…)\n<usage>subagent_tokens: 26759</usage>',
            },
          ],
        },
        ...extraResults,
      ],
    },
    tool_use_result: {
      status: 'completed',
      prompt: 'Read package.json…',
      agentId: 'agent-123',
      agentType: 'general-purpose',
      content: [{ type: 'text', text: 'The name field is jyw-ai-client.' }],
      resolvedModel: 'claude-opus-4-8[1m]',
      totalDurationMs: 12584,
      totalTokens: 26759,
      totalToolUseCount: 1,
      toolStats: {
        readCount: 1,
        searchCount: 0,
        bashCount: 0,
        editFileCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
        otherToolCount: 0,
      },
    },
  };
}

/**
 * Prime the turn with the main agent's own `Agent` tool_use, as the real
 * stream always does — a bare `user` message would otherwise lazily mint the
 * assistant envelope (`emitToolCompleted` → `ensureAssistant`, pre-T-34
 * behavior) and add a `message.started` that says nothing about this branch.
 */
function primedNormalizer() {
  const harness = makeNormalizer();
  harness.n.ingest({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id: PARENT, name: 'Agent', input: { description: 'probe' } }],
    },
  });
  harness.events.length = 0;
  return harness;
}

describe('EventNormalizer — Agent tool_use_result report', () => {
  it('emits the report alongside tool.completed and swaps in the clean answer body', () => {
    const { events, n } = primedNormalizer();
    n.ingest(reportUserMessage());

    expect(types(events)).toEqual(['tool.completed', 'subagent.activity']);
    // The raw result text's second part is CLI plumbing; the report's own
    // `content` is what the SDK says to render.
    expect(events[0].payload?.output).toEqual([
      { type: 'text', text: 'The name field is jyw-ai-client.' },
    ]);
    expect(JSON.stringify(events[0].payload?.output)).not.toContain('SendMessage');

    expect(events[1].payload).toEqual({
      parentToolCallId: PARENT,
      kind: 'report',
      agentId: 'agent-123',
      report: {
        agentType: 'general-purpose',
        status: 'completed',
        resolvedModel: 'claude-opus-4-8[1m]',
        totalDurationMs: 12584,
        totalTokens: 26759,
        totalToolUseCount: 1,
        toolStats: {
          readCount: 1,
          searchCount: 0,
          bashCount: 0,
          editFileCount: 0,
          linesAdded: 0,
          linesRemoved: 0,
          otherToolCount: 0,
        },
      },
    });
    // Bodies are never re-carried by the protocol.
    expect(events[1].payload?.report).not.toHaveProperty('content');
    expect(events[1].payload?.report).not.toHaveProperty('prompt');
  });

  it('skips the report when the message carries two tool_results (ambiguous attribution)', () => {
    const { events, n } = primedNormalizer();
    n.ingest(
      reportUserMessage([{ tool_use_id: 'toolu_other', type: 'tool_result', content: 'unrelated' }])
    );

    expect(types(events)).toEqual(['tool.completed', 'tool.completed']);
    expect(events.some((e) => e.type === 'subagent.activity')).toBe(false);
    // …and the row still settles, with its own raw output untouched.
    expect(JSON.stringify(events[0].payload?.output)).toContain('SendMessage');
  });

  it('ignores a tool_use_result that is not a delegation report', () => {
    const { events, n } = primedNormalizer();
    n.ingest({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'ok' }],
      },
      tool_use_result: { type: 'text', file: { filePath: '/tmp/a.ts' } },
    });

    expect(types(events)).toEqual(['tool.completed']);
    expect(events[0].payload?.output).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Flag off, cap, and stamping
// ---------------------------------------------------------------------------

describe('EventNormalizer — quiet mode and the per-delegation cap', () => {
  it('flag off still segregates but forwards nothing (quiet, never legacy)', () => {
    const { events, n } = makeNormalizer(false);
    n.ingest(taskStarted());
    n.ingest(subAssistant([{ type: 'tool_use', id: 'toolu_inner_read', name: 'Read', input: {} }]));
    n.ingest(subUser([{ type: 'tool_result', tool_use_id: 'toolu_inner_read', content: 'body' }]));
    n.ingest(subAssistant([{ type: 'text', text: 'narration' }]));

    expect(events).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool.started')).toBe(false);
    expect(events.some((e) => e.type === 'tool.completed')).toBe(false);
  });

  it('flag off leaves the main-agent stream completely alone', () => {
    const { events, n } = makeNormalizer(false);
    n.ingest({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_main', name: 'Agent', input: {} }] },
    });

    expect(types(events)).toEqual(['message.started', 'tool.started']);
  });

  it('caps a runaway delegation at N events plus one capped announcement, then goes silent', () => {
    const { events, n } = makeNormalizer();
    for (let i = 0; i < SUBAGENT_EVENTS_MAX_PER_DELEGATION + 50; i += 1) {
      n.ingest(
        subAssistant([{ type: 'tool_use', id: `toolu_inner_${i}`, name: 'Read', input: {} }])
      );
    }

    expect(events).toHaveLength(SUBAGENT_EVENTS_MAX_PER_DELEGATION + 1);
    const last = events[events.length - 1];
    expect(last.payload).toEqual({
      parentToolCallId: PARENT,
      kind: 'capped',
      limit: SUBAGENT_EVENTS_MAX_PER_DELEGATION,
    });
    // The announcement fires exactly once — the latch holds afterwards.
    expect(kinds(events).filter((k) => k === 'capped')).toHaveLength(1);
  });

  it('caps each delegation independently', () => {
    const { events, n } = makeNormalizer();
    for (let i = 0; i < SUBAGENT_EVENTS_MAX_PER_DELEGATION + 5; i += 1) {
      n.ingest(subAssistant([{ type: 'tool_use', id: `a_${i}`, name: 'Read', input: {} }]));
    }
    const other = 'toolu_parent_other';
    n.ingest(
      subAssistant([{ type: 'tool_use', id: 'b_0', name: 'Read', input: {} }], {
        parent_tool_use_id: other,
      })
    );

    const otherEvents = activities(events).filter((p) => p.parentToolCallId === other);
    expect(otherEvents).toHaveLength(1);
    expect(otherEvents[0].kind).toBe('tool.started');
  });

  it('beginTurn resets the cap and task-id bookkeeping (a delegation cannot span turns)', () => {
    const { events, n } = makeNormalizer();
    for (let i = 0; i < SUBAGENT_EVENTS_MAX_PER_DELEGATION + 5; i += 1) {
      n.ingest(subAssistant([{ type: 'tool_use', id: `a_${i}`, name: 'Read', input: {} }]));
    }
    n.beginTurn('next turn');
    events.length = 0;
    n.ingest(subAssistant([{ type: 'tool_use', id: 'fresh', name: 'Read', input: {} }]));

    expect(kinds(events)).toEqual(['tool.started']);
  });

  it('never stamps seq/timestamp itself — index.ts owns that', () => {
    const { events, n } = makeNormalizer();
    n.ingest(taskStarted(), 'req-9');

    expect(events[0]).not.toHaveProperty('seq');
    expect(events[0]).not.toHaveProperty('timestamp');
    expect(events[0]).toMatchObject({ sessionId: 'sess-sub', requestId: 'req-9' });
  });
});

// ---------------------------------------------------------------------------
// Recorded probe replay (standard #8: a real sample becomes a regression case)
// ---------------------------------------------------------------------------

/**
 * The two dumps are the live 2026-08-05 probe runs (cometix 2.1.212 / SDK
 * 0.3.218 / claude-opus-4-8) copied into the repo — scenario A is default
 * mode, scenario B adds `forwardSubagentText`. They are the only place the
 * real interleaving of task_* control events with parent-set messages is
 * asserted end to end, and the budgets below are acceptance ④ expressed as
 * something that can fail.
 */
function readFixture(name: string): unknown[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function replay(messages: unknown[]): Emitted[] {
  const { events, n } = makeNormalizer();
  for (const message of messages) n.ingest(message, 'req-replay');
  return events;
}

/** Every tool_use id that appeared inside a parent-set assistant message. */
function innerToolIds(messages: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const m = message as {
      type?: string;
      parent_tool_use_id?: unknown;
      message?: { content?: unknown };
    };
    if (m.type !== 'assistant' || typeof m.parent_tool_use_id !== 'string') continue;
    for (const block of Array.isArray(m.message?.content) ? m.message.content : []) {
      const b = block as { type?: string; id?: string };
      if (b?.type === 'tool_use' && typeof b.id === 'string') ids.add(b.id);
    }
  }
  return ids;
}

describe.each([
  { label: 'A (default mode)', file: 't34-subagent-a-default.jsonl', budget: 17 },
  { label: 'B (forwardSubagentText)', file: 't34-subagent-b-forwarded.jsonl', budget: 20 },
])('EventNormalizer — recorded probe replay: $label', ({ file, budget }) => {
  const messages = readFixture(file);
  const events = replay(messages);
  const inner = innerToolIds(messages);

  it('the fixture really contains a delegation with inner tool calls', () => {
    expect(inner.size).toBeGreaterThan(0);
    expect(messages.some((m) => (m as { subtype?: string }).subtype === 'task_started')).toBe(true);
  });

  it('no main-stream tool event names a subagent inner tool id (acceptance ②)', () => {
    const mainToolIds = events
      .filter((e) => e.type === 'tool.started' || e.type === 'tool.completed')
      .map((e) => String(e.payload?.toolCallId));

    for (const id of mainToolIds) expect(inner.has(id)).toBe(false);
    // The delegating Agent call itself DOES stay in the main stream.
    expect(mainToolIds.length).toBeGreaterThan(0);
  });

  it('stays inside the event budget (acceptance ④)', () => {
    expect(events.length).toBeLessThanOrEqual(budget);
  });

  it('forwards the delegation lifecycle exactly once each', () => {
    const seen = kinds(events);
    expect(seen.filter((k) => k === 'started')).toHaveLength(1);
    expect(seen.filter((k) => k === 'report')).toHaveLength(1);
    expect(seen.filter((k) => k === 'tool.started')).toHaveLength(inner.size);
    expect(seen).not.toContain('capped');
  });

  it('carries no delegation prompt anywhere in the emitted stream', () => {
    const serialized = JSON.stringify(activities(events));
    expect(serialized).not.toContain('one short sentence describing the project');
  });

  it('still closes the turn with the ordinary terminal events', () => {
    expect(types(events)).toContain('session.completed');
    expect(types(events)).toContain('usage.updated');
  });
});
