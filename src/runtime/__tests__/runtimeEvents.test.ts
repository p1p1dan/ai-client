import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import { RuntimeEventProjector } from '../events/projector.ts';
import { neverAsked } from './fixtures/approval.ts';

const runtimes: RuntimeHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
it('projects a real tool run with text, thinking, tool result, usage and terminal events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-events-'));
  dirs.push(dir);
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  faux.setResponses([
    fauxAssistantMessage(
      [
        { type: 'thinking', thinking: 'inspect first' },
        { type: 'text', text: 'Looking up files.' },
        fauxToolCall('glob', { pattern: '*' }, { id: 'glob-1' }),
      ],
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage('Done.'),
  ]);
  const r = await createRuntime({
    env: {},
    providers: [faux.provider],
    tools: { cwd: dir },
    permissions: { approve: neverAsked },
  });
  runtimes.push(r);
  const events: RuntimeEventDraft[] = [];
  r.events.subscribe((event) => events.push(event));
  const result = await r.run({
    prompt: 'inspect',
    systemPrompt: 'probe',
    logicalSessionId: 'logical',
  });
  expect(result.success).toBe(true);
  expect(events.every((event) => event.sessionId === 'logical')).toBe(true);
  const prose = events
    .filter((event) => event.type === 'message.delta')
    .map((event) => event.payload.text)
    .join('');
  expect(prose).toBe('inspectLooking up files.Done.');
  expect(
    events
      .filter((event) => event.type === 'thinking.delta')
      .map((event) => event.payload.text)
      .join('')
  ).toBe('inspect first');
  expect(events.find((event) => event.type === 'tool.completed')).toMatchObject({
    payload: { toolCallId: 'glob-1', ok: true },
  });
  // Two SETTLED bills — one per model call — and one first-byte tick ahead of
  // each of them (2026-09-19). The tick is what lights the turn head's `↑`
  // while the call is still streaming, so it must never carry a completion
  // count: `buildPiInterimUsagePayload` forces `output` to 0 rather than pass
  // on Anthropic's `output_tokens: 1` placeholder.
  const usage = events.filter((event) => event.type === 'usage.updated');
  const pending = usage.filter((event) => event.payload.pending === true);
  expect(usage.filter((event) => event.payload.pending !== true)).toHaveLength(2);
  expect(pending).toHaveLength(2);
  for (const tick of pending) {
    expect(tick.payload.output).toBe(0);
    expect(tick.payload.costUsd).toBe(0);
    expect(Number(tick.payload.totalTokens)).toBeGreaterThan(0);
  }
  // Ordering is the whole point: a tick that arrived after its own settled
  // bill would overwrite a measured total with a half-measured one.
  expect(usage.findIndex((event) => event.payload.pending === true)).toBe(0);
  expect(events.filter((event) => event.type === 'session.completed')).toHaveLength(1);
});
it('reports provider and first-request budget failures as failed sessions', async () => {
  const faux = fauxProvider({
    provider: 'test',
    models: [{ id: 'test', name: 'Test', contextWindow: 32000 }],
  });
  const r = await createRuntime({ env: {}, providers: [faux.provider] });
  runtimes.push(r);
  const events: RuntimeEventDraft[] = [];
  r.events.subscribe((event) => events.push(event));
  faux.setResponses([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider unavailable' }),
  ]);
  expect((await r.run({ prompt: 'hello', systemPrompt: 'probe' })).success).toBe(false);
  expect(events.find((event) => event.type === 'session.failed')).toMatchObject({
    payload: { error: 'provider unavailable' },
  });
  events.length = 0;
  expect((await r.run({ prompt: 'x'.repeat(200_000), systemPrompt: 'probe' })).success).toBe(false);
  expect(events.filter((event) => event.type === 'session.failed')).toHaveLength(1);
  expect(events.some((event) => event.type === 'session.completed')).toBe(false);
});

it('keeps its own bookkeeping off the wire, stamps the run identity, and preserves cumulative usage after resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-event-session-'));
  dirs.push(dir);
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  const file = join(dir, 'session.jsonl');
  const first = await createRuntime({
    env: {},
    providers: [faux.provider],
    tools: { cwd: dir },
    permissions: { approve: neverAsked },
    session: { file, cwd: dir, mode: 'create' },
  });
  runtimes.push(first);
  faux.setResponses([fauxAssistantMessage('first')]);
  const events: RuntimeEventDraft[] = [];
  first.events.subscribe((event) => events.push(event));
  await first.run({ prompt: 'one', systemPrompt: 'probe', logicalSessionId: 'logical' });
  // The permission bookkeeping entry IS written to the file (the branch has to
  // remember which gate it ran under) but must not travel: the renderer turns
  // every custom entry into a visible system message and opens a turn around
  // it, so leaking one heads the transcript with a row of raw JSON (P4-5).
  expect(events.some((e) => e.type === 'custom.entry')).toBe(false);
  expect(
    first.session
      ?.snapshot()
      .entries.some(
        (entry) => entry.type === 'custom' && entry.customType === 'aiclient.permissions'
      )
  ).toBe(true);
  // Everything that DOES travel carries the run identity rather than the
  // store's internal session id.
  expect(events.every((e) => e.sessionId === 'logical')).toBe(true);
  await first.dispose();
  const second = await createRuntime({
    env: {},
    providers: [faux.provider],
    session: { file, cwd: dir, mode: 'resume' },
  });
  runtimes.push(second);
  second.events.subscribe((event) => events.push(event));
  faux.setResponses([fauxAssistantMessage('second')]);
  await second.run({ prompt: 'two', systemPrompt: 'probe', logicalSessionId: 'logical' });
  // Settled bills only: the first-byte ticks carry no `session` rollup at all
  // (they describe one call's prompt, not the conversation), so counting them
  // here would say nothing about what survived the resume.
  const usages = events.filter((e) => e.type === 'usage.updated' && e.payload.pending !== true);
  expect(usages).toHaveLength(2);
  expect(usages[1].payload).toMatchObject({ session: { turns: 2 } });
});
it('emits stopped for cancellation and failed for model resolution errors', async () => {
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  const runtime = await createRuntime({ env: {}, providers: [faux.provider] });
  runtimes.push(runtime);
  const events: RuntimeEventDraft[] = [];
  runtime.events.subscribe((event) => events.push(event));
  const controller = new AbortController();
  controller.abort();
  expect((await runtime.run({ prompt: 'cancelled', signal: controller.signal })).stopReason).toBe(
    'aborted'
  );
  expect(events.filter((e) => e.type === 'session.stopped')).toHaveLength(1);
  events.length = 0;
  await expect(
    runtime.run({ prompt: 'bad model', model: { provider: 'missing', id: 'missing' } })
  ).rejects.toThrow();
  expect(events.filter((e) => e.type === 'session.failed')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: 'session.status', payload: { status: 'idle' } });
});

it('deduplicates cumulative deltas and keeps overlapping tool results attached to their starts', async () => {
  const { RuntimeEventProjector } = await import('../events/projector.ts');
  const events: RuntimeEventDraft[] = [];
  const projection = new RuntimeEventProjector(
    { sessionId: 'logical', emit: (e) => events.push(e) },
    'run'
  );
  const message = fauxAssistantMessage([
    { type: 'thinking', thinking: 'reason' },
    { type: 'text', text: 'answer' },
  ]);
  projection.start();
  projection.observe({ type: 'message_start', message });
  for (let i = 0; i < 2; i++)
    projection.observe({
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'start', partial: message },
    });
  projection.observe({ type: 'message_end', message });
  expect(
    events
      .filter((e) => e.type === 'message.delta')
      .map((e) => e.payload.text)
      .join('')
  ).toBe('answer');
  expect(events.findIndex((e) => e.type === 'thinking.completed')).toBeLessThan(
    events.findIndex((e) => e.type === 'message.delta')
  );
  for (const id of ['one', 'two'])
    projection.observe({
      type: 'tool_execution_start',
      toolCallId: id,
      toolName: 'read',
      args: {},
    });
  projection.observe({
    type: 'tool_execution_update',
    toolCallId: 'one',
    toolName: 'read',
    args: {},
    partialResult: { content: [{ type: 'text', text: `old\n${'x'.repeat(180)}` }] },
  });
  for (const id of ['two', 'one'])
    projection.observe({
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: 'read',
      result: 'failed read',
      isError: true,
    });
  const starts = events.filter((e) => e.type === 'tool.started');
  for (const end of events.filter((e) => e.type === 'tool.completed')) {
    expect(end.payload.messageId).toBe(
      starts.find((s) => s.payload.toolCallId === end.payload.toolCallId)?.payload.messageId
    );
    expect(end.payload).toMatchObject({ ok: false, error: 'failed read' });
  }
  expect(events.find((e) => e.type === 'tool.updated')?.payload.status?.length).toBe(120);
  projection.compaction('saved summary');
  expect(
    events.find((e) => e.type === 'message.delta' && e.payload.text.includes('saved summary'))
  ).toBeDefined();
  projection.observe({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'visible',
      content: 'custom text',
      display: true,
      timestamp: 1,
    },
  });
  expect(events.find((e) => e.type === 'custom.message')).toMatchObject({
    payload: { content: 'custom text' },
  });
  projection.finish({ success: true, stopReason: 'stop' });
});

it('reads a tool result out of its content blocks instead of stringifying them', async () => {
  // The transcript used to show `[{"type":"text","text":"Successfully wrote…"}]`
  // because a block array went through JSON.stringify. Only a shape nothing can
  // read may fall back to JSON — hiding the result would be worse than raw.
  const { output } = await import('../events/projector.ts');
  expect(output({ content: [{ type: 'text', text: 'the answer is 42' }] })).toBe(
    'the answer is 42'
  );
  expect(output({ content: 'already text' })).toBe('already text');
  expect(output('bare string')).toBe('bare string');
  expect(output(undefined)).toBe('');
  expect(output({ content: [{ type: 'image', data: 'x' }] })).toBe('[{"type":"image","data":"x"}]');
});

/**
 * T017 — the projector's own seams, driven directly.
 *
 * Every case below covers a defect that produced NO error: a phantom message
 * the timeline filtered out, a tool row on the wrong id, a `tool.updated` the
 * renderer discarded on its first line, a rewritten snapshot that muted the
 * rest of a message. The runtime kept working through all of them, which is
 * why they survived to an audit.
 */
describe('T017 · projection seams', () => {
  function projector(): { events: RuntimeEventDraft[]; projection: RuntimeEventProjector } {
    const events: RuntimeEventDraft[] = [];
    const projection = new RuntimeEventProjector(
      { sessionId: 'logical', emit: (event) => events.push(event) },
      'run'
    );
    return { events, projection };
  }
  /** The cumulative snapshot shape pi streams, as one `message_update`. */
  function update(message: AgentMessage): AgentEvent {
    return {
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'start', partial: message } as never,
    };
  }

  it('hangs the tool rows on the message that asked for them', () => {
    // rpc-projector-03. pi emits the tool rows AFTER `message_end`, so closing
    // the message there left the model's own words in one message and the calls
    // it made in a second, model-less one minted to carry them.
    const { events, projection } = projector();
    const message = fauxAssistantMessage(
      [
        { type: 'text', text: 'Looking at the notes.' },
        fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-1' }),
      ],
      { stopReason: 'toolUse' }
    );
    projection.start();
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));
    projection.observe({ type: 'message_end', message });
    projection.observe({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'notes.txt' },
    });
    projection.observe({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read',
      result: 'the answer is 42',
      isError: false,
    });
    projection.observe({ type: 'turn_end', message, toolResults: [] });
    const started = events.filter((event) => event.type === 'message.started');
    expect(started).toHaveLength(1);
    const messageId = started[0].payload.messageId;
    expect(events.find((event) => event.type === 'tool.started')?.payload.messageId).toBe(
      messageId
    );
    expect(events.find((event) => event.type === 'tool.completed')?.payload.messageId).toBe(
      messageId
    );
    // Closed once, by the round ending — not by the message that opened it.
    expect(
      events.filter((event) => event.type === 'message.completed').map((e) => e.payload.messageId)
    ).toEqual([messageId]);
  });

  it('opens no message for an assistant turn that says nothing', () => {
    // rpc-projector-03, the other half: an assistant message is opened by its
    // first CONTENT. A pure tool-call turn has none, and opening one on the
    // announcement produced the empty `started` + `completed` pair the timeline
    // only hid by filtering on `blocks.length > 0`.
    const { events, projection } = projector();
    const message = fauxAssistantMessage(
      [fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-1' })],
      { stopReason: 'toolUse' }
    );
    projection.start();
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));
    projection.observe({ type: 'message_end', message });
    expect(events.filter((event) => event.type.startsWith('message.'))).toEqual([]);
    projection.observe({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'notes.txt' },
    });
    projection.observe({ type: 'turn_end', message, toolResults: [] });
    // Exactly one message exists for the whole turn, and it is the one the tool
    // row hangs on.
    const started = events.filter((event) => event.type === 'message.started');
    expect(started).toHaveLength(1);
    expect(events.filter((event) => event.type === 'message.completed')).toHaveLength(1);
  });

  it('stamps the announced model on a message a tool row minted', () => {
    // The metadata row reads the model off the last opened assistant message,
    // and a turn whose message was minted by a tool row reported `null`.
    const { events, projection } = projector();
    const message = fauxAssistantMessage([fauxToolCall('read', {}, { id: 'call-1' })], {
      stopReason: 'toolUse',
    });
    projection.observe({ type: 'message_start', message });
    projection.observe({ type: 'message_end', message });
    projection.observe({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: {},
    });
    expect(events.find((event) => event.type === 'message.started')?.payload).toMatchObject({
      role: 'assistant',
      model: 'faux/faux-1',
    });
    // And the model does not outlive its message: the compaction row that
    // follows is a system message and must not inherit it.
    projection.observe({ type: 'turn_end', message, toolResults: [] });
    projection.compaction('summary');
    expect(
      events.filter((event) => event.type === 'message.started').at(-1)?.payload
    ).not.toHaveProperty('model');
  });

  it('keeps streaming after the provider rewrites its snapshot, and repeats add nothing', () => {
    // rpc-projector-13. The cursor used to stay on text the provider had
    // abandoned, so every later snapshot diverged too and the whole rest of the
    // message — `message_end`'s final flush included — went silently missing.
    const { events, projection } = projector();
    const say = (text: string) => fauxAssistantMessage(text);
    projection.observe({ type: 'message_start', message: say('') });
    projection.observe(update(say('Hel')));
    projection.observe(update(say('Hel'))); // the same snapshot twice
    projection.observe(update(say('He'))); // a truncation
    projection.observe(update(say('HELLO'))); // a rewrite
    projection.observe(update(say('HELLO there')));
    projection.observe({ type: 'message_end', message: say('HELLO there!') });
    const deltas = events.filter((event) => event.type === 'message.delta');
    // Three deltas: the growth, the growth after the rewrite, and the final
    // flush. The repeat, the truncation and the rewrite itself add none.
    expect(deltas.map((event) => event.payload.text)).toEqual(['Hel', ' there', '!']);
  });

  it('carries the arguments a tool row is drawn from on every update', () => {
    // rpc-projector-07. The renderer's reducer bails on its first line when
    // `input` is absent, so a native `tool.updated` was a no-op there.
    const { events, projection } = projector();
    projection.observe({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    projection.observe({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls -la' },
      partialResult: { content: [{ type: 'text', text: 'total 0' }] },
    });
    expect(events.find((event) => event.type === 'tool.updated')?.payload).toMatchObject({
      input: { command: 'ls -la' },
      status: 'total 0',
    });
  });

  it('announces a provider retry as a running status, and takes the banner down', () => {
    // rpc-projector-02, projector half. Status stays `running` — the turn IS
    // alive — and the store clears the banner on the next status with no retry.
    const { events, projection } = projector();
    projection.retry({
      attempt: 1,
      maxRetries: 3,
      delayMs: 3_000,
      errorStatus: null,
      error: 'PROVIDER_ERROR',
    });
    projection.recovered();
    expect(events.map((event) => event.payload)).toEqual([
      {
        status: 'running',
        retry: {
          attempt: 1,
          maxRetries: 3,
          delayMs: 3_000,
          errorStatus: null,
          error: 'PROVIDER_ERROR',
        },
      },
      { status: 'running' },
    ]);
  });

  /**
   * T066 回炉. A run that ends in failure used to report `error` alone, so the
   * operator log had no code to grep and read `turn failed: session exceeds the
   * configured size budget`. The code rides BESIDE the sentence rather than in
   * front of it, because this sentence is the one the renderer shows — putting
   * `stop_error:` in front of a provider's 503 would be a worse trade.
   */
  it('reports the failure code beside the sentence, not inside it', () => {
    const { events, projection } = projector();
    projection.finish({
      success: false,
      stopReason: 'error',
      error: { code: 'session_size_limit', message: 'session exceeds the configured size budget' },
    });
    expect(events[0]).toMatchObject({
      type: 'session.failed',
      payload: {
        error: 'session exceeds the configured size budget',
        errorCode: 'session_size_limit',
      },
    });
  });

  it('carries no code on a run that ended cleanly', () => {
    const { events, projection } = projector();
    projection.finish({ success: true, stopReason: 'stop' });
    expect(events[0]).toEqual({
      type: 'session.completed',
      sessionId: 'logical',
      requestId: 'run',
      payload: {},
    });
  });

  /**
   * T053. `delegated()` used to hardcode the context-occupancy argument to
   * `undefined`, so the `usage.updated` it emits when a delegate settles wiped
   * the `context` field entirely — the renderer's `foldSettledUsage` replaces
   * it wholesale, so the occupancy ring read as zero for as long as a
   * delegation was in flight, even though the parent turn's occupancy had not
   * changed.
   */
  it('keeps the last turn context occupancy on a usage.updated a delegate settling re-states', () => {
    const events: RuntimeEventDraft[] = [];
    const projection = new RuntimeEventProjector(
      { sessionId: 'logical', emit: (event) => events.push(event) },
      'run',
      [],
      1000
    );
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    };
    const message = { ...fauxAssistantMessage('done'), usage } as AgentMessage;
    projection.observe({ type: 'message_start', message });
    projection.observe({ type: 'message_end', message });
    projection.observe({ type: 'turn_end', message, toolResults: [] });
    const turnPayload = events.find((event) => event.type === 'usage.updated')?.payload;
    expect(turnPayload?.context).toBeDefined();

    events.length = 0;
    projection.delegated({
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
    });
    const delegatedPayload = events.find((event) => event.type === 'usage.updated')?.payload;
    expect(delegatedPayload?.context).toBeDefined();
    expect(delegatedPayload?.context).toEqual(turnPayload?.context);
  });
});

it('puts a provider retry on the wire the banner reads, and clears it when the retry streams', async () => {
  // rpc-projector-02, whole path: the retry ladder used to write to the trace
  // file and nothing else, so a 429 burst was indistinguishable from a slow
  // model for up to ~43 seconds.
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  faux.setResponses([
    () => {
      // Thrown rather than answered: faux reports it as an error event with no
      // preceding `start`, which is the setup failure this layer retries.
      throw new Error('503: service unavailable');
    },
    fauxAssistantMessage('recovered'),
  ]);
  const runtime = await createRuntime({ env: {}, traceDir: null, providers: [faux.provider] });
  runtimes.push(runtime);
  const events: RuntimeEventDraft[] = [];
  runtime.events.subscribe((event) => events.push(event));
  expect((await runtime.run({ prompt: 'hello', systemPrompt: 'probe' })).success).toBe(true);
  const statuses = events.filter((event) => event.type === 'session.status');
  const announced = statuses.findIndex((event) => event.payload.retry);
  expect(announced).toBeGreaterThanOrEqual(0);
  expect(statuses[announced].payload).toEqual({
    status: 'running',
    retry: {
      attempt: 1,
      maxRetries: 3,
      delayMs: 3_000,
      // Null, not a code: faux never reaches the fetch wrapper, which is the
      // same shape a socket that never connected produces.
      errorStatus: null,
      error: 'PROVIDER_ERROR',
    },
  });
  // The banner comes down when the retried request starts streaming, not when
  // the turn ends.
  expect(statuses[announced + 1]?.payload).toEqual({ status: 'running' });
}, 20_000);
