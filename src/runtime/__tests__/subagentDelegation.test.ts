/**
 * P5-2-2 gate — SA03 to SA09: the delegation lifecycle.
 *
 * Two layers, deliberately:
 *
 * - The **registry** half drives `DelegationRegistry` and `waitForDelegations`
 *   directly. The concurrency gate, the pruning rule and the wait predicate
 *   fail as RACES, and a race you can only reach through a live model is a race
 *   you cannot regress. This is also how the contract asks for the 10-slot
 *   check to be run on a low-resource machine: a gate, not ten real delegates.
 * - The **wired** half builds a real runtime with a faux provider that answers
 *   the parent and the delegate differently, because the two properties that
 *   only exist end to end are that `Task` returns BEFORE its delegate finishes,
 *   and that the run does not end while a delegate is still working.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, Context as PiContext } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import {
  SUBAGENT_LIST_TOOL_NAME,
  SUBAGENT_STOP_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  SUBAGENT_WAIT_TOOL_NAME,
} from '../plugins/subagent/index.ts';
import {
  DelegationRegistry,
  MAX_RETAINED_DELEGATIONS,
  MAX_SUBAGENT_CONCURRENCY,
  waitForDelegations,
} from '../plugins/subagent/registry.ts';
import type { SubagentRunResult } from '../plugins/subagent/run.ts';

function settledResult(overrides: Partial<SubagentRunResult> = {}): SubagentRunResult {
  return {
    agentName: 'explorer',
    status: 'completed',
    report: 'done',
    turns: 1,
    toolCalls: 0,
    ...overrides,
  };
}

describe('SA04 · admission, slots and retention', () => {
  it('admits ten and refuses the eleventh by name', () => {
    const registry = new DelegationRegistry();
    for (let index = 0; index < MAX_SUBAGENT_CONCURRENCY; index += 1) {
      const admitted = registry.admit({
        delegationId: `d${index}`,
        agentName: 'explorer',
        abort: () => {},
      });
      expect(admitted.ok).toBe(true);
    }
    const refused = registry.admit({
      delegationId: 'overflow',
      agentName: 'explorer',
      abort: () => {},
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain(String(MAX_SUBAGENT_CONCURRENCY));
    // A refusal registers nothing: the slot it did not get is not held.
    expect(registry.has('overflow')).toBe(false);
    expect(registry.running()).toHaveLength(MAX_SUBAGENT_CONCURRENCY);
  });

  it('frees a slot when one settles', () => {
    const registry = new DelegationRegistry();
    for (let index = 0; index < MAX_SUBAGENT_CONCURRENCY; index += 1)
      registry.admit({ delegationId: `d${index}`, agentName: 'explorer', abort: () => {} });
    expect(registry.admit({ delegationId: 'x', agentName: 'a', abort: () => {} }).ok).toBe(false);
    registry.settle('d0', settledResult());
    expect(registry.admit({ delegationId: 'x', agentName: 'a', abort: () => {} }).ok).toBe(true);
  });

  it('evicts only settled records, oldest first, and never a running one', () => {
    const registry = new DelegationRegistry();
    registry.admit({ delegationId: 'live', agentName: 'explorer', abort: () => {} });
    for (let index = 0; index < MAX_RETAINED_DELEGATIONS + 5; index += 1) {
      registry.admit({ delegationId: `d${index}`, agentName: 'explorer', abort: () => {} });
      registry.settle(`d${index}`, settledResult(), 1_000 + index);
    }
    expect(registry.has('live')).toBe(true);
    expect(registry.running()).toHaveLength(1);
    // Oldest settled went first; the newest survived.
    expect(registry.has('d0')).toBe(false);
    expect(registry.has(`d${MAX_RETAINED_DELEGATIONS + 4}`)).toBe(true);
    expect(registry.all().filter((record) => record.status !== 'running')).toHaveLength(
      MAX_RETAINED_DELEGATIONS
    );
  });

  it('settles exactly once, so a stop racing a completion cannot double-settle', () => {
    const registry = new DelegationRegistry();
    registry.admit({ delegationId: 'd', agentName: 'explorer', abort: () => {} });
    expect(registry.settle('d', settledResult({ report: 'first' }))).toBe(true);
    expect(registry.settle('d', settledResult({ report: 'second', status: 'aborted' }))).toBe(
      false
    );
    expect(registry.get('d')?.result?.report).toBe('first');
    expect(registry.get('d')?.status).toBe('completed');
  });

  it('reads an aborted run as stopped when TaskStop asked for it', () => {
    const registry = new DelegationRegistry();
    const admitted = registry.admit({ delegationId: 'd', agentName: 'explorer', abort: () => {} });
    if (!admitted.ok) throw new Error('not admitted');
    registry.requestStop(admitted.record);
    registry.settle('d', settledResult({ status: 'aborted' }));
    // "You stopped this" and "this broke" are different things to a reader.
    expect(registry.get('d')?.status).toBe('stopped');
  });

  it('keeps the settled counters, not the live ones, after settlement', () => {
    const registry = new DelegationRegistry();
    registry.admit({ delegationId: 'd', agentName: 'explorer', abort: () => {} });
    registry.noteActivity('d', { type: 'turn_start' });
    registry.settle('d', settledResult({ turns: 7, toolCalls: 4 }));
    const summary = registry.all()[0];
    expect(summary.result?.turns).toBe(7);
    // A heartbeat read after settlement must not report the smaller live count.
    expect(summary.turns).toBe(1);
  });
});

describe('SA05 · waiting for delegations', () => {
  function twoRunning() {
    const registry = new DelegationRegistry();
    const a = registry.admit({ delegationId: 'a', agentName: 'explorer', abort: () => {} });
    const b = registry.admit({ delegationId: 'b', agentName: 'fixer', abort: () => {} });
    if (!a.ok || !b.ok) throw new Error('not admitted');
    return { registry, records: [a.record, b.record] };
  }

  it('resolves for mode=all only when every target settled', async () => {
    const { registry, records } = twoRunning();
    let done = false;
    const wait = waitForDelegations(records, 2, null).then((timedOut) => {
      done = true;
      return timedOut;
    });
    registry.settle('a', settledResult());
    await Promise.resolve();
    expect(done).toBe(false);
    registry.settle('b', settledResult());
    expect(await wait).toBe(false);
  });

  it('resolves for mode=any as soon as minCompleted settled', async () => {
    const { registry, records } = twoRunning();
    const wait = waitForDelegations(records, 1, null);
    registry.settle('b', settledResult());
    expect(await wait).toBe(false);
    expect(registry.running()).toHaveLength(1);
  });

  it('returns immediately when the targets already settled', async () => {
    const { registry, records } = twoRunning();
    registry.settle('a', settledResult());
    registry.settle('b', settledResult());
    expect(await waitForDelegations(records, 2, null)).toBe(false);
  });

  it('times out without stopping anything', async () => {
    const { registry, records } = twoRunning();
    expect(await waitForDelegations(records, 2, Date.now() + 20)).toBe(true);
    // A wait timeout is not a cancellation: both are still working.
    expect(registry.running()).toHaveLength(2);
  });

  it('ends early on abort and reports that it did', async () => {
    const { records } = twoRunning();
    const controller = new AbortController();
    const wait = waitForDelegations(records, 2, null, controller.signal);
    controller.abort();
    expect(await wait).toBe(true);
  });
});

/**
 * A provider that answers the parent and the delegates from separate scripts.
 *
 * Routing is by system prompt: a delegate's prompt opens with `You are the
 * "<name>" subagent`, which is exactly the framing `composeSubagentSystemPrompt`
 * writes and nothing else in the graph produces.
 */
type ScriptStep = () => AssistantMessage | Promise<AssistantMessage>;

function scriptedProvider(script: { parent: ScriptStep[]; delegate: ScriptStep[] }) {
  const handle = fauxProvider({ provider: 'faux', models: [{ id: 'faux-p52', name: 'P52' }] });
  let parentIndex = 0;
  let delegateIndex = 0;
  const route = async (context: PiContext) => {
    const isDelegate = /You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? '');
    const steps = isDelegate ? script.delegate : script.parent;
    const index = isDelegate ? delegateIndex++ : parentIndex++;
    const step = steps[Math.min(index, steps.length - 1)];
    if (!step) throw new Error(`no scripted ${isDelegate ? 'delegate' : 'parent'} response`);
    return step();
  };
  // The faux provider SHIFTS one entry per request, so a single router entry
  // would answer once and then report "no more responses queued". Seeding many
  // copies of the same router is how a multi-turn script is expressed; the
  // router itself decides what each request gets.
  handle.setResponses(Array.from({ length: 64 }, () => route));
  return handle;
}

describe('SA03 / SA06 / SA09 · delegation end to end', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'p52-'));
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  async function build(script: Parameters<typeof scriptedProvider>[0]): Promise<RuntimeHandle> {
    const handle = scriptedProvider(script);
    runtime = await createRuntime({
      env: {},
      providers: [handle.provider],
      tools: { cwd: workspace },
      permissions: { gear: 'auto' },
      subagents: { home: join(workspace, 'home') },
      loop: { singleTurn: false },
    });
    return runtime;
  }

  it('registers all four Task tools with Task alone parallel', async () => {
    const handle = await build({ parent: [() => fauxAssistantMessage('ok')], delegate: [] });
    const tools = handle.ctx.runtimeTools.list();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      SUBAGENT_TOOL_NAME,
      SUBAGENT_WAIT_TOOL_NAME,
      SUBAGENT_LIST_TOOL_NAME,
      SUBAGENT_STOP_TOOL_NAME,
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    // This is what makes an all-Task message fan out and every other batch
    // run one call at a time (P5-2-0 §2.4).
    expect(byName.get(SUBAGENT_TOOL_NAME)?.executionMode).toBe('parallel');
    expect(byName.get(SUBAGENT_WAIT_TOOL_NAME)?.executionMode).toBe('sequential');
    expect(byName.get(SUBAGENT_STOP_TOOL_NAME)?.executionMode).toBe('sequential');
  });

  it('advertises the four builtins in the Task description', async () => {
    const handle = await build({ parent: [() => fauxAssistantMessage('ok')], delegate: [] });
    const task = handle.ctx.runtimeTools.list().find((tool) => tool.name === SUBAGENT_TOOL_NAME);
    for (const name of ['explorer', 'code-reviewer', 'test-runner', 'fixer'])
      expect(task?.description).toContain(name);
  });

  it('returns from Task before the delegate finishes, then delivers its report', async () => {
    // SA03 + SA06 in one run, because they are the same property seen from two
    // ends: the ack is early, and the RUN still does not end early.
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'look around' })], {
            stopReason: 'toolUse',
          }),
        // Turn 2: the parent has the ack and goes idle WITHOUT waiting. This is
        // the case D328 exists for - nothing here calls TaskWait.
        () => fauxAssistantMessage('I started the explorer and have nothing else to do.'),
        // Turn 3 only happens because the runtime fed the report back.
        () => fauxAssistantMessage('Integrated the report.'),
      ],
      delegate: [
        async () => {
          // Long enough that the parent is certainly idle first.
          await new Promise((resolve) => setTimeout(resolve, 60));
          return fauxAssistantMessage('EXPLORER-REPORT: found it at src/app.ts:42');
        },
      ],
    });

    const result = await handle.run({ prompt: 'find the thing' });

    expect(result.success).toBe(true);
    // Three parent turns: delegate, idle, integrate. The third only exists
    // because the runtime waited and re-prompted.
    expect(result.turns).toBe(3);
    expect(result.text).toContain('Integrated the report.');
    const records = handle.ctx.runtimeSubagents.registry.all();
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('completed');
    expect(records[0].result?.report).toContain('EXPLORER-REPORT');
    // The delegate's spend is reported separately from the parent's.
    expect(result.subagentUsage).toBeDefined();
    expect(result.usage).not.toEqual(result.subagentUsage);
  });

  it('gives two delegations to the same agent independent ids', async () => {
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage(
            [
              fauxToolCall('Task', { agent: 'explorer', task: 'first' }, { id: 'c1' }),
              fauxToolCall('Task', { agent: 'explorer', task: 'second' }, { id: 'c2' }),
            ],
            { stopReason: 'toolUse' }
          ),
        () => fauxAssistantMessage('started both'),
        () => fauxAssistantMessage('done'),
      ],
      delegate: [() => fauxAssistantMessage('a report')],
    });
    await handle.run({ prompt: 'two at once' });
    const records = handle.ctx.runtimeSubagents.registry.all();
    expect(records).toHaveLength(2);
    expect(records[0].delegationId).not.toBe(records[1].delegationId);
    expect(records.every((record) => record.agentName === 'explorer')).toBe(true);
  });

  it('refuses an unknown subagent with the real menu instead of starting one', async () => {
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'telepath', task: 'x' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('understood'),
      ],
      delegate: [],
    });
    const result = await handle.run({ prompt: 'delegate to nobody' });
    expect(result.success).toBe(true);
    expect(handle.ctx.runtimeSubagents.registry.all()).toHaveLength(0);
  });

  it('reports a delegate that wrote no report as failed, not as an empty success', async () => {
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'x' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('waiting'),
        () => fauxAssistantMessage('noted the failure'),
      ],
      delegate: [() => fauxAssistantMessage('')],
    });
    await handle.run({ prompt: 'go' });
    const record = handle.ctx.runtimeSubagents.registry.all()[0];
    expect(record.status).toBe('failed');
    expect(record.result?.error?.code).toBe('subagent_no_report');
    // The parent is still told what happened, in text it can act on.
    expect(record.result?.report).toContain('failed');
  });

  it('truncates a delegate at its maxTurns and still hands back its last report', async () => {
    // SA09. `explorer` is capped at 60, so the case pins its own cap through a
    // user document is out of scope here; instead the delegate is driven past a
    // small cap with a definition written for this test.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const root = join(workspace, 'home', '.agents', 'subagents');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'shorty.md'),
      [
        '---',
        'name: shorty',
        'description: a delegate with one turn',
        'tools: [Read]',
        'maxTurns: 1',
        '---',
        '',
        'Do one thing.',
      ].join('\n'),
      'utf8'
    );

    let delegateTurn = 0;
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'shorty', task: 'x' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('waiting'),
        () => fauxAssistantMessage('noted the truncation'),
      ],
      delegate: [
        () => {
          delegateTurn += 1;
          if (delegateTurn === 1) {
            return fauxAssistantMessage(
              [
                { type: 'text', text: 'partial finding' },
                fauxToolCall('read', { path: 'nope.txt' }, { id: 'r1' }),
              ],
              { stopReason: 'toolUse' }
            );
          }
          return fauxAssistantMessage('should never be reached');
        },
      ],
    });

    await handle.run({ prompt: 'go' });
    const record = handle.ctx.runtimeSubagents.registry.all()[0];
    expect(record.agentName).toBe('shorty');
    expect(record.status).toBe('truncated');
    expect(record.result?.report).toContain('turn limit');
    expect(record.result?.report).toContain('partial finding');
  });

  it('offers no delegation at all in plan mode', async () => {
    // The contract's "父 plan 模式不委派", including read-only delegates: there
    // is no first-version exception. Holds by construction — Task* is
    // registered with `write` access, which the tools plugin already filters.
    const handleForPlan = scriptedProvider({
      parent: [() => fauxAssistantMessage('ok')],
      delegate: [],
    });
    runtime = await createRuntime({
      env: {},
      providers: [handleForPlan.provider],
      tools: { cwd: workspace },
      permissions: { mode: 'plan' },
      subagents: { home: join(workspace, 'home') },
      loop: { singleTurn: false },
    });
    const names = runtime.ctx.runtimeTools.list().map((tool) => tool.name);
    for (const name of [
      SUBAGENT_TOOL_NAME,
      SUBAGENT_WAIT_TOOL_NAME,
      SUBAGENT_LIST_TOOL_NAME,
      SUBAGENT_STOP_TOOL_NAME,
    ]) {
      expect(names, name).not.toContain(name);
    }
  });

  it('delivers a report exactly once when the delegate finished before the parent idled', async () => {
    // SA07's first race: the delegate settles while the parent is still
    // working. The report must still reach the parent, and only once.
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'quick' })], {
            stopReason: 'toolUse',
          }),
        async () => {
          // Give the (instant) delegate time to settle before this turn ends.
          await new Promise((resolve) => setTimeout(resolve, 40));
          return fauxAssistantMessage('still working on my own part');
        },
        () => fauxAssistantMessage('integrated once'),
        () => fauxAssistantMessage('SHOULD NOT HAPPEN: delivered twice'),
      ],
      delegate: [() => fauxAssistantMessage('INSTANT-REPORT')],
    });
    const result = await handle.run({ prompt: 'go' });
    expect(result.text).toContain('integrated once');
    expect(result.text).not.toContain('SHOULD NOT HAPPEN');
    expect(result.turns).toBe(3);
  });

  it('does not re-deliver a report TaskWait already consumed', async () => {
    // SA07's second race. The delegate is deliberately still running when
    // TaskWait is called, so the wait is what converges on it and what puts the
    // report in front of the model. The auto-resume pass must then find nothing
    // left to hand over - otherwise the parent integrates the same report twice.
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'slow' })], {
            stopReason: 'toolUse',
          }),
        () =>
          fauxAssistantMessage([fauxToolCall('TaskWait', {}, { id: 'w1' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('read the report myself'),
        () => fauxAssistantMessage('SHOULD NOT HAPPEN: delivered again'),
      ],
      delegate: [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return fauxAssistantMessage('WAITED-REPORT');
        },
      ],
    });
    const result = await handle.run({ prompt: 'go' });
    expect(result.text).toContain('read the report myself');
    expect(result.text).not.toContain('SHOULD NOT HAPPEN');
    expect(result.turns).toBe(3);
    const record = handle.ctx.runtimeSubagents.registry.all()[0];
    expect(record.deliveredAt).toBeDefined();
  });

  it('tells the parent nothing is running when it waits after everything settled', async () => {
    // `TaskWait` with no ids means "the running ones", per contract. If they
    // have all finished already there is nothing to wait FOR — and the report
    // is not lost, because the auto-resume pass still owes it to the parent.
    // Pinned because the two halves only make sense together.
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'quick' })], {
            stopReason: 'toolUse',
          }),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return fauxAssistantMessage([fauxToolCall('TaskWait', {}, { id: 'w1' })], {
            stopReason: 'toolUse',
          });
        },
        () => fauxAssistantMessage('nothing was running'),
        () => fauxAssistantMessage('integrated the late report'),
      ],
      delegate: [() => fauxAssistantMessage('LATE-REPORT')],
    });
    const result = await handle.run({ prompt: 'go' });
    expect(result.text).toContain('integrated the late report');
    expect(handle.ctx.runtimeSubagents.registry.all()[0].deliveredAt).toBeDefined();
  });

  it('reports TaskStop only once the delegate has really converged', async () => {
    // SA08. Returning at abort time would report "stopped" while the delegate
    // still had one provider request in flight (P5-2-0 §2.5).
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'slow' })], {
            stopReason: 'toolUse',
          }),
        () =>
          fauxAssistantMessage([fauxToolCall('TaskStop', {}, { id: 's1' })], {
            stopReason: 'toolUse',
          }),
        // A second stop, to prove repeating it is harmless.
        () =>
          fauxAssistantMessage([fauxToolCall('TaskStop', {}, { id: 's2' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('stopped and moved on'),
      ],
      delegate: [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return fauxAssistantMessage('never delivered');
        },
      ],
    });
    const result = await handle.run({ prompt: 'go' });
    expect(result.success).toBe(true);
    const records = handle.ctx.runtimeSubagents.registry.all();
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('stopped');
    // By the time TaskStop returned, the delegate was settled - not merely
    // asked to stop.
    expect(records[0].completedAt).toBeDefined();
    expect(result.text).toContain('stopped and moved on');
  });

  it('stops a delegate on user Stop rather than leaving it running', async () => {
    // SA08: the run's own abort signal is one of the two doors to a delegate.
    const controller = new AbortController();
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'x' })], {
            stopReason: 'toolUse',
          }),
        () => {
          // The parent is idle; abort while the delegate is still working.
          controller.abort();
          return fauxAssistantMessage('started');
        },
      ],
      delegate: [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return fauxAssistantMessage('too late');
        },
      ],
    });

    const result = await handle.run({ prompt: 'go', signal: controller.signal });
    expect(result.stopReason).toBe('aborted');
    // Whatever it settles as, it must not still be running: a run that ended
    // with a live delegate is a leaked agent spending tokens with no owner.
    expect(handle.ctx.runtimeSubagents.registry.running()).toHaveLength(0);
  });
});
