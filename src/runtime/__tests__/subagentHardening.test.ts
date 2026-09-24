/**
 * T020 gate — the twenty subagent findings of the 2026-09-14 audit, each pinned
 * where it actually failed.
 *
 * Two halves, for the same reason `subagentDelegation.test.ts` has two:
 *
 * - The **pure** half drives the record/prompt helpers directly. Truncation,
 *   id minting and usage summation are decided in pure functions, and a
 *   property asserted through a live delegate is one nobody can regress in
 *   under six seconds.
 * - The **wired** half builds a real runtime with a scripted provider, because
 *   four of the findings are about things that only exist end to end: a
 *   definition re-read between runs, a per-delegation event cap, what lands in
 *   the session file, and a delegated cost reaching `usage.updated`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context as PiContext, Usage } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import {
  MAX_ACTIVITY_EVENTS_PER_DELEGATION,
  SUBAGENT_TOOL_NAME,
  SUBAGENT_WAIT_TOOL_NAME,
} from '../plugins/subagent/index.ts';
import { subagentGuidance } from '../plugins/subagent/prompt.ts';
import {
  activityForEvent,
  clampRecordedMessage,
  clampSubagentText,
  MAX_RECORDED_TEXT_CHARS,
  readSubagentHistory,
  SUBAGENT_ENTRY,
  subagentHistorySummaries,
  subagentHistoryUsage,
} from '../plugins/subagent/records.ts';
import { neverAsked } from './fixtures/approval.ts';

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
    ...overrides,
  } as Usage;
}

describe('subagent-data-17 · truncation never splits a character', () => {
  // U+1F600 is one astral character, two UTF-16 code units. A cut at index 5
  // of "abcd" + emoji lands between its halves.
  const emoji = '\u{1F600}';

  it('backs off a cut that would land inside a surrogate pair', () => {
    const text = `abcd${emoji}efgh`;
    const clamped = clampSubagentText(text, 6);
    // The marker costs one unit, so the naive cut is at 5 — the high surrogate.
    expect(clamped.endsWith('…')).toBe(true);
    // The real assertion: the result is well-formed. An orphan high surrogate
    // survives structured clone and the browser draws it as a replacement box,
    // which reads as the model emitting garbage.
    expect(clamped.isWellFormed()).toBe(true);
    expect(clamped).not.toContain('�');
  });

  it('never returns more than the budget it was given', () => {
    // The old inline form was `slice(0, max) + '…'`, i.e. max + 1. A clamp that
    // can exceed its own bound is not one a caller can size anything from.
    for (const max of [1, 2, 8, 240, 4000]) {
      expect(clampSubagentText('y'.repeat(max * 2), max).length).toBeLessThanOrEqual(max);
    }
  });

  it('leaves a string that already fits exactly as it was', () => {
    expect(clampSubagentText(`ok${emoji}`, 50)).toBe(`ok${emoji}`);
  });

  it('clamps a history report through the same helper', () => {
    const report = `${'x'.repeat(4_000)}${emoji}tail`;
    const [summary] = subagentHistorySummaries([
      {
        type: 'custom',
        customType: SUBAGENT_ENTRY,
        data: {
          kind: 'started',
          delegationId: 'd1',
          agentName: 'explorer',
          parentToolCallId: 'c1',
          runId: 'r1',
          task: 't',
          model: { provider: 'faux', modelId: 'm' },
          startedAt: 1,
        },
      },
      {
        type: 'custom',
        customType: SUBAGENT_ENTRY,
        data: {
          kind: 'settled',
          delegationId: 'd1',
          agentName: 'explorer',
          parentToolCallId: 'c1',
          runId: 'r1',
          status: 'completed',
          turns: 1,
          toolCalls: 0,
          report,
          completedAt: 2,
        },
      },
    ]);
    expect(summary.report?.isWellFormed()).toBe(true);
    expect(summary.report?.length).toBeLessThanOrEqual(4_000);
  });
});

describe('subagent-data-11 · two payloads minted in one millisecond stay distinct', () => {
  function assistantMessage(text: string): AgentEvent {
    return {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    } as unknown as AgentEvent;
  }

  it('gives each payload its own id even inside one clock tick', () => {
    const base = { parentToolCallId: 'c1', agentId: 'd1' };
    const first = activityForEvent(assistantMessage('one'), base);
    const second = activityForEvent(assistantMessage('two'), base);
    const idOf = (payloads: ReturnType<typeof activityForEvent>) =>
      payloads.find((payload) => payload.kind === 'text') as { id: string };
    // The renderer's lane reducer is idempotent by (kind, id) and DROPS a
    // repeat, so a collision here is a message that never appears — possibly
    // the delegate's final report.
    expect(idOf(first).id).not.toBe(idOf(second).id);
  });
});

describe('subagent-data-12 · one adder for delegate usage', () => {
  const entries = (...usages: Usage[]) =>
    usages.flatMap((entry, index) => [
      {
        type: 'custom',
        customType: SUBAGENT_ENTRY,
        data: {
          kind: 'started',
          delegationId: `d${index}`,
          agentName: 'explorer',
          parentToolCallId: 'c1',
          runId: 'r1',
          task: 't',
          model: { provider: 'faux', modelId: 'm' },
          startedAt: index,
        },
      },
      {
        type: 'custom',
        customType: SUBAGENT_ENTRY,
        data: {
          kind: 'settled',
          delegationId: `d${index}`,
          agentName: 'explorer',
          parentToolCallId: 'c1',
          runId: 'r1',
          status: 'completed',
          turns: 1,
          toolCalls: 0,
          report: 'r',
          usage: entry,
          completedAt: index + 1,
        },
      },
    ]);

  it('sums the optional columns instead of keeping the first delegate value', () => {
    const history = readSubagentHistory(
      entries(usage({ reasoning: 10, cacheWrite1h: 3 }), usage({ reasoning: 5, cacheWrite1h: 7 }))
    );
    const total = subagentHistoryUsage(history);
    expect(total.delegations).toBe(2);
    expect(total.usage?.totalTokens).toBe(4);
    // The local summation seeded the total with a shallow copy of the first
    // entry and then only added the five required token fields, so these two
    // came out as "whatever the first delegate reported".
    expect(total.usage?.reasoning).toBe(15);
    expect(total.usage?.cacheWrite1h).toBe(10);
  });

  it('answers nothing when no delegate reported a cost', () => {
    expect(subagentHistoryUsage([])).toEqual({ usage: undefined, delegations: 0 });
  });
});

describe('subagent-data-05 · a delegate message is clamped before it is written', () => {
  it('clamps every string in the message, however deeply it is nested', () => {
    const huge = 'z'.repeat(MAX_RECORDED_TEXT_CHARS * 3);
    const clamped = clampRecordedMessage({
      role: 'toolResult',
      content: [{ type: 'text', text: huge }],
      details: { nested: { deeper: huge } },
    }) as {
      content: { text: string }[];
      details: { nested: { deeper: string } };
    };
    expect(clamped.content[0].text.length).toBeLessThanOrEqual(MAX_RECORDED_TEXT_CHARS);
    expect(clamped.details.nested.deeper.length).toBeLessThanOrEqual(MAX_RECORDED_TEXT_CHARS);
  });

  it('leaves non-string values alone, so a transcript stays readable', () => {
    const clamped = clampRecordedMessage({
      role: 'assistant',
      timestamp: 1234,
      ok: true,
      content: [{ type: 'text', text: 'short' }],
    }) as { timestamp: number; ok: boolean; content: { text: string }[] };
    expect(clamped.timestamp).toBe(1234);
    expect(clamped.ok).toBe(true);
    expect(clamped.content[0].text).toBe('short');
  });
});

describe('subagent-data-14 · guidance names only the tools the delegate has', () => {
  it('tells a read-only delegate nothing about grep or glob', () => {
    const [block] = subagentGuidance({ toolNames: ['read'] });
    expect(block).toContain('read accepts only an existing regular text file');
    expect(block).not.toContain('grep takes');
    expect(block).not.toContain('glob takes');
    // The lead line has to agree with the body, or the delegate is invited to
    // call the tool the body then never explains.
    expect(block).toContain('prefer read over shell text utilities');
  });

  it('tells a grep-capable delegate about regex, which P5-2-3 added', () => {
    const [block] = subagentGuidance({ toolNames: ['grep'] });
    expect(block).toContain('`regex`');
    expect(block).not.toContain('read accepts');
  });

  it('splits the editing block the same way', () => {
    const write = subagentGuidance({ toolNames: ['write'] }).join('\n');
    expect(write).toContain('write for a coherent whole-file rewrite');
    expect(write).not.toContain('use edit for one small unique replacement');
  });

  it('says nothing at all to a delegate with none of these tools', () => {
    expect(subagentGuidance({ toolNames: ['bash'] })).toEqual([]);
  });
});

/**
 * A provider that answers the parent and the delegates from separate scripts.
 *
 * Same routing rule as `subagentDelegation.test.ts`: a delegate's system prompt
 * opens with `You are the "<name>" subagent`, which nothing else produces.
 */
type ScriptStep = (context: PiContext) => AssistantMessage | Promise<AssistantMessage>;

function scriptedProvider(script: { parent: ScriptStep[]; delegate: ScriptStep[] }) {
  const handle = fauxProvider({ provider: 'faux', models: [{ id: 'faux-t020', name: 'T020' }] });
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

describe('T020 · wired', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;
  let logged: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 't020-'));
    logged = [];
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  function definitionsDir(): string {
    return join(workspace, 'home', '.agents', 'subagents');
  }

  async function writeDefinition(name: string, lines: readonly string[]): Promise<void> {
    await mkdir(definitionsDir(), { recursive: true });
    await writeFile(join(definitionsDir(), `${name}.md`), lines.join('\n'), 'utf8');
  }

  async function build(
    script: { parent: ScriptStep[]; delegate: ScriptStep[] },
    subagents: { transcriptBudgetBytes?: number } = {}
  ): Promise<RuntimeHandle> {
    const handle = scriptedProvider(script);
    runtime = await createRuntime({
      env: {},
      providers: [handle.provider],
      tools: { cwd: workspace },
      permissions: { approve: neverAsked, gear: 'auto' },
      session: { cwd: workspace, mode: 'create', file: join(workspace, 'session.jsonl') },
      subagents: {
        home: join(workspace, 'home'),
        log: (message: string) => logged.push(message),
        ...subagents,
      },
      loop: { singleTurn: false },
    });
    return runtime;
  }

  /** Delegate once, then idle, then integrate — the shortest whole delegation. */
  function delegateOnce(agent: string, task = 'do it'): ScriptStep[] {
    return [
      () =>
        fauxAssistantMessage([fauxToolCall(SUBAGENT_TOOL_NAME, { agent, task })], {
          stopReason: 'toolUse',
        }),
      () => fauxAssistantMessage('started it'),
      () => fauxAssistantMessage('integrated'),
    ];
  }

  it('subagent-data-02 · a definition written mid-session reaches the very next run', async () => {
    const handle = await build({
      parent: [() => fauxAssistantMessage('nothing to do')],
      delegate: [() => fauxAssistantMessage('SCOUT-REPORT')],
    });
    await handle.run({ prompt: 'first turn' });

    const taskTool = () =>
      handle.ctx.runtimeTools.list().find((tool) => tool.name === SUBAGENT_TOOL_NAME);
    expect(taskTool()?.description).not.toContain('scout');

    await writeDefinition('scout', [
      '---',
      'name: scout',
      'description: written while the session was open',
      'tools: [Read]',
      '---',
      '',
      'Look around.',
    ]);

    // The second run is what re-reads. Driven through the service rather than
    // a second `run()` so the assertion is about the catalog and not about the
    // scripted provider's turn budget; the case below drives the real run.
    await handle.ctx.runtimeSubagents.refresh();

    // The menu the model reads is rebuilt, not frozen at boot.
    expect(taskTool()?.description).toContain('scout');
    expect(taskTool()?.description).toContain('written while the session was open');
    const agentParam = (
      taskTool()?.parameters as { properties?: { agent?: { description?: string } } } | undefined
    )?.properties?.agent;
    expect(agentParam?.description).toContain('scout');
    expect(handle.ctx.runtimeSubagents.definitions.map((entry) => entry.name)).toContain('scout');
  });

  it('subagent-data-02 · the run itself re-reads, so a new delegate is callable', async () => {
    await writeDefinition('scout', [
      '---',
      'name: scout',
      'description: present from the start',
      'tools: [Read]',
      '---',
      '',
      'Look around.',
    ]);
    const handle = await build({
      parent: delegateOnce('scout'),
      delegate: [() => fauxAssistantMessage('SCOUT-REPORT: found it')],
    });
    // Rewritten between construction and the run: only a per-run re-read makes
    // this description the one the run advertises.
    await writeDefinition('scout', [
      '---',
      'name: scout',
      'description: edited between boot and run',
      'tools: [Read]',
      '---',
      '',
      'Look around, carefully.',
    ]);
    const result = await handle.run({ prompt: 'go' });
    expect(result.success).toBe(true);
    const task = handle.ctx.runtimeTools.list().find((tool) => tool.name === SUBAGENT_TOOL_NAME);
    expect(task?.description).toContain('edited between boot and run');
    expect(handle.ctx.runtimeSubagents.registry.all()[0]?.result?.report).toContain('SCOUT-REPORT');
  });

  it('subagent-core-06 · caps one delegation at 200 live events, then says so', async () => {
    const events: RuntimeEventDraft[] = [];
    // Enough tool calls in ONE delegate message to pass the cap twice over:
    // each one produces a started and a completed payload.
    const calls = Array.from({ length: 120 }, (_, index) =>
      fauxToolCall('read', { path: join(workspace, `missing-${index}.txt`) }, { id: `t${index}` })
    );
    const handle = await build({
      parent: delegateOnce('explorer'),
      delegate: [
        () => fauxAssistantMessage(calls, { stopReason: 'toolUse' }),
        () => fauxAssistantMessage('EXPLORER-REPORT: done'),
      ],
    });
    handle.events.subscribe((event) => {
      if (event.type === 'subagent.activity') events.push(event);
    });
    await handle.run({ prompt: 'go' });

    const payloads = events.map((event) => (event as { payload: { kind: string } }).payload);
    const capped = payloads.filter((payload) => payload.kind === 'capped');
    expect(capped).toHaveLength(1);
    expect((capped[0] as unknown as { limit: number }).limit).toBe(
      MAX_ACTIVITY_EVENTS_PER_DELEGATION
    );
    const progress = payloads.filter(
      (payload) =>
        payload.kind !== 'capped' && payload.kind !== 'status' && payload.kind !== 'report'
    );
    expect(progress).toHaveLength(MAX_ACTIVITY_EVENTS_PER_DELEGATION);
    // The contract's hard half: a cap must never be why a terminal status or a
    // report goes missing, so both are still on the channel after it.
    expect(payloads.filter((payload) => payload.kind === 'status')).toHaveLength(1);
    expect(payloads.filter((payload) => payload.kind === 'report')).toHaveLength(1);
    // And the record is untouched by any of it.
    expect(handle.ctx.runtimeSubagents.registry.all()[0]?.result?.report).toContain(
      'EXPLORER-REPORT'
    );
  }, 30_000);

  it('subagent-data-05 · a delegate transcript is clamped and then budgeted', async () => {
    const huge = 'q'.repeat(MAX_RECORDED_TEXT_CHARS * 2);
    const handle = await build(
      {
        parent: delegateOnce('explorer'),
        delegate: [() => fauxAssistantMessage(`EXPLORER-REPORT ${huge}`)],
      },
      // One byte of budget: the first message spends it, everything after is
      // the degraded path — terminal facts only.
      { transcriptBudgetBytes: 1 }
    );
    await handle.run({ prompt: 'go' });
    await handle.session?.flush();
    const entries = handle.session?.snapshot().entries ?? [];
    const records = entries
      .filter((entry) => entry.type === 'custom' && entry.customType === SUBAGENT_ENTRY)
      .map((entry) => (entry as unknown as { data: { kind: string } }).data);
    const kinds = records.map((entry) => entry.kind);
    // Start and settle always go; the transcript is what degrades.
    expect(kinds).toContain('started');
    expect(kinds).toContain('settled');
    expect(logged.some((line) => line.includes('transcript budget spent'))).toBe(true);
    // The report itself is NOT what was dropped: it rides the settled record.
    const settled = records.find((entry) => entry.kind === 'settled') as
      | { report: string }
      | undefined;
    expect(settled?.report).toContain('EXPLORER-REPORT');
    for (const entry of records) {
      if (entry.kind !== 'message') continue;
      const text = JSON.stringify((entry as unknown as { message: unknown }).message);
      expect(text.length).toBeLessThan(MAX_RECORDED_TEXT_CHARS * 2);
    }
  });

  it('subagent-core-12 · TaskWait details dedupe ids and clamp each report', async () => {
    const longReport = `EXPLORER-REPORT ${'w'.repeat(9_000)}`;
    const seen: { tool: string; details: unknown }[] = [];
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage(
            [fauxToolCall(SUBAGENT_TOOL_NAME, { agent: 'explorer', task: 'x' }, { id: 'c1' })],
            { stopReason: 'toolUse' }
          ),
        (context) => {
          // The delegation id is in the Task result the parent was handed.
          const id = /Delegation ([0-9a-f-]+) started/.exec(JSON.stringify(context.messages))?.[1];
          return fauxAssistantMessage(
            [fauxToolCall(SUBAGENT_WAIT_TOOL_NAME, { delegationIds: [id, id, id] }, { id: 'c2' })],
            { stopReason: 'toolUse' }
          );
        },
        () => fauxAssistantMessage('integrated'),
      ],
      delegate: [() => fauxAssistantMessage(longReport)],
    });
    const collect = (event: AgentEvent) => {
      if (event.type !== 'tool_execution_end') return;
      seen.push({
        tool: event.toolName,
        details: (event.result as { details?: unknown }).details,
      });
    };
    await handle.run({ prompt: 'go', onEvent: collect });

    const wait = seen.find((entry) => entry.tool === SUBAGENT_WAIT_TOOL_NAME);
    const delegations = (wait?.details as { delegations: { report: string }[] }).delegations;
    // Three copies of one id asked for one delegation, not three: the details
    // object is written into the session file verbatim.
    expect(delegations).toHaveLength(1);
    expect(delegations[0].report.length).toBeLessThanOrEqual(4_000);
    // The model's own copy keeps its own, larger budget, and the FULL report is
    // still on the record — the clamp is the persisted half only.
    expect(handle.ctx.runtimeSubagents.registry.all()[0]?.result?.report.length).toBeGreaterThan(
      4_000
    );
  });

  it('subagent-core-13 · a pin past the provider cap is refused, readably', async () => {
    for (let index = 1; index <= 9; index += 1) {
      await writeDefinition(`a${index}`, [
        '---',
        `name: a${index}`,
        `description: pinned to provider ${index}`,
        'tools: [Read]',
        `model: p${index}/m`,
        '---',
        '',
        'Work.',
      ]);
    }
    const results: { tool: string; text: string }[] = [];
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall(SUBAGENT_TOOL_NAME, { agent: 'a9', task: 'x' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('understood'),
      ],
      delegate: [],
    });
    await handle.run({
      prompt: 'go',
      onEvent: (event) => {
        if (event.type !== 'tool_execution_end') return;
        results.push({
          tool: event.toolName,
          text: JSON.stringify((event.result as { content?: unknown }).content),
        });
      },
    });
    const task = results.find((entry) => entry.tool === SUBAGENT_TOOL_NAME);
    expect(task?.text).toContain('limit');
    expect(task?.text).toContain('p9/m');
    // Refused, not quietly started on some other provider's model.
    expect(handle.ctx.runtimeSubagents.registry.all()).toHaveLength(0);
  });

  it('subagent-data-10 · a document that will not load is logged and named in the failure', async () => {
    await writeDefinition('broken', ['---', 'name: broken', 'tools: [Read]', '---', '', 'Body.']);
    const results: string[] = [];
    const handle = await build({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall(SUBAGENT_TOOL_NAME, { agent: 'broken', task: 'x' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('understood'),
      ],
      delegate: [],
    });
    await handle.run({
      prompt: 'go',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end')
          results.push(JSON.stringify((event.result as { content?: unknown }).content));
      },
    });
    expect(logged.some((line) => line.includes('parse_failed') && line.includes('broken.md'))).toBe(
      true
    );
    // And the model is told why its delegate is missing from the menu, instead
    // of just "unknown subagent", which reads as a typo.
    expect(results.join('\n')).toContain('failed to load');
  });

  it('subagent-data-16 · a running delegate reports the turns it has spent', async () => {
    const turnsWhileRunning: number[] = [];
    const handle = await build({
      parent: delegateOnce('explorer'),
      delegate: [
        () =>
          fauxAssistantMessage([fauxToolCall('read', { path: join(workspace, 'nope.txt') })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('EXPLORER-REPORT: done'),
      ],
    });
    handle.ctx.runtimeSubagents.onEvent((envelope) => {
      if (envelope.event.type !== 'turn_start') return;
      const record = handle.ctx.runtimeSubagents.registry.get(envelope.delegationId);
      if (record) turnsWhileRunning.push(record.turns);
    });
    await handle.run({ prompt: 'go' });
    // `turn_start` was never forwarded, so `noteActivity`'s arm for it was dead
    // code and the heartbeat's `if (turns > 0)` swallowed the column for the
    // whole run — the one number that answers "is it stuck?".
    expect(turnsWhileRunning.length).toBeGreaterThan(0);
    expect(Math.max(...turnsWhileRunning)).toBeGreaterThanOrEqual(1);
  });

  it('subagent-data-03 · delegated cost reaches usage.updated and the session total', async () => {
    const payloads: Record<string, unknown>[] = [];
    const handle = await build({
      parent: delegateOnce('explorer'),
      delegate: [() => fauxAssistantMessage('EXPLORER-REPORT: done')],
    });
    handle.events.subscribe((event) => {
      if (event.type === 'usage.updated')
        payloads.push((event as { payload: Record<string, unknown> }).payload);
    });
    const result = await handle.run({ prompt: 'go' });

    expect(result.subagentUsage).toBeDefined();
    const withDelegated = payloads.filter((payload) => payload.delegated !== undefined);
    expect(withDelegated.length).toBeGreaterThan(0);
    const last = withDelegated.at(-1) as {
      delegated: { totalTokens: number };
      session: { totalTokens: number; toolResults: number };
    };
    expect(last.delegated.totalTokens).toBe(result.subagentUsage?.totalTokens);
    // The contract's "session and turn totals include delegated calls": the conversation total is the
    // sum, and `delegated` says how much of it was delegated.
    expect(last.session.totalTokens).toBeGreaterThanOrEqual(last.delegated.totalTokens);
    expect(last.session.toolResults).toBe(1);
  });
});
