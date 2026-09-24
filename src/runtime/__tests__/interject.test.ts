/**
 * Ctrl+Enter interjection (`worker.interject` → `AgentLoopPlugin.interject()`).
 *
 * The signal is a "stop at the next turn boundary", not an abort: the current
 * iteration finishes its tools and streams its message, then the loop exits so
 * the renderer's queue can deliver the interjection as the next turn.
 *
 * The cases below pin the two halves separately: that the flag does stop the
 * loop at a boundary, and that it is scoped to the run that was live when it
 * arrived. The second half is the regression this file exists for — a flag
 * owned by the plugin rather than by the run would be consumed by the NEXT
 * run's first boundary check, stopping a turn the user never asked to stop.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context as PiContext } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { RUN_STOP_CUSTOM_TYPE } from '../../shared/types/sessionHistory.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import type { RuntimeRunResult } from '../contracts.ts';
import { neverAsked } from './fixtures/approval.ts';

/** A turn that calls `read`, which is what makes the loop ask again. */
const readCall = (id: string) =>
  fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' }, { id })], {
    stopReason: 'toolUse',
  });

describe('Ctrl+Enter interjection', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'runtime-interject-'));
    await writeFile(join(workspace, 'notes.txt'), 'notes\n', 'utf8');
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  async function boot(replies: ReturnType<typeof fauxAssistantMessage>[]): Promise<RuntimeHandle> {
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'faux-interject', name: 'Interject probe' }],
    });
    faux.setResponses(replies);
    runtime = await createRuntime({
      providers: [faux.provider],
      env: {},
      tools: { cwd: workspace },
      permissions: { approve: neverAsked, projectTrusted: true },
      // No ceiling: these cases are about the interjection ending the loop, so
      // nothing else may be allowed to end it first.
      loop: { turnCeiling: 64, singleTurn: false },
    });
    return runtime;
  }

  it('reports false when no run is live, and does not arm the next one', async () => {
    const handle = await boot([
      readCall('t1'),
      fauxAssistantMessage('first run, turn two'),
      fauxAssistantMessage('second run'),
    ]);

    // Nothing has run yet: there is no live run to interject into.
    expect(handle.loop.interject()).toBe(false);

    // The run that follows must not inherit a signal aimed at a run that did
    // not exist. A plugin-level flag would have been consumed right here, on
    // this run's first boundary check, ending it a turn early.
    const result = await handle.run({ prompt: 'go', systemPrompt: 'probe' });
    expect(result.success).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.text).toContain('first run, turn two');
  });

  it('reports false once the run has ended, and does not arm the next one', async () => {
    const handle = await boot([
      fauxAssistantMessage('done in one'),
      readCall('t2'),
      fauxAssistantMessage('the run after the interjection'),
    ]);

    const first = await handle.run({ prompt: 'go', systemPrompt: 'probe' });
    expect(first.turns).toBe(1);

    // The run is over. The signal cannot reach it, so the answer is false —
    // the composer relies on this to tell the user the stop is NOT coming.
    expect(handle.loop.interject()).toBe(false);

    const second = await handle.run({ prompt: 'go again', systemPrompt: 'probe' });
    expect(second.turns).toBe(2);
    expect(second.text).toContain('the run after the interjection');
  });

  it('stops the live run at its next turn boundary', async () => {
    const handle = await boot([
      readCall('t1'),
      // The turn the interjection prevents. `faux` hands out one scripted
      // response per request, so an unconsumed entry here is the proof that the
      // loop never went back to the model.
      fauxAssistantMessage('the turn the interjection prevented'),
      fauxAssistantMessage('the run after'),
    ]);

    // Arm the signal while the first turn's tool call is in flight, so this is
    // the boundary check that consumes it rather than a later one.
    let armed = false;
    const run = handle.run({
      prompt: 'go',
      systemPrompt: 'probe',
      onEvent: () => {
        if (armed) return;
        armed = true;
        handle.loop.interject();
      },
    });

    const result = await run;
    // One turn, and the run ends on the tool boundary it stopped at: the loop
    // did not ask the model again, so the second scripted response was never
    // spent. That is the difference between this and a Stop (which aborts the
    // turn in flight).
    expect(result.turns).toBe(1);
    expect(result.stopReason).toBe('toolUse');

    // The signal was consumed by that boundary check, so the run that follows
    // is untouched: it takes the response the stopped run left in the queue —
    // a second interjection would be needed to stop this one.
    const next = await handle.run({ prompt: 'go again', systemPrompt: 'probe' });
    expect(next.success).toBe(true);
    expect(next.text).toBe('the turn the interjection prevented');
  });

  it('reaches a run that has been admitted but has not reached its loop yet', async () => {
    const handle = await boot([
      readCall('t1'),
      fauxAssistantMessage('the turn the early interjection prevented'),
    ]);

    // Synchronously after `run()` returns its promise: the worker has already
    // marked its turn active, but the loop is still awaiting its session flush
    // and prompt assembly. The box used to be created after those awaits, so
    // this answered `false` ("no running turn") and the run went on to spend
    // every turn it wanted.
    const run = handle.run({ prompt: 'go', systemPrompt: 'probe' });
    expect(handle.loop.interject()).toBe(true);

    const result = await run;
    expect(result.turns).toBe(1);
    expect(result.stopCause).toBe('interjected');
  });

  it('records the stop on the trace', async () => {
    const handle = await boot([fauxAssistantMessage('one turn'), fauxAssistantMessage('unused')]);

    const run = handle.run({
      prompt: 'go',
      systemPrompt: 'probe',
      onEvent: () => {
        handle.loop.interject();
      },
    });
    const result = await run;

    const notes = result.trace.steps.filter((step) => step.type === 'note');
    expect(notes.some((step) => step.detail?.event === 'turn_stopped_by_interjection')).toBe(true);
  });

  it('is harmless when the loop is single-turn and already stopping', async () => {
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'faux-interject', name: 'Interject probe' }],
    });
    faux.setResponses([fauxAssistantMessage('single turn')]);
    runtime = await createRuntime({
      providers: [faux.provider],
      env: {},
      permissions: { approve: neverAsked, projectTrusted: true },
      loop: { singleTurn: true },
    });

    const run = runtime.run({
      prompt: 'go',
      systemPrompt: 'probe',
      onEvent: () => {
        // Arming a loop that is stopping anyway must not throw or corrupt the
        // run's own stop accounting.
        runtime?.loop.interject();
      },
    });
    const result = await run;
    expect(result.success).toBe(true);
    expect(result.turns).toBe(1);
    expect(result.text).toBe('single turn');
  });
});

/**
 * A provider that answers the parent and the delegates from separate scripts,
 * routed by system prompt the same way `subagentDelegation.test.ts` does.
 */
type ScriptStep = (context: PiContext) => AssistantMessage | Promise<AssistantMessage>;

function scriptedProvider(script: { parent: ScriptStep[]; delegate: ScriptStep[] }) {
  const handle = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-interject-sa', name: 'Interject + delegates' }],
  });
  let parentIndex = 0;
  let delegateIndex = 0;
  const route = async (context: PiContext) => {
    const isDelegate = /You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? '');
    const steps = isDelegate ? script.delegate : script.parent;
    const index = isDelegate ? delegateIndex++ : parentIndex++;
    const step = steps[Math.min(index, steps.length - 1)];
    if (!step) throw new Error(`no scripted ${isDelegate ? 'delegate' : 'parent'} response`);
    return step(context);
  };
  handle.setResponses(Array.from({ length: 64 }, () => route));
  return handle;
}

function contextText(context: PiContext): string {
  return JSON.stringify(context.messages);
}

const TIMED_OUT = Symbol('timed out');
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms)),
  ]);
}

describe('Ctrl+Enter interjection with background delegates', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;
  let releaseDelegate: () => void = () => {};

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'runtime-interject-sa-'));
  });

  afterEach(async () => {
    // A delegate parked on its gate would hold dispose's drain for its full
    // deadline; let it finish first.
    releaseDelegate();
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  /**
   * Parent: turn 1 delegates, turn 2 goes idle, turns 3+ belong to the next
   * run. The delegate's only reply waits on `releaseDelegate()`, standing in
   * for a ten-minute background job.
   */
  async function build(
    parentLater: ScriptStep[],
    onParentIdle: () => void = () => {},
    secondTurn?: ScriptStep
  ) {
    const gate = new Promise<void>((resolve) => {
      releaseDelegate = resolve;
    });
    const provider = scriptedProvider({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'long job' })], {
            stopReason: 'toolUse',
          }),
        secondTurn ??
          (() => {
            onParentIdle();
            return fauxAssistantMessage('Started the explorer; nothing else to do.');
          }),
        ...parentLater,
      ],
      delegate: [
        async () => {
          await gate;
          return fauxAssistantMessage('EXPLORER-REPORT: found it late');
        },
      ],
    });
    runtime = await createRuntime({
      env: {},
      providers: [provider.provider],
      tools: { cwd: workspace },
      permissions: { approve: neverAsked, gear: 'auto' },
      subagents: { home: join(workspace, 'home') },
      session: { cwd: workspace, mode: 'create', file: join(workspace, 'session.jsonl') },
      loop: { singleTurn: false },
    });
    return runtime;
  }

  it('ends the run at once when interjected while it waits on a delegate, and leaves the delegate running', async () => {
    const nextRunContexts: PiContext[] = [];
    const handle = await build([
      (context) => {
        nextRunContexts.push(context);
        return fauxAssistantMessage('Answered the interjection.');
      },
      (context) => {
        nextRunContexts.push(context);
        return fauxAssistantMessage('Integrated the late report.');
      },
    ]);
    const events: RuntimeEventDraft[] = [];
    handle.events.subscribe((event) => events.push(event));

    let parentIdle = false;
    const first = handle.run({
      prompt: 'find the thing',
      onEvent: (event: AgentEvent) => {
        if (event.type === 'agent_end') parentIdle = true;
      },
    });
    // The parent's own loop is over; give the runtime a moment to enter its
    // wait on the delegate, which is the wait the interjection has to cut.
    await vi.waitFor(() => expect(parentIdle).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handle.ctx.runtimeSubagents.registry.running()).toHaveLength(1);

    expect(handle.loop.interject()).toBe(true);
    // Before the fix this run stayed parked in `collectFinished` until the
    // delegate finished — here, never, because nothing releases it.
    const result = await within(first, 3_000);
    expect(result).not.toBe(TIMED_OUT);
    const ended = result as RuntimeRunResult;
    expect(ended.success).toBe(true);
    expect(ended.turns).toBe(2);
    expect(ended.stopCause).toBe('interjected');
    // Not drained: the delegate belongs to the session and is still working.
    expect(handle.ctx.runtimeSubagents.registry.running()).toHaveLength(1);
    expect(events.find((event) => event.type === 'session.completed')?.payload).toMatchObject({
      stopCause: 'interjected',
    });

    // The delegate finishes while no run is live. Its report waits in the
    // registry, and its spend is not counted from the file as well as live.
    releaseDelegate();
    await vi.waitFor(() => expect(handle.ctx.runtimeSubagents.registry.running()).toHaveLength(0));
    await handle.session?.flush();
    expect(handle.ctx.runtimeSubagents.registry.undelivered()).toHaveLength(1);
    expect(handle.ctx.runtimeSubagents.historyUsage().delegations).toBe(0);

    // The next run (the interjection itself) hands the report to the model
    // after answering the user.
    const second = await handle.run({ prompt: 'INTERJECTED-MESSAGE' });
    expect(second.success).toBe(true);
    expect(second.turns).toBe(2);
    expect(second.text).toContain('Integrated the late report.');
    expect(contextText(nextRunContexts[0] as PiContext)).toContain('INTERJECTED-MESSAGE');
    expect(contextText(nextRunContexts[1] as PiContext)).toContain(
      'EXPLORER-REPORT: found it late'
    );
    expect(handle.ctx.runtimeSubagents.registry.undelivered()).toHaveLength(0);
    // Billed once, to the run that delivered it.
    expect(second.subagentUsage).toBeDefined();
    expect(handle.ctx.runtimeSubagents.historyUsage().delegations).toBe(1);
  });

  it('skips the delegate wait entirely when the interjection lands during the parent turn', async () => {
    let handle: RuntimeHandle | undefined;
    handle = await build(
      [
        () => fauxAssistantMessage('Answered the interjection.'),
        () => fauxAssistantMessage('Integrated the late report.'),
      ],
      () => {
        // Asked for the idle turn: the interjection arrives mid-turn, so the
        // boundary check stops the loop and the delegate wait never starts.
        handle?.loop.interject();
      }
    );

    const result = await within(handle.run({ prompt: 'find the thing' }), 3_000);
    expect(result).not.toBe(TIMED_OUT);
    expect((result as RuntimeRunResult).stopCause).toBe('interjected');
    expect(handle.ctx.runtimeSubagents.registry.running()).toHaveLength(1);
  });

  it('waits for a delegate that is still running when the next run starts, as before', async () => {
    const handle = await build([
      () => {
        // The next run's own turn: the delegate is still going, and finishes
        // while this run is live. Its collection pass must wait for it.
        releaseDelegate();
        return fauxAssistantMessage('Answered the interjection.');
      },
      (context) => {
        expect(contextText(context)).toContain('EXPLORER-REPORT: found it late');
        return fauxAssistantMessage('Integrated the late report.');
      },
    ]);

    let parentIdle = false;
    const first = handle.run({
      prompt: 'find the thing',
      onEvent: (event: AgentEvent) => {
        if (event.type === 'agent_end') parentIdle = true;
      },
    });
    await vi.waitFor(() => expect(parentIdle).toBe(true));
    handle.loop.interject();
    await first;
    expect(handle.ctx.runtimeSubagents.registry.running()).toHaveLength(1);

    const second = await handle.run({ prompt: 'INTERJECTED-MESSAGE' });
    expect(second.turns).toBe(2);
    expect(second.text).toContain('Integrated the late report.');
    expect(handle.ctx.runtimeSubagents.registry.all()[0]?.status).toBe('completed');
  });

  it('ends a TaskWait in flight when interjected, and still leaves the delegate running', async () => {
    const handle = await build([() => fauxAssistantMessage('unused')], undefined, () =>
      fauxAssistantMessage([fauxToolCall('TaskWait', { timeoutSeconds: 600 }, { id: 'wait-1' })], {
        stopReason: 'toolUse',
      })
    );
    const toolResults: string[] = [];
    const run = handle.run({
      prompt: 'find the thing',
      onEvent: (event: AgentEvent) => {
        if (event.type === 'tool_execution_start' && event.toolName === 'TaskWait')
          handle.loop.interject();
        if (event.type === 'tool_execution_end' && event.toolName === 'TaskWait')
          toolResults.push(JSON.stringify(event.result));
      },
    });

    // Before the fix the wait sat out its own 600-second timeout.
    const result = await within(run, 3_000);
    expect(result).not.toBe(TIMED_OUT);
    expect((result as RuntimeRunResult).stopCause).toBe('interjected');
    expect((result as RuntimeRunResult).turns).toBe(2);
    expect(toolResults[0]).toContain('Stopped waiting early because the user sent a new message');
    expect(handle.ctx.runtimeSubagents.registry.running()).toHaveLength(1);
    // Heartbeat only: the report is still undelivered, for the next run.
    releaseDelegate();
    await vi.waitFor(() =>
      expect(handle.ctx.runtimeSubagents.registry.undelivered()).toHaveLength(1)
    );
  });

  it('still stops every delegate on a user Stop', async () => {
    const controller = new AbortController();
    const handle = await build([], () => {
      controller.abort();
      // The scripted delegate ignores abort signals, so it is released a
      // moment later; without the drain the run would already have returned.
      setTimeout(() => releaseDelegate(), 150);
    });
    const result = await handle.run({ prompt: 'go', signal: controller.signal });
    expect(result.stopReason).toBe('aborted');
    expect(result.stopCause).toBeUndefined();
    expect(handle.ctx.runtimeSubagents.registry.running()).toHaveLength(0);
  });
});

describe('the run-stop record', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'runtime-run-stop-'));
    await writeFile(join(workspace, 'notes.txt'), 'notes\n', 'utf8');
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  async function boot(replies: ReturnType<typeof fauxAssistantMessage>[]) {
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'faux-run-stop', name: 'Run stop probe' }],
    });
    faux.setResponses(replies);
    runtime = await createRuntime({
      providers: [faux.provider],
      env: {},
      tools: { cwd: workspace },
      permissions: { approve: neverAsked, gear: 'auto' },
      session: { cwd: workspace, mode: 'create', file: join(workspace, 'session.jsonl') },
      loop: { turnCeiling: 64, singleTurn: false },
    });
    return runtime;
  }

  async function runStopRows(): Promise<Record<string, unknown>[]> {
    await runtime?.session?.flush();
    const raw = await readFile(join(workspace, 'session.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.customType === RUN_STOP_CUSTOM_TYPE);
  }

  it('writes an interjected run down as a pi custom entry, replays it, and keeps it off the tree', async () => {
    const handle = await boot([readCall('t1'), fauxAssistantMessage('unused')]);
    const events: RuntimeEventDraft[] = [];
    handle.events.subscribe((event) => events.push(event));

    const run = handle.run({ prompt: 'go' });
    handle.loop.interject();
    const result = await run;
    expect(result.stopCause).toBe('interjected');

    const rows = await runStopRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'custom',
      customType: RUN_STOP_CUSTOM_TYPE,
      data: { cause: 'interjected', runId: result.runId },
    });

    // Replay: the cause lands on the run's last assistant message.
    const history = handle.session?.history() ?? [];
    const assistants = history.filter((message) => message.role === 'assistant');
    expect(assistants.at(-1)?.stopCause).toBe('interjected');
    // Bookkeeping, not conversation: no `custom.entry` system row live...
    expect(events.some((event) => event.type === 'custom.entry')).toBe(false);
    // ...and no node in the session tree / fork picker. The record is the
    // session's leaf, so the leaf mark moves to the message it hangs off.
    const tree = handle.session?.tree();
    const nodeIds = tree?.nodes.map((node) => node.id) ?? [];
    expect(nodeIds).not.toContain(rows[0]?.id);
    expect(tree?.leaf.activeEntryId).toBe(rows[0]?.id);
    expect(tree?.nodes.find((node) => node.leaf)?.id).toBe(rows[0]?.parentId);
  });

  it('writes a stopped run down as user_stop', async () => {
    const handle = await boot([readCall('t1'), fauxAssistantMessage('unused')]);
    const controller = new AbortController();
    const result = await handle.run({
      prompt: 'go',
      signal: controller.signal,
      onEvent: (event: AgentEvent) => {
        if (event.type === 'tool_execution_start') controller.abort();
      },
    });
    expect(result.stopReason).toBe('aborted');

    const rows = await runStopRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data: { cause: 'user_stop', runId: result.runId } });
  });

  it('writes nothing for a run that ended on its own', async () => {
    const handle = await boot([fauxAssistantMessage('done')]);
    const result = await handle.run({ prompt: 'go' });
    expect(result.stopCause).toBeUndefined();
    expect(await runStopRows()).toHaveLength(0);
    const assistants = (handle.session?.history() ?? []).filter(
      (message) => message.role === 'assistant'
    );
    expect(assistants.at(-1)?.stopCause).toBeUndefined();
  });
});
