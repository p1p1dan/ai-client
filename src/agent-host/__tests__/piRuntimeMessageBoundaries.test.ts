import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionPluginDecision } from '../permissionPlugin.ts';
import { PiAgentRuntime } from '../piRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';
import { type CapturedEvent, createPiSdkStub } from './fixtures/piSdkStub.ts';

/**
 * T12-a — assistant message boundaries inside one pi run.
 *
 * The fact this file exists to protect: ONE `agent_start` brackets MANY pi
 * turns (the SDK's `turn_end` carries a `turnIndex`), and a tool-using answer
 * is `prose -> tool -> prose` spread across SEPARATE assistant messages.
 *
 * Before `closeAssistantMessage`, the whole run shared one `assistantMessageId`
 * and one `textBlockId`. The renderer appends a delta to the block that already
 * carries that id, wherever it sits, so:
 *   - the second paragraph was concatenated onto the first with no separator,
 *     and
 *   - it rendered BEFORE the tool row that had actually preceded it.
 *
 * Nothing downstream was wrong: `groupTimeline` walks blocks in order and
 * `segmentTurnBody` preserves runs. The order simply never reached them.
 * `piTurnItemOrder.test.ts` locks the renderer half of the same contract.
 */

const GATED: PermissionPluginDecision = {
  additionalExtensionPaths: ['/bundle/pi-permission-system'],
  reason: 'bundled',
  gated: true,
};

function harness() {
  const events: CapturedEvent[] = [];
  const stub = createPiSdkStub({ manualPrompt: true });
  const runtime = new PiAgentRuntime({
    registry: new SessionRegistry(),
    emit: (event) => events.push(event as CapturedEvent),
    log: () => undefined,
    loadSdk: async () => stub.sdk,
    decidePermissionGate: () => GATED,
  });
  return { events, stub, runtime };
}

/** Replay one `prose -> tool -> prose` run, exactly as pi orders it. */
async function runTwoStepTurn() {
  const h = harness();
  h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
  const send = h.runtime.send({ sessionId: 'a', text: 'go' });
  await vi.waitFor(() => expect(h.stub.sessionFor('/repo-a')).toBeDefined());
  const pi = h.stub.sessionFor('/repo-a');

  pi?.emit({ type: 'agent_start' } as { type: string });

  // pi turn 1: prose, then the model asks for a tool.
  pi?.emit({ type: 'message_start', message: { role: 'assistant' } } as { type: string });
  pi?.emit({
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Let me read the file.' }] },
  } as { type: string });
  pi?.emit({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'toolUse' },
  } as { type: string });

  pi?.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'Read',
    args: { path: 'a.ts' },
  } as { type: string });
  pi?.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'Read',
    result: { content: 'contents' },
  } as { type: string });

  // pi turn 2: the answer that reads the tool's output.
  pi?.emit({ type: 'message_start', message: { role: 'assistant' } } as { type: string });
  pi?.emit({
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: 'The file says X.' }] },
  } as { type: string });
  pi?.emit({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'stop' },
  } as { type: string });

  h.stub.finishPrompt('/repo-a');
  await send;
  return h;
}

function assistantStarts(events: CapturedEvent[]) {
  return events.filter(
    (event) =>
      event.type === 'message.started' &&
      (event.payload as { role?: string } | undefined)?.role === 'assistant'
  );
}

function payloadField(event: CapturedEvent | undefined, key: string): string | undefined {
  const value = (event?.payload as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pi assistant message boundaries', () => {
  it('opens a second assistant message after the first one ends', async () => {
    const h = await runTwoStepTurn();
    const starts = assistantStarts(h.events);

    // The mutation this kills: dropping `closeAssistantMessage` leaves one
    // container for the whole run, so this is 1.
    expect(starts).toHaveLength(2);
    expect(payloadField(starts[0], 'messageId')).not.toBe(payloadField(starts[1], 'messageId'));
  });

  it('gives each prose chunk its own text block', async () => {
    const h = await runTwoStepTurn();
    const deltas = h.events.filter((event) => event.type === 'message.delta');
    const blockIds = deltas.map((event) => payloadField(event, 'blockId'));

    expect(deltas).toHaveLength(2);
    // Sharing one blockId is what concatenated "…the file.The file says X."
    expect(new Set(blockIds).size).toBe(2);
    expect(deltas.map((event) => payloadField(event, 'text'))).toEqual([
      'Let me read the file.',
      'The file says X.',
    ]);
  });

  it('leaves the tool in the container the preceding prose opened', async () => {
    const h = await runTwoStepTurn();
    const toolStart = h.events.find((event) => event.type === 'tool.started');
    const deltas = h.events.filter((event) => event.type === 'message.delta');

    // The tool stays with the prose BEFORE it and the follow-up prose opens a
    // new container. Both halves matter: the renderer appends blocks in arrival
    // order, so this is what puts the second paragraph after the tool row —
    // and keeping tools on the open container is what stops a sequential tool
    // run from fragmenting (see the multi-tool test below).
    expect(payloadField(toolStart, 'messageId')).toBe(payloadField(deltas[0], 'messageId'));
    expect(payloadField(toolStart, 'messageId')).not.toBe(payloadField(deltas[1], 'messageId'));
  });

  it('completes each assistant message exactly once', async () => {
    const h = await runTwoStepTurn();
    const completed = h.events.filter((event) => event.type === 'message.completed');
    const ids = completed.map((event) => payloadField(event, 'messageId'));

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(
      new Set(assistantStarts(h.events).map((event) => payloadField(event, 'messageId')))
    );
  });

  it('keeps a sequential tool run in one container', async () => {
    // `grep` -> `grep` -> `read`, each its own pi turn with no prose between
    // them. This is the case that ruled out resetting the container outright at
    // `message_end`: one message per tool means one tool GROUP per tool, and a
    // five-step search renders as five separate cards.
    const h = harness();
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    const send = h.runtime.send({ sessionId: 'a', text: 'go' });
    await vi.waitFor(() => expect(h.stub.sessionFor('/repo-a')).toBeDefined());
    const pi = h.stub.sessionFor('/repo-a');

    pi?.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Searching.' }] },
    } as { type: string });
    pi?.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'toolUse' },
    } as { type: string });

    for (const id of ['t1', 't2', 't3']) {
      pi?.emit({
        type: 'tool_execution_start',
        toolCallId: id,
        toolName: 'Grep',
        args: {},
      } as { type: string });
      pi?.emit({
        type: 'tool_execution_end',
        toolCallId: id,
        toolName: 'Grep',
        result: { content: 'hit' },
      } as { type: string });
      // pi opens and closes a message around each step of a sequential run.
      pi?.emit({ type: 'message_start', message: { role: 'assistant' } } as { type: string });
      pi?.emit({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse' },
      } as { type: string });
    }

    h.stub.finishPrompt('/repo-a');
    await send;

    const toolMessageIds = h.events
      .filter((event) => event.type === 'tool.started')
      .map((event) => payloadField(event, 'messageId'));
    expect(toolMessageIds).toHaveLength(3);
    expect(new Set(toolMessageIds).size).toBe(1);
    // The prose that opened the run owns them.
    expect(toolMessageIds[0]).toBe(
      payloadField(
        h.events.find((event) => event.type === 'message.delta'),
        'messageId'
      )
    );

    // Each of those tool-only pi turns ends with its own `message_end` aimed at
    // a container that was already completed at its own end. Re-emitting
    // `message.completed` there would stamp a fresh `completedAt` (and a fresh
    // "done streaming" verdict) on a message that has not changed since — four
    // completions for one message.
    const completions = h.events.filter((event) => event.type === 'message.completed');
    expect(completions).toHaveLength(1);
    expect(payloadField(completions[0], 'messageId')).toBe(toolMessageIds[0]);
  });

  it('closes a thought when the model starts answering', async () => {
    // T12-c. pi has no "thinking ended" event, so the Host has to say when.
    // Without this the renderer only ever sees `thinking.started`,
    // `reduceTurnTiming` leaves `durationMs` null, and EVERY thought on the pi
    // backend renders as a bare `Thought` with no duration.
    const h = harness();
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    const send = h.runtime.send({ sessionId: 'a', text: 'go' });
    await vi.waitFor(() => expect(h.stub.sessionFor('/repo-a')).toBeDefined());
    const pi = h.stub.sessionFor('/repo-a');

    pi?.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing it' }] },
    } as { type: string });
    pi?.emit({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weighing it' },
          { type: 'text', text: 'Here.' },
        ],
      },
    } as { type: string });
    pi?.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop' },
    } as { type: string });

    h.stub.finishPrompt('/repo-a');
    await send;

    const started = h.events.filter((event) => event.type === 'thinking.started');
    const completed = h.events.filter((event) => event.type === 'thinking.completed');
    expect(started).toHaveLength(1);
    // Exactly one: both the answering boundary and `message_end` can fire for
    // the same block, and a second one would overwrite `durationMs` with the
    // later timestamp — quietly inflating every thought followed by prose.
    expect(completed).toHaveLength(1);
    expect(payloadField(completed[0], 'blockId')).toBe(payloadField(started[0], 'blockId'));

    // …and it must land BEFORE the prose it ended for.
    const completedAt = h.events.indexOf(completed[0]);
    const firstDelta = h.events.findIndex(
      (event) => event.type === 'message.delta' && payloadField(event, 'text') === 'Here.'
    );
    expect(completedAt).toBeLessThan(firstDelta);
  });

  it('closes a thought that ended without any prose', async () => {
    // Thought, then straight to a tool call. `message_end` is the only
    // boundary left, and without it this block's duration never resolves.
    const h = harness();
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    const send = h.runtime.send({ sessionId: 'a', text: 'go' });
    await vi.waitFor(() => expect(h.stub.sessionFor('/repo-a')).toBeDefined());
    const pi = h.stub.sessionFor('/repo-a');

    pi?.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'need to look' }] },
    } as { type: string });
    pi?.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'toolUse' },
    } as { type: string });

    h.stub.finishPrompt('/repo-a');
    await send;

    expect(h.events.filter((event) => event.type === 'thinking.completed')).toHaveLength(1);
  });

  it('keeps ids distinct when two messages close in the same millisecond', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T00:00:00.000Z'));

    const h = harness();
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    const send = h.runtime.send({ sessionId: 'a', text: 'go' });
    await vi.waitFor(() => expect(h.stub.sessionFor('/repo-a')).toBeDefined());
    const pi = h.stub.sessionFor('/repo-a');

    for (const text of ['one', 'two', 'three']) {
      pi?.emit({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      } as { type: string });
      pi?.emit({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse' },
      } as { type: string });
    }

    h.stub.finishPrompt('/repo-a');
    await send;

    // `Date.now()` never moves here. Without the session-scoped counter all
    // three ids are byte-identical and the three messages collapse back into
    // one — the original defect, one layer down, invisible to a real clock.
    const ids = assistantStarts(h.events).map((event) => payloadField(event, 'messageId'));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});
