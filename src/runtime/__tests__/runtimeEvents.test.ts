import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';

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
  const r = await createRuntime({ env: {}, providers: [faux.provider], tools: { cwd: dir } });
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
  expect(events.filter((event) => event.type === 'usage.updated')).toHaveLength(2);
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

it('emits durable custom entries with the run identity and preserves cumulative usage after resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-event-session-'));
  dirs.push(dir);
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  const file = join(dir, 'session.jsonl');
  const first = await createRuntime({
    env: {},
    providers: [faux.provider],
    tools: { cwd: dir },
    session: { file, cwd: dir, mode: 'create' },
  });
  runtimes.push(first);
  faux.setResponses([fauxAssistantMessage('first')]);
  const events: RuntimeEventDraft[] = [];
  first.events.subscribe((event) => events.push(event));
  await first.run({ prompt: 'one', systemPrompt: 'probe', logicalSessionId: 'logical' });
  expect(events.find((e) => e.type === 'custom.entry')).toMatchObject({
    sessionId: 'logical',
    payload: { customType: 'aiclient.permissions' },
  });
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
  const usages = events.filter((e) => e.type === 'usage.updated');
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
