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
  // T093: a TERMINAL provider error, because since decision 029 a retriable one
  // (any 5xx, or one with no status at all) is re-asked even after the stream
  // started. This case is about how a failure is REPORTED, not about the ladder.
  faux.setResponses([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: '400: provider rejected this' }),
  ]);
  expect((await r.run({ prompt: 'hello', systemPrompt: 'probe' })).success).toBe(false);
  expect(events.find((event) => event.type === 'session.failed')).toMatchObject({
    payload: { error: '400: provider rejected this' },
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
    // T101 moved WHEN this message is minted, not whether. A tool call is
    // content, so the row opening during the stream mints it — one message,
    // started and not yet completed. What must never appear is a message with
    // nothing in it, which is what the original defect produced.
    expect(events.filter((event) => event.type.startsWith('message.')).map((e) => e.type)).toEqual([
      'message.started',
    ]);
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
   * T066 rework. A run that ends in failure used to report `error` alone, so the
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

  /**
   * MODEL-18 (2026-09-19). Pressing Stop while a Task delegate was running took
   * the context badge from 2% to 0%.
   *
   * pi answers an abort by emitting `turn_end` with an EMPTY message and no
   * tool results, and `estimateContextTokens` skips an aborted message's usage
   * on purpose — so measuring that event counted the characters of nothing and
   * reported `{tokens: 0, percent: 0}`. The fold of the delegate's spend that
   * followed then re-stated the same zero from the cache. Stop does not empty
   * the context, so the last measured occupancy has to survive both events.
   */
  it('keeps the measured context occupancy when Stop ends the turn', () => {
    const events: RuntimeEventDraft[] = [];
    const projection = new RuntimeEventProjector(
      { sessionId: 'logical', emit: (event) => events.push(event) },
      'run',
      [],
      1000
    );
    const usage = {
      input: 120,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    };
    const settled = { ...fauxAssistantMessage('done'), usage } as AgentMessage;
    projection.observe({ type: 'turn_end', message: settled, toolResults: [] });
    const measured = events.find((event) => event.type === 'usage.updated')?.payload;
    expect(measured?.context).toEqual({ tokens: 150, contextWindow: 1000, percent: 15 });
    const session = measured?.session;
    expect(session).toMatchObject({ turns: 1, totalTokens: 150 });

    // The Stop. Empty content, no tool results, `stopReason: 'aborted'` — the
    // exact event `runLoop` emits, faux's zeroed usage included.
    events.length = 0;
    projection.observe({
      type: 'turn_end',
      message: fauxAssistantMessage('', { stopReason: 'aborted' }),
      toolResults: [],
    });
    const afterStop = events.find((event) => event.type === 'usage.updated')?.payload;
    expect(afterStop?.context).toEqual(measured?.context);
    // The running totals are unharmed: an abort bills nothing, it does not
    // un-bill the turns before it.
    expect(afterStop?.session).toEqual(session);

    // The second event from the field report: the delegate's spend settling
    // after the Stop must not re-state the placeholder either.
    events.length = 0;
    projection.delegated({
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
    });
    const folded = events.find((event) => event.type === 'usage.updated')?.payload;
    expect(folded?.context).toEqual(measured?.context);
    expect(folded?.delegated).toMatchObject({ totalTokens: 5 });
    // Re-stated from the last MEASURED turn, not from the aborted placeholder.
    expect(folded?.totalTokens).toBe(150);
  });

  /**
   * MODEL-18, the adjacent case the same guard covers. A provider failure ends
   * the loop through the SAME placeholder message a Stop does — `runLoop`
   * branches on `'error'` and `'aborted'` together (`agent-loop.js:124`) — so
   * it zeroed the badge by the same route, on a turn the user did not cancel.
   */
  it('keeps the measured context occupancy when the provider fails the turn', () => {
    const events: RuntimeEventDraft[] = [];
    const projection = new RuntimeEventProjector(
      { sessionId: 'logical', emit: (event) => events.push(event) },
      'run',
      [],
      1000
    );
    const settled = {
      ...fauxAssistantMessage('done'),
      usage: {
        input: 120,
        output: 30,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      },
    } as AgentMessage;
    projection.observe({ type: 'turn_end', message: settled, toolResults: [] });
    const measured = events.find((event) => event.type === 'usage.updated')?.payload;
    expect(measured?.context).toEqual({ tokens: 150, contextWindow: 1000, percent: 15 });

    events.length = 0;
    projection.observe({
      type: 'turn_end',
      message: fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'provider unavailable',
      }),
      toolResults: [],
    });
    const afterFailure = events.find((event) => event.type === 'usage.updated')?.payload;
    expect(afterFailure?.context).toEqual(measured?.context);
  });

  /**
   * MODEL-18, the other half: a run aborted before any turn settled has no
   * occupancy to re-state, and saying `0%` would assert one. The key is dropped
   * instead — the rule `buildPiInterimUsagePayload` already follows.
   */
  it('reports no context at all when the first turn is the aborted one', () => {
    const events: RuntimeEventDraft[] = [];
    const projection = new RuntimeEventProjector(
      { sessionId: 'logical', emit: (event) => events.push(event) },
      'run',
      [],
      1000
    );
    projection.observe({
      type: 'turn_end',
      message: fauxAssistantMessage('', { stopReason: 'aborted' }),
      toolResults: [],
    });
    const payload = events.find((event) => event.type === 'usage.updated')?.payload;
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('context');
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
      // T093 / decision 029 clause 3 — absolute instants, so the banner can run
      // a countdown instead of showing a number frozen when it was drawn.
      retryAt: expect.any(Number),
      attemptStartedAt: expect.any(Number),
    },
  });
  const retry = statuses[announced].payload.retry;
  // `retryAt` is the instant the attempt failed plus the backoff, so the two
  // fields together say how long the attempt itself ran — the figure the
  // 2026-09-19 field report had no way to obtain.
  expect(retry?.retryAt).toBeGreaterThanOrEqual((retry?.attemptStartedAt ?? 0) + 3_000);
  // The banner comes down when the retried request starts streaming, not when
  // the turn ends.
  expect(statuses[announced + 1]?.payload).toEqual({ status: 'running' });
}, 20_000);

/**
 * T101 — a tool row appears while the model is still dictating the call.
 *
 * The defect this covers produced no error and no log line: `write` takes the
 * whole file as an argument, and a row was only opened at
 * `tool_execution_start`, which is AFTER the model has finished emitting it.
 * A large file therefore left the screen completely still for minutes — a
 * spinning group head with nothing under it — and not even a liveness event to
 * say the turn was alive.
 *
 * The cases below drive the projector directly, because the faux provider
 * cannot reproduce the shape: it fills `arguments` only at `toolcall_end`
 * (`pi-ai/dist/providers/faux.js`), so a recorded fixture has no partial
 * arguments in it at all. The partial-message snapshots here are the shape a
 * real provider streams (`parseStreamingJson` over accumulated partial JSON).
 */
describe('T101 · streaming tool rows', () => {
  /** A clock the test moves by hand, so the 100 ms window is not a timing race. */
  function clock(start = 0) {
    let value = start;
    return {
      now: () => value,
      advance(ms: number) {
        value += ms;
      },
    };
  }

  function projector(options: { streamToolRows?: boolean; now?: () => number } = {}) {
    const events: RuntimeEventDraft[] = [];
    const projection = new RuntimeEventProjector(
      { sessionId: 'logical', emit: (event) => events.push(event) },
      'run',
      [],
      undefined,
      {},
      options
    );
    return { events, projection };
  }

  /**
   * One cumulative snapshot, as `message_update` carries it. `arguments` is an
   * OBJECT even mid-stream — pi partial-parses the accumulated JSON — so the
   * fields that arrived first are readable before the rest exists.
   */
  function partial(
    args: Record<string, unknown>,
    options: { id?: string; name?: string } = {}
  ): AgentMessage {
    return fauxAssistantMessage(
      [fauxToolCall(options.name ?? 'write', args, { id: options.id ?? 'w1' })],
      {
        stopReason: 'toolUse',
      }
    );
  }

  function update(message: AgentMessage): AgentEvent {
    return {
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'start', partial: message } as never,
    };
  }

  const started = (events: RuntimeEventDraft[]) => events.filter((e) => e.type === 'tool.started');
  const updated = (events: RuntimeEventDraft[]) => events.filter((e) => e.type === 'tool.updated');

  it('opens a tool row while its arguments are still streaming', () => {
    const { events, projection } = projector();
    const message = partial({ path: 'src/index.html' });
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));

    const rows = started(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ toolCallId: 'w1', name: 'write' });
    // The row hangs on a real assistant message, minted for it — a row filed
    // against a message the renderer never opened is silently dropped there.
    const opened = events.find((event) => event.type === 'message.started');
    expect(rows[0]?.payload.messageId).toBe(opened?.payload.messageId);
    // Nothing has executed. `tool_execution_start` has not happened yet and
    // must not be what the row waited for.
    expect(events.some((event) => event.type === 'tool.completed')).toBe(false);
  });

  it('the streaming row carries the path but never the file body', () => {
    const { events, projection } = projector();
    const body = 'line one\nline two\nline three';
    const message = partial({ path: 'src/index.html', content: body });
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));

    const input = started(events)[0]?.payload.input as Record<string, unknown>;
    expect(input.path).toBe('src/index.html');
    expect(input).not.toHaveProperty('content');
    // What replaces it is a size, which is what lets the row say how far along
    // the file is without carrying the file.
    expect(input.__streaming).toEqual({ bytes: body.length, lines: 3 });
    // The belt-and-braces version of the assertion above: no serialization of
    // this event contains any of the file, at any depth.
    expect(JSON.stringify(input)).not.toContain('line one');
  });

  it('withholds long text however deeply the schema nests it', () => {
    // `edit` puts its before/after texts inside an ARRAY of objects, so a rule
    // that only looked at top-level string fields would forward the whole file
    // twice over. The summary is an allow list for exactly this reason: a tool
    // whose long field nobody thought about is summarized, not leaked.
    const { events, projection } = projector();
    const message = partial(
      {
        path: 'src/app.ts',
        edits: [{ oldText: 'const a = 1;\n', newText: 'const a = 2;\nconst b = 3;\n' }],
      },
      { name: 'edit', id: 'e1' }
    );
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));

    const input = started(events)[0]?.payload.input as Record<string, unknown>;
    expect(input.path).toBe('src/app.ts');
    expect(input).not.toHaveProperty('edits');
    expect(JSON.stringify(input)).not.toContain('const a');
    // Three lines across both texts, counted as one body.
    expect(input.__streaming).toMatchObject({ lines: 3 });
  });

  it('coalesces argument deltas to at most one update per 100ms', () => {
    const time = clock();
    const { events, projection } = projector({ now: time.now });
    projection.observe({ type: 'message_start', message: partial({}) });
    projection.observe(update(partial({ path: 'a.txt' })));
    expect(started(events)).toHaveLength(1);

    // Chunks inside the first window produce nothing at all: the row is
    // already on screen and the only thing that moved is a byte counter.
    for (let chunk = 1; chunk <= 20; chunk += 1) {
      time.advance(4);
      projection.observe(update(partial({ path: 'a.txt', content: 'x'.repeat(chunk) })));
    }
    expect(updated(events)).toHaveLength(0);

    // A full second of a realistic provider cadence — 250 more chunks at 4 ms
    // apiece — is ten events, not 250. That ratio is the whole point: without
    // it every token of an 8 MiB `write` is a store write and a re-render.
    for (let chunk = 21; chunk <= 270; chunk += 1) {
      time.advance(4);
      projection.observe(update(partial({ path: 'a.txt', content: 'x'.repeat(chunk) })));
    }
    expect(updated(events)).toHaveLength(10);

    // A snapshot that repeats itself is not a change, window or no window.
    // Flush what the last window still owed first, so the repeat below is a
    // repeat of something already on screen rather than of an older state.
    time.advance(1_000);
    projection.observe(update(partial({ path: 'a.txt', content: 'x'.repeat(270) })));
    expect(updated(events)).toHaveLength(11);
    time.advance(1_000);
    projection.observe(update(partial({ path: 'a.txt', content: 'x'.repeat(270) })));
    expect(updated(events)).toHaveLength(11);
  });

  it('does not duplicate the row when tool_execution_start arrives', () => {
    const { events, projection } = projector();
    const message = partial({ path: 'a.txt', content: 'hello' });
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));
    projection.observe({ type: 'message_end', message });
    projection.observe({
      type: 'tool_execution_start',
      toolCallId: 'w1',
      toolName: 'write',
      args: { path: 'a.txt', content: 'hello' },
    } as AgentEvent);

    // One row for one call. A second `tool.started` would append a second
    // `tool_call` block that could never be paired with the single result.
    expect(started(events)).toHaveLength(1);
    const rows = started(events);
    const updates = updated(events);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    // Every later event agrees with the row's own message and id.
    for (const event of updates) {
      expect(event.payload.messageId).toBe(rows[0]?.payload.messageId);
      expect(event.payload.toolCallId).toBe('w1');
    }
  });

  it('fills in the full arguments once the call is complete', () => {
    const { events, projection } = projector();
    const message = partial({ path: 'a.txt', content: 'hello\nworld' });
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));
    expect(started(events)[0]?.payload.input).not.toHaveProperty('content');

    projection.observe({ type: 'message_end', message });
    const settled = updated(events).at(-1)?.payload.input as Record<string, unknown>;
    expect(settled).toEqual({ path: 'a.txt', content: 'hello\nworld' });
    // The marker is GONE, which is how the renderer knows it may draw a diff.
    expect(settled).not.toHaveProperty('__streaming');
  });

  it('settles an unfinished tool row when the run is stopped', () => {
    const { events, projection } = projector();
    const message = partial({ path: 'a.txt', content: 'half a fi' });
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));
    expect(started(events)).toHaveLength(1);

    // Stop. The call is never executed, so nothing else would ever speak about
    // this row — and `pairToolBlocks` leaves an unpaired call `running`, i.e.
    // a spinner on a finished transcript, forever.
    projection.finish({ success: false, stopReason: 'aborted' });
    const terminal = events.filter((event) => event.type === 'tool.completed');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.payload).toMatchObject({ toolCallId: 'w1', ok: false });
    expect(terminal[0]?.payload.error).toBeTruthy();
    // Before the message it hangs on is closed — a block appended to a message
    // the store has already completed still renders, but the ordering that
    // produced it would be a lie.
    const completedAt = events.findIndex((event) => event.type === 'message.completed');
    const terminalAt = events.findIndex((event) => event.type === 'tool.completed');
    expect(terminalAt).toBeLessThan(completedAt);
  });

  /**
   * N5 (devbox 2026-09-24): the 47 calls a loop-guard cut left behind read as
   * completed ones. The flag is what the row reads; the sentence stays for
   * anything that only shows text.
   */
  it('[N5-PROJ-1] marks a call the run ended before as notStarted, structurally', () => {
    const { events, projection } = projector();
    const message = partial({ path: 'a.txt', content: 'half a fi' });
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));
    projection.finish({ success: false, stopReason: 'aborted' });
    const terminal = events.find((event) => event.type === 'tool.completed');
    expect(terminal?.payload).toMatchObject({
      ok: false,
      error: 'The run ended before this call started.',
      output: {
        content: [{ type: 'text', text: 'The run ended before this call started.' }],
        details: { notStarted: true },
      },
    });
  });

  it('[N5-PROJ-2] forwards a tool result’s own refusal flag, and only that', () => {
    const { events, projection } = projector();
    const end = (toolCallId: string, result: unknown) =>
      projection.observe({
        type: 'tool_execution_end',
        toolCallId,
        toolName: 'TaskWait',
        args: {},
        result,
        isError: false,
      } as AgentEvent);
    const refusal = 'Refused: TaskWait has nothing left to act on.';
    end('r1', {
      content: [{ type: 'text', text: refusal }],
      details: { status: 'refused', delegations: [], idle: true, refused: true },
    });
    // The first idle call is answered in full — idle, not refused.
    end('r2', { content: [{ type: 'text', text: 'Nothing is left.' }], details: { idle: true } });
    const completed = events.filter((event) => event.type === 'tool.completed');
    expect(completed[0]?.payload).toMatchObject({
      ok: true,
      output: { content: [{ type: 'text', text: refusal }], details: { refused: true } },
    });
    // Only the flags the timeline reads cross the wire, not the tool's whole bag.
    expect((completed[0]?.payload.output as { details: object }).details).toEqual({
      refused: true,
    });
    expect(completed[1]?.payload.output).toBe('Nothing is left.');
  });

  it('leaves a row that really ran alone', () => {
    // The other side of the case above: a settled call must NOT also be
    // reported as cancelled when its turn ends.
    const { events, projection } = projector();
    const message = partial({ path: 'a.txt', content: 'hi' });
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));
    projection.observe({ type: 'message_end', message });
    projection.observe({
      type: 'tool_execution_start',
      toolCallId: 'w1',
      toolName: 'write',
      args: { path: 'a.txt', content: 'hi' },
    } as AgentEvent);
    projection.observe({
      type: 'tool_execution_end',
      toolCallId: 'w1',
      toolName: 'write',
      args: { path: 'a.txt', content: 'hi' },
      result: 'Wrote 2 bytes',
      isError: false,
    } as AgentEvent);
    projection.finish({ success: true, stopReason: 'stop' });

    const terminal = events.filter((event) => event.type === 'tool.completed');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.payload.ok).toBe(true);
  });

  it('the flag off restores the old behaviour', () => {
    const { events, projection } = projector({ streamToolRows: false });
    const message = partial({ path: 'a.txt', content: 'hello' });
    projection.observe({ type: 'message_start', message });
    projection.observe(update(message));
    projection.observe({ type: 'message_end', message });
    // Not one word about the call until the runtime agrees to run it.
    expect(started(events)).toHaveLength(0);
    expect(updated(events)).toHaveLength(0);

    projection.observe({
      type: 'tool_execution_start',
      toolCallId: 'w1',
      toolName: 'write',
      args: { path: 'a.txt', content: 'hello' },
    } as AgentEvent);
    const rows = started(events);
    expect(rows).toHaveLength(1);
    // The pre-T101 payload exactly: the full arguments, on `tool.started`.
    expect(rows[0]?.payload.input).toEqual({ path: 'a.txt', content: 'hello' });
    expect(updated(events)).toHaveLength(0);
  });
});
