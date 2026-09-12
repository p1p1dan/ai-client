/**
 * P5-2-0: the host-capability probe that gates the whole subagent replica.
 *
 * The reference subsystem (PI-Desktop `948ee676`) runs a second `Agent` inside
 * the session process and leans on four pi behaviours that the research pass
 * could only confirm BY NAME in our pinned 0.84.4:
 *
 * 1. two Agents in one process keep their event streams apart (a delegate's
 *    `agent_end` must never end the parent's run),
 * 2. `afterToolCall` can mark a result as an error and can terminate the loop
 *    (this is how a delegate's `maxTurns` cap is enforced),
 * 3. a batch fans out only when every tool in it is `executionMode: "parallel"`
 *    (this is how `Task` is the only parallel parent tool), and
 * 4. `abort()` reaches a running tool's signal, and the transcript can be
 *    rewound and resumed with `continue()` (the provider-retry path).
 *
 * D12 keeps us on 0.84.4. These cases are the record that we checked the
 * behaviour rather than the export list, and they stay in the suite as the
 * regression that would catch a future pi bump changing any of it.
 */

import { setTimeout as delay } from 'node:timers/promises';
import {
  Agent,
  type AgentEvent,
  type AgentTool,
  convertToLlm,
} from '@earendil-works/pi-agent-core';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';

type Faux = ReturnType<typeof fauxProvider>;

function faux(): Faux {
  return fauxProvider({ provider: 'faux', models: [{ id: 'faux-p52', name: 'P5-2 probe' }] });
}

/** Minimal Agent wired to a faux provider, with whatever hooks a case needs. */
function agentOver(
  handle: Faux,
  options: Partial<ConstructorParameters<typeof Agent>[0]> = {}
): Agent {
  const model = handle.getModel();
  return new Agent({
    streamFn: (requestModel, context, streamOptions) =>
      handle.provider.streamSimple(requestModel, context, streamOptions),
    convertToLlm,
    ...options,
    initialState: {
      systemPrompt: 'probe',
      model,
      messages: [],
      ...options.initialState,
    },
  });
}

/** A tool that records when it starts and ends, so overlap is observable. */
function spanTool(
  name: string,
  spans: { name: string; start: number; end: number }[],
  options: { ms?: number; executionMode?: 'parallel' | 'sequential' } = {}
): AgentTool {
  return {
    name,
    label: name,
    description: `probe tool ${name}`,
    parameters: Type.Object({}),
    ...(options.executionMode ? { executionMode: options.executionMode } : {}),
    execute: async () => {
      const start = Date.now();
      await delay(options.ms ?? 30);
      spans.push({ name, start, end: Date.now() });
      return { content: [{ type: 'text' as const, text: `${name} done` }], details: {} };
    },
  } as AgentTool;
}

/** True when any two spans were in flight at the same moment. */
function overlapped(spans: { start: number; end: number }[]): boolean {
  return spans.some((left, index) =>
    spans.some((right, other) => other > index && left.start < right.end && right.start < left.end)
  );
}

describe('P5-2-0 · pi 0.84.4 host capability probe', () => {
  it('keeps two Agents in one process on separate event streams', async () => {
    // The delegate is a second Agent, not a second process. If its lifecycle
    // events reached the parent's subscriber, every finished delegate would
    // end the parent turn - the exact failure D328 exists to prevent.
    const parentFaux = faux();
    const childFaux = faux();
    parentFaux.setResponses([fauxAssistantMessage('parent reply')]);
    childFaux.setResponses([fauxAssistantMessage('child report')]);

    const parent = agentOver(parentFaux);
    const child = agentOver(childFaux);
    const parentEvents: AgentEvent['type'][] = [];
    const childEvents: AgentEvent['type'][] = [];
    parent.subscribe((event) => {
      parentEvents.push(event.type);
    });
    child.subscribe((event) => {
      childEvents.push(event.type);
    });

    await child.prompt('do the delegated work');
    await child.waitForIdle();

    expect(childEvents).toContain('agent_end');
    // The parent has not run at all yet, so anything here is leakage.
    expect(parentEvents).toEqual([]);

    await parent.prompt('carry on');
    await parent.waitForIdle();
    expect(parent.state.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    // Separate transcripts: the child's report is not in the parent's context.
    expect(JSON.stringify(parent.state.messages)).not.toContain('child report');
  });

  it('emits the full child event sequence the transcript needs', async () => {
    // What the delegate's `handleEvent` translates into transcript rows. A
    // missing `turn_start` would silently zero the heartbeat's turn counter.
    const handle = faux();
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('probe', {}, { id: 'call_1' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('report'),
    ]);
    const spans: { name: string; start: number; end: number }[] = [];
    const agent = agentOver(handle, {
      initialState: { tools: [spanTool('probe', spans)] },
    });
    const seen: AgentEvent['type'][] = [];
    agent.subscribe((event) => {
      seen.push(event.type);
    });

    await agent.prompt('go');
    await agent.waitForIdle();

    for (const type of [
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'tool_execution_start',
      'tool_execution_end',
      'agent_end',
    ]) {
      expect(seen).toContain(type);
    }
    // Two provider requests means two turns; the heartbeat counts these.
    expect(seen.filter((type) => type === 'turn_start')).toHaveLength(2);
  });

  it('lets afterToolCall mark a result as an error', async () => {
    // How a host failure inside a delegate reaches its tool-error channel:
    // the parent's own bookkeeping decides, and pi applies the override.
    const handle = faux();
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('probe', {}, { id: 'call_1' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('done'),
    ]);
    const spans: { name: string; start: number; end: number }[] = [];
    const agent = agentOver(handle, {
      initialState: { tools: [spanTool('probe', spans)] },
      afterToolCall: async () => ({ isError: true }),
    });

    await agent.prompt('go');
    await agent.waitForIdle();

    const toolResult = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(toolResult).toBeDefined();
    expect((toolResult as { isError?: boolean }).isError).toBe(true);
  });

  it('lets afterToolCall terminate the loop after the current batch', async () => {
    // The delegate's maxTurns cap is exactly this: once the cap is hit, the
    // next tool result terminates instead of starting another turn.
    const handle = faux();
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('probe', {}, { id: 'call_1' })], {
        stopReason: 'toolUse',
      }),
      // Scripted but must never be requested: termination happens first.
      fauxAssistantMessage('should not be reached'),
    ]);
    const spans: { name: string; start: number; end: number }[] = [];
    const agent = agentOver(handle, {
      initialState: { tools: [spanTool('probe', spans)] },
      afterToolCall: async () => ({ terminate: true }),
    });

    await agent.prompt('go');
    await agent.waitForIdle();

    expect(handle.state.callCount).toBe(1);
    expect(handle.getPendingResponseCount()).toBe(1);
  });

  it('only terminates when EVERY call in the batch asks for it', async () => {
    // Documented 0.84.4 merge semantics, and the reason the cap is evaluated
    // per call rather than once per batch: a cap that fired for one call of a
    // two-call batch would not stop the loop at all.
    const handle = faux();
    handle.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('alpha', {}, { id: 'call_1' }), fauxToolCall('beta', {}, { id: 'call_2' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('continued anyway'),
    ]);
    const spans: { name: string; start: number; end: number }[] = [];
    const agent = agentOver(handle, {
      initialState: {
        tools: [
          spanTool('alpha', spans, { executionMode: 'parallel' }),
          spanTool('beta', spans, { executionMode: 'parallel' }),
        ],
      },
      afterToolCall: async (context) => {
        const name = (context.toolCall as { name?: string }).name;
        return name === 'alpha' ? { terminate: true } : undefined;
      },
    });

    await agent.prompt('go');
    await agent.waitForIdle();

    expect(handle.state.callCount).toBe(2);
  });

  it('fans a batch out only when every tool in it is parallel', async () => {
    // This is what makes `Task` the one parallel parent tool: an all-Task
    // batch overlaps, and any other tool in the batch serializes it.
    const handle = faux();
    handle.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('alpha', {}, { id: 'call_1' }), fauxToolCall('beta', {}, { id: 'call_2' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('done'),
    ]);
    const spans: { name: string; start: number; end: number }[] = [];
    const agent = agentOver(handle, {
      initialState: {
        tools: [
          spanTool('alpha', spans, { executionMode: 'parallel' }),
          spanTool('beta', spans, { executionMode: 'parallel' }),
        ],
      },
    });

    await agent.prompt('go');
    await agent.waitForIdle();

    expect(spans).toHaveLength(2);
    expect(overlapped(spans)).toBe(true);
  });

  it('serializes a batch that mixes a parallel tool with a sequential one', async () => {
    const handle = faux();
    handle.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('alpha', {}, { id: 'call_1' }), fauxToolCall('gamma', {}, { id: 'call_2' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('done'),
    ]);
    const spans: { name: string; start: number; end: number }[] = [];
    const agent = agentOver(handle, {
      initialState: {
        tools: [
          spanTool('alpha', spans, { executionMode: 'parallel' }),
          spanTool('gamma', spans, { executionMode: 'sequential' }),
        ],
      },
    });

    await agent.prompt('go');
    await agent.waitForIdle();

    expect(spans).toHaveLength(2);
    expect(overlapped(spans)).toBe(false);
  });

  it("honours the agent-level sequential setting over a tool's parallel mode", async () => {
    // The delegate is constructed with `toolExecution: "sequential"`: it is a
    // worker, not a fan-out point, whatever its tools declare.
    const handle = faux();
    handle.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('alpha', {}, { id: 'call_1' }), fauxToolCall('beta', {}, { id: 'call_2' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('done'),
    ]);
    const spans: { name: string; start: number; end: number }[] = [];
    const agent = agentOver(handle, {
      toolExecution: 'sequential',
      initialState: {
        tools: [
          spanTool('alpha', spans, { executionMode: 'parallel' }),
          spanTool('beta', spans, { executionMode: 'parallel' }),
        ],
      },
    });

    await agent.prompt('go');
    await agent.waitForIdle();

    expect(spans).toHaveLength(2);
    expect(overlapped(spans)).toBe(false);
  });

  it('reaches a running tool through abort(), then closes on one more aborted turn', async () => {
    // TaskStop and user Stop both end up here. A delegate whose abort did not
    // reach the tool would report stopped while its command kept running.
    //
    // Measured 0.84.4 behaviour, and the reason TaskStop must await real
    // settlement rather than reporting "stopped" the moment it calls abort():
    // aborting an in-flight tool does NOT end the loop there. pi records the
    // tool result, starts one more provider request, and that request comes
    // back with `stopReason: "aborted"`. So a stop costs one extra request,
    // and the delegate is only genuinely finished after `waitForIdle()`.
    // Identical whether the tool returns normally on abort or throws.
    const handle = faux();
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('slow', {}, { id: 'call_1' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('the extra aborted turn'),
    ]);
    let toolSawAbort = false;
    let started = false;
    const slow: AgentTool = {
      name: 'slow',
      label: 'slow',
      description: 'probe tool that waits to be aborted',
      parameters: Type.Object({}),
      execute: async (_id, _params, signal) => {
        started = true;
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              toolSawAbort = true;
              resolve();
            },
            { once: true }
          );
        });
        return { content: [{ type: 'text' as const, text: 'aborted' }], details: {} };
      },
    } as AgentTool;
    const agent = agentOver(handle, { initialState: { tools: [slow] } });
    const stopReasons: unknown[] = [];
    agent.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant')
        stopReasons.push((event.message as { stopReason?: unknown }).stopReason);
    });

    const run = agent.prompt('go');
    while (!started) await delay(5);
    agent.abort();
    await run;
    await agent.waitForIdle();

    expect(toolSawAbort).toBe(true);
    // One extra request, and it is the aborted one that ends the loop.
    expect(handle.state.callCount).toBe(2);
    expect(stopReasons).toEqual(['toolUse', 'aborted']);
  });

  it('can rewind the transcript and resume with continue()', async () => {
    // The provider-retry path: drop the failed assistant message and re-ask,
    // rather than restarting the delegate and replaying its executed tools.
    const handle = faux();
    handle.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 from gateway' }),
    ]);
    const agent = agentOver(handle);

    await agent.prompt('go');
    await agent.waitForIdle();
    expect(agent.state.messages.at(-1)?.role).toBe('assistant');

    const rewound = [...agent.state.messages];
    rewound.pop();
    agent.state.messages = rewound;
    expect(agent.state.messages.at(-1)?.role).toBe('user');

    handle.setResponses([fauxAssistantMessage('recovered')]);
    await agent.continue();
    await agent.waitForIdle();

    const last = agent.state.messages.at(-1) as { role: string; content: unknown };
    expect(last.role).toBe('assistant');
    expect(JSON.stringify(last.content)).toContain('recovered');
    // One user message, not two: the retry re-asked, it did not re-prompt.
    expect(agent.state.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });
});
