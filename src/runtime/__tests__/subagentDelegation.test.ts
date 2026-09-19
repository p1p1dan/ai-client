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

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context as PiContext } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeEventDraft, SessionRetryInfo } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import {
  SUBAGENT_LIST_TOOL_NAME,
  SUBAGENT_STOP_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  SUBAGENT_WAIT_TOOL_NAME,
} from '../plugins/subagent/index.ts';
import {
  type DelegationRecord,
  DelegationRegistry,
  MAX_RETAINED_DELEGATIONS,
  MAX_SUBAGENT_CONCURRENCY,
  waitForDelegations,
} from '../plugins/subagent/registry.ts';
import type { SubagentRunResult } from '../plugins/subagent/run.ts';
import { neverAsked } from './fixtures/approval.ts';

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
      // Delivered as the real flow delivers them, on the auto-resume pass that
      // follows each settlement. Only a record the parent has READ is history,
      // and only history is evictable — see the case below.
      registry.markDelivered([registry.get(`d${index}`) as DelegationRecord]);
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

  it('never evicts a settled report the parent has not read, even past the cap', () => {
    // The retention cap is about HISTORY — re-reading a report by id. A report
    // nobody has read yet is not history, and dropping it took a delegate's
    // whole run with it: out of `undelivered()`, so the auto-resume pass never
    // hands it over, with no log line anywhere. That is the exact class
    // `deliveredAt` was introduced to protect.
    const registry = new DelegationRegistry();
    registry.admit({ delegationId: 'unread', agentName: 'explorer', abort: () => {} });
    registry.settle('unread', settledResult({ report: 'REPORT-NOBODY-READ' }), 1);
    for (let index = 0; index < MAX_RETAINED_DELEGATIONS + 5; index += 1) {
      registry.admit({ delegationId: `d${index}`, agentName: 'explorer', abort: () => {} });
      registry.settle(`d${index}`, settledResult(), 1_000 + index);
      registry.markDelivered([registry.get(`d${index}`) as DelegationRecord]);
    }
    // It is the OLDEST settled record, so an eviction by age takes it first.
    expect(registry.has('unread')).toBe(true);
    expect(registry.get('unread')?.result?.report).toBe('REPORT-NOBODY-READ');
    expect(registry.undelivered().map((record) => record.delegationId)).toEqual(['unread']);
    // Delivered history still went, so the protection did not disable the cap.
    expect(registry.has('d0')).toBe(false);
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
type ScriptStep = (context: PiContext) => AssistantMessage | Promise<AssistantMessage>;

function scriptedProvider(
  script: { parent: ScriptStep[]; delegate: ScriptStep[] },
  window: { contextWindow?: number; maxTokens?: number } = {}
) {
  const handle = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-p52', name: 'P52', ...window }],
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

  async function build(
    script: Parameters<typeof scriptedProvider>[0],
    subagents: { projectInstructions?: () => Promise<string | undefined> } = {},
    window: { contextWindow?: number; maxTokens?: number } = {}
  ): Promise<RuntimeHandle> {
    const handle = scriptedProvider(script, window);
    runtime = await createRuntime({
      env: {},
      providers: [handle.provider],
      tools: { cwd: workspace },
      permissions: { approve: neverAsked, gear: 'auto' },
      subagents: { home: join(workspace, 'home'), ...subagents },
      loop: { singleTurn: false },
    });
    return runtime;
  }

  /** Plain text of one request's messages, for asserting on what was sent. */
  function messageTexts(context: PiContext): string[] {
    return context.messages.map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      return (Array.isArray(content) ? content : [])
        .map((block) =>
          (block as { type?: string }).type === 'text'
            ? ((block as { text?: string }).text ?? '')
            : ''
        )
        .join('');
    });
  }

  /**
   * Records every tool result the parent's MODEL was handed.
   *
   * Asserting on the registry is not enough for the `TaskStop` cases: the whole
   * question there is what the model was told, and a report that exists in the
   * registry but never reaches the model is precisely the defect.
   */
  function toolResultCollector(into: { tool: string; text: string }[]) {
    return (event: AgentEvent) => {
      if (event.type !== 'tool_execution_end') return;
      const result = event.result as { content?: { type: string; text?: string }[] } | undefined;
      into.push({
        tool: event.toolName,
        text: (result?.content ?? [])
          .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
          .join(''),
      });
    };
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

  it('publishes a delegate retry with the delegation id', async () => {
    // decision 029 clause 8. The delegate budget was built with NO callbacks at
    // all, so a fan-out sitting in a gateway outage was indistinguishable from
    // one that had silently stopped: the banner never moved, and the only
    // evidence was the delegate reporting a failure 43 seconds later. The wait
    // here is the real first rung (3s) because the ladder is not injectable
    // from this far out.
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'look' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('Started it.'),
        () => fauxAssistantMessage('Integrated the report.'),
      ],
      delegate: [
        () => {
          // Thrown, so faux reports an error event with no preceding `start` —
          // the setup failure the retry wrapper owns.
          throw new Error('503: gateway unavailable');
        },
        () => fauxAssistantMessage('EXPLORER-REPORT: recovered after the hiccup.'),
      ],
    });
    const retries: SessionRetryInfo[] = [];
    const plainStatuses: number[] = [];
    handle.events.subscribe((event) => {
      if (event.type !== 'session.status') return;
      if (event.payload.retry) retries.push(event.payload.retry);
      else plainStatuses.push(retries.length);
    });

    const result = await handle.run({ prompt: 'find the thing' });
    expect(result.success).toBe(true);

    const records = handle.ctx.runtimeSubagents.registry.all();
    expect(records[0].status).toBe('completed');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      attempt: 1,
      maxRetries: 3,
      delayMs: 3_000,
      error: 'PROVIDER_ERROR',
      // The field that makes this attributable: without it the banner can say
      // "retrying" but not which of five delegates is waiting.
      delegationId: records[0].delegationId,
      retryAt: expect.any(Number),
      attemptStartedAt: expect.any(Number),
    });
    // ...and it comes back down: a status with no retry after the one that
    // carried it, which is how every producer of this event clears the banner.
    expect(plainStatuses).toContain(1);
  }, 30_000);

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
    const { mkdir } = await import('node:fs/promises');
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

  it("warns a delegate that is running out of context, in the parent's own wording", async () => {
    // context-prompt-17. A delegate had no budget wiring at all — no reminder,
    // no guard, no compaction — with up to 80 turns to spend. On a small window
    // the very first turn boundary is already inside the reminder band, which
    // is the point: the delegate is told while it can still act on it.
    const delegateRequests: string[][] = [];
    const handle = await build(
      {
        parent: [
          () =>
            fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'x' })], {
              stopReason: 'toolUse',
            }),
          () => fauxAssistantMessage('waiting'),
          () => fauxAssistantMessage('noted'),
        ],
        delegate: [
          (context) => {
            delegateRequests.push(messageTexts(context));
            return fauxAssistantMessage(
              [
                { type: 'text', text: 'looked around' },
                fauxToolCall('read', { path: 'nope.txt' }, { id: 'r1' }),
              ],
              { stopReason: 'toolUse' }
            );
          },
          (context) => {
            delegateRequests.push(messageTexts(context));
            return fauxAssistantMessage('DELEGATE-REPORT');
          },
        ],
      },
      {},
      { contextWindow: 8_000, maxTokens: 1_000 }
    );
    await handle.run({ prompt: 'go' });
    const record = handle.ctx.runtimeSubagents.registry.all()[0];
    expect(record.status).toBe('completed');
    expect(delegateRequests).toHaveLength(2);
    // The first request predates any boundary, so it carries no reminder; the
    // second does, and it is the same `<context_budget>` block the parent uses.
    expect(delegateRequests[0].join('\n')).not.toContain('<context_budget>');
    expect(delegateRequests[1].join('\n')).toContain('<context_budget>');
  });

  it('stops a delegate at the hard limit instead of sending the request that cannot be served', async () => {
    // context-prompt-17, the other half. A delegate cannot compact — a
    // checkpoint is a session-level object and a delegate has no session — so
    // the guard has to end it while it still has a report to hand back, rather
    // than let it walk into a provider-side context overflow whose only trace
    // is one line of failure text in the parent's context.
    const big = join(workspace, 'big.txt');
    await writeFile(big, 'x'.repeat(200_000), 'utf8');
    let delegateTurn = 0;
    const handle = await build(
      {
        parent: [
          () =>
            fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'x' })], {
              stopReason: 'toolUse',
            }),
          () => fauxAssistantMessage('waiting'),
          () => fauxAssistantMessage('noted the truncation'),
        ],
        delegate: [
          () => {
            delegateTurn += 1;
            if (delegateTurn === 1)
              return fauxAssistantMessage(
                [
                  { type: 'text', text: 'PARTIAL-FINDING: the config lives in big.txt' },
                  fauxToolCall('read', { path: big }, { id: 'r1' }),
                ],
                { stopReason: 'toolUse' }
              );
            return fauxAssistantMessage('should never be reached');
          },
        ],
      },
      {},
      { contextWindow: 8_000, maxTokens: 1_000 }
    );
    await handle.run({ prompt: 'go' });
    const record = handle.ctx.runtimeSubagents.registry.all()[0];
    expect(record.status).toBe('truncated');
    // Named for what actually ran out, not for the turn cap it never reached.
    expect(record.result?.report).toContain('ran out of context window');
    expect(record.result?.report).not.toContain('turn limit');
    // Whatever it did find still reaches the parent.
    expect(record.result?.report).toContain('PARTIAL-FINDING');
    expect(delegateTurn).toBe(1);
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
      permissions: { approve: neverAsked, mode: 'plan' },
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

  it('re-asks a delegate stream that died, without replaying its tools', async () => {
    // SA13. A stream that fails AFTER it started is not covered by the request
    // wrapper; recovering from it needs the loop's message state. The property
    // that matters is in the second half of the name: the delegate already ran
    // a tool, and a "retry" that restarted it would run that tool twice — for
    // `fixer` that means writing the same file twice.
    await writeFile(join(workspace, 'target.txt'), 'contents\n', 'utf8');

    let delegateTurn = 0;
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'read it' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('waiting'),
        () => fauxAssistantMessage('integrated'),
      ],
      delegate: [
        () => {
          delegateTurn += 1;
          if (delegateTurn === 1) {
            return fauxAssistantMessage(
              [fauxToolCall('read', { path: 'target.txt' }, { id: 'r1' })],
              { stopReason: 'toolUse' }
            );
          }
          if (delegateTurn === 2) {
            return fauxAssistantMessage('', {
              stopReason: 'error',
              errorMessage: '503: service unavailable',
            });
          }
          return fauxAssistantMessage('RECOVERED: target.txt says contents');
        },
      ],
    });

    let toolStarts = 0;
    handle.ctx.runtimeSubagents.onEvent((envelope) => {
      if (envelope.event.type === 'tool_execution_start') toolStarts += 1;
    });

    await handle.run({ prompt: 'go' });

    const record = handle.ctx.runtimeSubagents.registry.all()[0];
    expect(record.status).toBe('completed');
    expect(record.result?.report).toContain('RECOVERED');
    // Exactly once. The retry re-asked the failed request; it did not restart
    // the delegate.
    expect(toolStarts).toBe(1);
    // Three provider requests for the delegate: the tool turn, the failed
    // stream, and the recovered one.
    expect(delegateTurn).toBe(3);
  }, 20_000);

  it('fails a delegate on a stream error that re-sending cannot fix', async () => {
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'x' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('waiting'),
        () => fauxAssistantMessage('noted'),
      ],
      delegate: [
        () =>
          fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: '401 Unauthorized: invalid api key',
          }),
      ],
    });
    await handle.run({ prompt: 'go' });
    const record = handle.ctx.runtimeSubagents.registry.all()[0];
    expect(record.status).toBe('failed');
    // Straight to failure: retrying a bad key just spends the budget.
    expect(record.result?.turns).toBe(1);
  });

  it('records the gates a delegate passed, including the one nobody was asked about', async () => {
    // The parent loop is the only consumer of `onActivity`, and it used to keep
    // only records whose toolCallId was in its own set. A delegate has its own
    // `Agent`, so its ids never get there — every gate a subagent passed was
    // dropped: no timeline row, no trace note. `policy` allows raise no dialog
    // at all, so that row is the only evidence anywhere that the call was
    // checked rather than simply unchecked.
    await writeFile(join(workspace, 'target.txt'), 'contents\n', 'utf8');
    const events: RuntimeEventDraft[] = [];
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'read it' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('waiting'),
        () => fauxAssistantMessage('integrated'),
      ],
      delegate: [
        (() => {
          let turn = 0;
          return () => {
            turn += 1;
            return turn === 1
              ? fauxAssistantMessage([fauxToolCall('read', { path: 'target.txt' }, { id: 'r1' })], {
                  stopReason: 'toolUse',
                })
              : fauxAssistantMessage('DELEGATE-REPORT');
          };
        })(),
      ],
    });
    handle.events.subscribe((event) => events.push(event));

    const result = await handle.run({ prompt: 'go' });

    const delegationId = handle.ctx.runtimeSubagents.registry.all()[0].delegationId;
    const activity = events.filter((event) => event.type === 'permission.activity');
    const delegateRows = activity.filter(
      (event) => (event.payload as { delegationId?: string }).delegationId !== undefined
    );
    expect(delegateRows.length).toBeGreaterThan(0);
    expect(delegateRows.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({
        phase: 'decision',
        requestId: 'r1',
        surface: 'read',
        result: 'allow',
        // Attribution only. A session grant stays session scoped whoever earned
        // it (runtime-hardening decision 003); these fields say who was checked.
        delegationId,
        agentName: 'explorer',
      })
    );
    // The trace half of the same evidence: without it there is no answer to
    // "which rule let the subagent read that file" after the fact.
    const notes = (result.trace?.steps ?? []).filter(
      (step) => typeof step.detail.event === 'string' && step.detail.event.startsWith('permission_')
    );
    expect(JSON.stringify(notes)).toContain(delegationId);
  }, 15_000);

  it('settles a delegation whose start failed after admission, instead of hanging on it', async () => {
    // The window between `admit()` and `SubagentRun.run()`. `projectInstructions`
    // is the realistic thrower: it reads the workspace instruction chain through
    // the host, and a TSD-unavailable or transport failure propagates BY DESIGN
    // ("ciphertext is never an instruction"). Admission has already registered a
    // running delegation whose `completion` only `run()` can resolve, so an
    // unguarded throw leaves it running forever — and the auto-resume pass,
    // `drain()` after a Stop and `dispose()` all wait on it with no timeout.
    // The observable symptom is this test never finishing.
    const handle = await build(
      {
        parent: [
          () =>
            fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'x' })], {
              stopReason: 'toolUse',
            }),
          () => fauxAssistantMessage('understood, doing it myself'),
        ],
        delegate: [],
      },
      {
        projectInstructions: async () => {
          throw new Error('io_tsd_unavailable');
        },
      }
    );

    const results: { tool: string; text: string }[] = [];
    const result = await handle.run({ prompt: 'go', onEvent: toolResultCollector(results) });

    expect(result.success).toBe(true);
    const record = handle.ctx.runtimeSubagents.registry.all()[0];
    expect(record.status).toBe('failed');
    expect(record.result?.error?.code).toBe('delegation_start_failed');
    // Nothing is left running or owed, so the run could end at all.
    expect(handle.ctx.runtimeSubagents.registry.running()).toHaveLength(0);
    expect(handle.ctx.runtimeSubagents.busy).toBe(false);
    // And the model was told why, in the result of the call it made.
    expect(results.find((entry) => entry.tool === 'Task')?.text).toContain('io_tsd_unavailable');
  }, 15_000);

  it('gives TaskStop a report for a delegation that had already finished', async () => {
    // The model calls TaskList, decides to wrap up, and names ids that include
    // one that finished in between. Marking that one delivered without showing
    // its report makes a whole delegate run — real tokens, real work — vanish
    // from the parent's side of the session: the registry and the panel still
    // have it, the model never sees it.
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'quick' })], {
            stopReason: 'toolUse',
          }),
        async () => {
          // Let the (instant) delegate settle, then stop it by id anyway.
          await new Promise((resolve) => setTimeout(resolve, 60));
          const id = runtime?.ctx.runtimeSubagents.registry.all()[0]?.delegationId ?? 'none';
          return fauxAssistantMessage(
            [fauxToolCall('TaskStop', { delegationIds: [id] }, { id: 's1' })],
            { stopReason: 'toolUse' }
          );
        },
        () => fauxAssistantMessage('wrapped up'),
        () => fauxAssistantMessage('SHOULD NOT HAPPEN: delivered again'),
      ],
      delegate: [() => fauxAssistantMessage('FINISHED-BEFORE-STOP')],
    });

    const results: { tool: string; text: string }[] = [];
    const result = await handle.run({ prompt: 'go', onEvent: toolResultCollector(results) });

    const stopResult = results.find((entry) => entry.tool === 'TaskStop');
    expect(stopResult?.text).toContain('FINISHED-BEFORE-STOP');
    expect(stopResult?.text).toContain('already finished');
    // It was a completion, not a stop, and the answer says so.
    expect(stopResult?.text).not.toContain('Stopped 1 subagent');
    expect(handle.ctx.runtimeSubagents.registry.all()[0].status).toBe('completed');
    // Shown once: TaskStop answered with it, so auto-resume must not repeat it.
    expect(result.text).not.toContain('SHOULD NOT HAPPEN');
  }, 15_000);

  it('settles a delegate that never converges rather than letting drain wait forever', async () => {
    // `drain()` runs in the run's `finally` and again in `dispose()`. Waiting
    // on a delegate that never settles turns "I cannot stop this" into "I
    // cannot close this either", and the only way out is killing the process.
    // A no-op `abort` is what a wedged delegate looks like from here.
    const handle = await build({ parent: [() => fauxAssistantMessage('ok')], delegate: [] });
    const registry = handle.ctx.runtimeSubagents.registry;
    registry.admit({ delegationId: 'wedged', agentName: 'explorer', abort: () => {} });

    await handle.ctx.runtimeSubagents.drain(20);

    expect(registry.running()).toHaveLength(0);
    // Named for what happened, not collapsed into `failed`: it was asked to
    // stop and did not answer in time.
    expect(registry.get('wedged')?.status).toBe('timed_out');
    expect(registry.get('wedged')?.result?.error?.code).toBe('delegation_drain_timeout');
    // The completion promise everyone waits on is resolved, so nothing hangs.
    await expect(registry.get('wedged')?.completion).resolves.toBeUndefined();
  });

  it('tells the parent a stopped delegate was stopped, and hands back what it had', async () => {
    // Two halves of one defect. `run()` could only ever return `aborted`, so a
    // record the registry showed as `stopped` carried a report that read "was
    // aborted" — and the branch written to return the partial work was
    // unreachable, so a stopped delegate's findings were thrown away.
    await writeFile(join(workspace, 'target.txt'), 'contents\n', 'utf8');
    let delegateTurn = 0;
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'survey' })], {
            stopReason: 'toolUse',
          }),
        async () => {
          // Long enough for the delegate's first turn (text + a tool call) to
          // land, short enough that its second is still in flight.
          await new Promise((resolve) => setTimeout(resolve, 120));
          return fauxAssistantMessage([fauxToolCall('TaskStop', {}, { id: 's1' })], {
            stopReason: 'toolUse',
          });
        },
        () => fauxAssistantMessage('stopped it'),
      ],
      delegate: [
        async () => {
          delegateTurn += 1;
          if (delegateTurn === 1) {
            return fauxAssistantMessage(
              [
                { type: 'text', text: 'PARTIAL-FINDING: target.txt exists' },
                fauxToolCall('read', { path: 'target.txt' }, { id: 'r1' }),
              ],
              { stopReason: 'toolUse' }
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
          return fauxAssistantMessage('too late to matter');
        },
      ],
    });

    await handle.run({ prompt: 'go' });

    const record = handle.ctx.runtimeSubagents.registry.all()[0];
    expect(record.status).toBe('stopped');
    // The status and the prose agree...
    expect(record.result?.status).toBe('stopped');
    expect(record.result?.report).toContain('was stopped after');
    expect(record.result?.report).not.toContain('was aborted');
    // ...and the work it did get done comes back with it.
    expect(record.result?.report).toContain('PARTIAL-FINDING');
  }, 20_000);

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
