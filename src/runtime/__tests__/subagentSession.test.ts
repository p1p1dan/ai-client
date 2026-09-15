/**
 * P5-2-4 gate — SA14 (attribution and parent isolation), SA15 (usage and report
 * limits) and SA16 (save, reopen, interrupted).
 *
 * The property under every case here is the same one: a delegate's transcript
 * is SAVED IN FULL and reaches the parent's model NEVER. Get that backwards in
 * either direction and nothing throws — the session just quietly costs twice
 * the context it should, or quietly loses the work a delegate did.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AssistantMessage,
  Context as PiContext,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInternalMessage } from '../../shared/internalMessage.ts';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import {
  readSubagentHistory,
  SUBAGENT_ENTRY,
  subagentHistoryUsage,
  wireStatus,
} from '../plugins/subagent/records.ts';
import { MAX_SUBAGENT_REPORT_CHARS, type SubagentRunStatus } from '../plugins/subagent/run.ts';

type ScriptStep = () => AssistantMessage | Promise<AssistantMessage>;

function scriptedProvider(script: { parent: ScriptStep[]; delegate: ScriptStep[] }) {
  const handle = fauxProvider({ provider: 'faux', models: [{ id: 'faux-p524', name: 'P524' }] });
  let parentIndex = 0;
  let delegateIndex = 0;
  const route = async (context: PiContext) => {
    const isDelegate = /You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? '');
    const steps = isDelegate ? script.delegate : script.parent;
    const index = isDelegate ? delegateIndex++ : parentIndex++;
    const step = steps[Math.min(index, steps.length - 1)];
    if (!step) throw new Error('no scripted response');
    return step();
  };
  handle.setResponses(Array.from({ length: 64 }, () => route));
  return handle;
}

describe('SA14 / SA15 / SA16 · delegate records, usage and reopening', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'p524-'));
  });
  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  async function build(
    script: Parameters<typeof scriptedProvider>[0],
    events?: RuntimeEventDraft[]
  ): Promise<RuntimeHandle> {
    const handle = scriptedProvider(script);
    runtime = await createRuntime({
      env: {},
      providers: [handle.provider],
      tools: { cwd: workspace },
      permissions: { gear: 'auto' },
      subagents: { home: join(workspace, 'home') },
      session: { cwd: workspace, mode: 'create', file: join(workspace, 'session.jsonl') },
      loop: { singleTurn: false },
    });
    if (events) runtime.events.subscribe((event) => events.push(event));
    return runtime;
  }

  const oneDelegation = (report: string) => ({
    parent: [
      () =>
        fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'look' })], {
          stopReason: 'toolUse',
        }),
      () => fauxAssistantMessage('waiting'),
      () => fauxAssistantMessage('integrated'),
    ],
    delegate: [() => fauxAssistantMessage(report)],
  });

  it('keeps the delegate out of the parent model context and in the session file', async () => {
    const handle = await build(oneDelegation('DELEGATE-ONLY-TEXT'));
    await handle.run({ prompt: 'go' });
    await handle.session?.flush();

    // The parent's model context: the report reaches it only through the
    // runtime's resume prompt, never as a delegate message of its own.
    const snapshot = handle.session?.snapshot();
    const roles = snapshot?.messages.map((message) => message.role) ?? [];
    expect(roles).not.toContain('custom');
    const assistantText = JSON.stringify(
      snapshot?.messages.filter((message) => message.role === 'assistant')
    );
    expect(assistantText).not.toContain('DELEGATE-ONLY-TEXT');

    // The session FILE has it, attributed.
    const raw = await readFile(join(workspace, 'session.jsonl'), 'utf8');
    expect(raw).toContain(SUBAGENT_ENTRY);
    expect(raw).toContain('DELEGATE-ONLY-TEXT');
  });

  it('hands the report back to the model without drawing a user bubble for it', async () => {
    // The auto-resume feeds the report to the parent through `agent.prompt`,
    // and pi wraps any prompt as `role: 'user'`. Unmarked, that is
    // indistinguishable from typing: the projector drew a bubble the person
    // never wrote, stamped with the attemptId and attachments of the send they
    // DID write, and the session file kept it as the newest user message.
    const events: RuntimeEventDraft[] = [];
    const handle = await build(oneDelegation('REPORT-FED-BACK-TO-PARENT'), events);
    await handle.run({ prompt: 'go', attemptId: 'attempt-1' });
    await handle.session?.flush();

    const userStarts = events.filter(
      (event) => event.type === 'message.started' && event.payload.role === 'user'
    );
    // Exactly one: the send the user actually made.
    expect(userStarts).toHaveLength(1);
    expect(userStarts[0].payload).toMatchObject({ attemptId: 'attempt-1' });
    // And no part of the report reached the message channel at all.
    const messageEvents = events.filter((event) => event.type.startsWith('message.'));
    expect(JSON.stringify(messageEvents)).not.toContain('REPORT-FED-BACK-TO-PARENT');

    // The model DID get it: that is the entire point of feeding it back.
    const messages = handle.session?.snapshot().messages ?? [];
    const users = messages.filter((message) => message.role === 'user');
    expect(users).toHaveLength(2);
    expect(JSON.stringify(users[1])).toContain('REPORT-FED-BACK-TO-PARENT');
    // Kept on disk WITH its mark, because the reopen is where it used to be
    // mistaken for the latest user task.
    expect(isInternalMessage(users[0])).toBe(false);
    expect(isInternalMessage(users[1])).toBe(true);
  });

  it('does not restore the internal report as a user message when the session reopens', async () => {
    const handle = await build(oneDelegation('REPORT-ON-RELOAD'));
    await handle.run({ prompt: 'the real question', attemptId: 'attempt-1' });
    await handle.session?.flush();

    const history = handle.session?.history() ?? [];
    const users = history.filter((message) => message.role === 'user');
    expect(users).toHaveLength(1);
    expect(JSON.stringify(users)).toContain('the real question');
    // A second user bubble here is the reopened-session form of the same bug:
    // the report comes back as the newest thing the user appears to have asked.
    expect(JSON.stringify(history)).not.toContain('REPORT-ON-RELOAD');
  });

  it('rebuilds the delegation from the saved records, report and all', async () => {
    const handle = await build(oneDelegation('FULL-REPORT-BODY'));
    await handle.run({ prompt: 'go' });
    await handle.session?.flush();

    const history = readSubagentHistory(handle.session?.snapshot().entries ?? []);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      agentName: 'explorer',
      status: 'completed',
      task: 'look',
    });
    expect(history[0].report).toContain('FULL-REPORT-BODY');
    expect(history[0].model?.provider).toBe('faux');
    expect(history[0].parentToolCallId).toBeTruthy();
    expect(history[0].runId).toBeTruthy();
    // The delegate's own messages survive for an on-demand history read.
    expect(history[0].messages.length).toBeGreaterThan(0);
  });

  it('bills the delegate once, and separately from the parent', async () => {
    const handle = await build(oneDelegation('report'));
    const result = await handle.run({ prompt: 'go' });
    await handle.session?.flush();

    expect(result.subagentUsage).toBeDefined();
    // The parent number is what ITS provider reported for ITS requests. Folding
    // the delegate in would make the session look like it is carrying context
    // it never loaded.
    expect(result.usage?.totalTokens).not.toBe(result.subagentUsage?.totalTokens);

    const history = readSubagentHistory(handle.session?.snapshot().entries ?? []);
    const fromRecords = subagentHistoryUsage(history);
    expect(fromRecords.usage?.totalTokens).toBe(result.subagentUsage?.totalTokens);
    expect(fromRecords.delegations).toBe(1);

    // Reading it again does not bill it again.
    expect(
      subagentHistoryUsage(readSubagentHistory(handle.session?.snapshot().entries ?? [])).usage
        ?.totalTokens
    ).toBe(fromRecords.usage?.totalTokens);
    // And the run-level accumulator was emptied when it was taken.
    expect(handle.ctx.runtimeSubagents.takeUsage()).toBeUndefined();
  });

  it('clamps an enormous report without losing the terminal status', async () => {
    const huge = 'x'.repeat(MAX_SUBAGENT_REPORT_CHARS * 2);
    const handle = await build(oneDelegation(huge));
    await handle.run({ prompt: 'go' });
    await handle.session?.flush();

    const record = handle.ctx.runtimeSubagents.registry.all()[0];
    expect(record.status).toBe('completed');
    expect(record.result?.report.length).toBeLessThanOrEqual(MAX_SUBAGENT_REPORT_CHARS);
    expect(record.result?.report).toContain('[subagent report truncated]');
    // Truncation is about size, not about losing the entry point: the record
    // still names the delegation, its status and its counters.
    const history = readSubagentHistory(handle.session?.snapshot().entries ?? []);
    expect(history[0].status).toBe('completed');
    expect(history[0].turns).toBeGreaterThan(0);
  });

  it('publishes a live lane on the event channel, terminal status included', async () => {
    const events: RuntimeEventDraft[] = [];
    const handle = await build(oneDelegation('report'), events);
    await handle.run({ prompt: 'go' });

    const activity = events.filter((event) => event.type === 'subagent.activity');
    const kinds = activity.map((event) => (event.payload as { kind: string }).kind);
    expect(kinds).toContain('started');
    expect(kinds).toContain('status');
    expect(kinds).toContain('report');
    const started = activity.find(
      (event) => (event.payload as { kind: string }).kind === 'started'
    );
    // Every activity lands on a delegation carrier, or the renderer cannot
    // decide which card it belongs to.
    expect((started?.payload as { parentToolCallId?: string }).parentToolCallId).toBeTruthy();
    expect((started?.payload as { agentId?: string }).agentId).toBeTruthy();
  });

  it('does not end the parent run on a delegate finishing', async () => {
    // SA14's other half. A delegate's own terminal events stay inside its
    // class; the parent's projector must see exactly one run end.
    const events: RuntimeEventDraft[] = [];
    const handle = await build(oneDelegation('report'), events);
    await handle.run({ prompt: 'go' });

    const idle = events.filter(
      (event) =>
        event.type === 'session.status' && (event.payload as { status?: string }).status === 'idle'
    );
    expect(idle).toHaveLength(1);
  });

  it('reports an unsettled delegation as interrupted, and replays nothing', async () => {
    // SA16. A hard exit leaves a start with no settlement. Reopening must say
    // so rather than showing it as still running or dropping it.
    const handle = await build(oneDelegation('report'));
    const session = handle.session;
    if (!session) throw new Error('no session');
    await session.appendEntry({
      type: 'custom',
      customType: SUBAGENT_ENTRY,
      data: {
        kind: 'started',
        delegationId: 'orphan',
        agentName: 'fixer',
        parentToolCallId: 'call-x',
        runId: 'run-x',
        task: 'a task nobody finished',
        model: { provider: 'faux', modelId: 'faux-p524' },
        startedAt: Date.now(),
      },
    });
    await session.flush();

    const history = readSubagentHistory(session.snapshot().entries);
    const orphan = history.find((entry) => entry.delegationId === 'orphan');
    expect(orphan?.status).toBe('interrupted');
    expect(orphan?.report).toBeUndefined();
    // Reopening starts nothing: the live registry knows nothing about it.
    expect(handle.ctx.runtimeSubagents.registry.has('orphan')).toBe(false);
  });
});

/**
 * T006 — cross-01/cross-02. A delegate with no pin of its own must inherit
 * what the PARENT RUN actually used, not the catalog's registration order and
 * not a config field nobody ever writes.
 */
describe("T006 · a delegate's model and thinking level follow the parent run", () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'p52-t006-'));
  });
  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  const oneDelegation = (report: string) => ({
    parent: [
      () =>
        fauxAssistantMessage([fauxToolCall('Task', { agent: 'explorer', task: 'look' })], {
          stopReason: 'toolUse',
        }),
      () => fauxAssistantMessage('waiting'),
      () => fauxAssistantMessage('integrated'),
    ],
    delegate: [() => fauxAssistantMessage(report)],
  });

  function router(
    script: { parent: (() => AssistantMessage)[]; delegate: (() => AssistantMessage)[] },
    onDelegateOptions?: (options: SimpleStreamOptions | undefined) => void
  ) {
    let parentIndex = 0;
    let delegateIndex = 0;
    return async (context: PiContext, options?: SimpleStreamOptions) => {
      const isDelegate = /You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? '');
      if (isDelegate) onDelegateOptions?.(options);
      const steps = isDelegate ? script.delegate : script.parent;
      const index = isDelegate ? delegateIndex++ : parentIndex++;
      const step = steps[Math.min(index, steps.length - 1)];
      if (!step) throw new Error('no scripted response');
      return step();
    };
  }

  it("cross-01: a delegate resolves to the parent's actual model, not the catalog's first entry", async () => {
    // Registration order makes `faux-a` the catalog default (`defaultRef()`).
    // The parent run explicitly picks `faux-b` — the second, non-default
    // entry — so a pass that fell back to `defaultRef()` would still name the
    // wrong model here.
    const handle = fauxProvider({
      provider: 'faux',
      models: [
        { id: 'faux-a', name: 'A' },
        { id: 'faux-b', name: 'B' },
      ],
    });
    const route = router(oneDelegation('done inheriting the model'));
    handle.setResponses(Array.from({ length: 8 }, () => route));
    runtime = await createRuntime({
      env: {},
      providers: [handle.provider],
      tools: { cwd: workspace },
      permissions: { gear: 'auto' },
      subagents: { home: join(workspace, 'home') },
      session: { cwd: workspace, mode: 'create', file: join(workspace, 'session.jsonl') },
      loop: { singleTurn: false },
    });
    await runtime.run({ prompt: 'go', model: { provider: 'faux', id: 'faux-b' } });
    await runtime.session?.flush();

    const history = readSubagentHistory(runtime.session?.snapshot().entries ?? []);
    expect(history).toHaveLength(1);
    expect(history[0].model).toEqual({ provider: 'faux', modelId: 'faux-b' });
  });

  it('cross-02: a delegate resolves to the parent effort, not a hardcoded medium', async () => {
    const handle = fauxProvider({ provider: 'faux', models: [{ id: 'faux-p524', name: 'P524' }] });
    let delegateReasoning: SimpleStreamOptions['reasoning'] | 'UNSET' = 'UNSET';
    const route = router(oneDelegation('done inheriting the effort'), (options) => {
      if (delegateReasoning === 'UNSET') delegateReasoning = options?.reasoning;
    });
    handle.setResponses(Array.from({ length: 8 }, () => route));
    runtime = await createRuntime({
      env: {},
      providers: [handle.provider],
      tools: { cwd: workspace },
      permissions: { gear: 'auto' },
      subagents: { home: join(workspace, 'home') },
      loop: { singleTurn: false },
    });
    await runtime.run({ prompt: 'go', thinkingLevel: 'off' });

    // pi-agent-core turns 'off' into an ABSENT `reasoning` option; 'medium'
    // (what the dead `SubagentConfig.thinkingLevel` fallback used to produce)
    // would arrive as the literal string 'medium', which is truthy and would
    // fail this assertion instead of just being the wrong level.
    expect(delegateReasoning).toBeUndefined();
  });

  it("cross-01 guard: a definition's own model pin still wins over the parent's model", async () => {
    const handle = fauxProvider({
      provider: 'faux',
      models: [
        { id: 'faux-a', name: 'A' },
        { id: 'faux-b', name: 'B' },
      ],
    });
    const route = router({
      parent: [
        () =>
          fauxAssistantMessage([fauxToolCall('Task', { agent: 'pinned', task: 'look' })], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('waiting'),
        () => fauxAssistantMessage('integrated'),
      ],
      delegate: [() => fauxAssistantMessage('done, pinned')],
    });
    handle.setResponses(Array.from({ length: 8 }, () => route));
    const definitionsDir = join(workspace, 'home', '.agents', 'subagents');
    await mkdir(definitionsDir, { recursive: true });
    // Pins `faux-a` while the parent run below uses `faux-b`: if the pin ever
    // lost to the parent ref, this delegation would come back on `faux-b`.
    await writeFile(
      join(definitionsDir, 'pinned.md'),
      [
        '---',
        'name: pinned',
        'description: pins its own model regardless of the parent',
        'tools: [Read]',
        'model: faux/faux-a',
        '---',
        '',
        'Report back a short summary.',
      ].join('\n'),
      'utf8'
    );
    runtime = await createRuntime({
      env: {},
      providers: [handle.provider],
      tools: { cwd: workspace },
      permissions: { gear: 'auto' },
      subagents: { home: join(workspace, 'home') },
      session: { cwd: workspace, mode: 'create', file: join(workspace, 'session.jsonl') },
      loop: { singleTurn: false },
    });
    await runtime.run({ prompt: 'go', model: { provider: 'faux', id: 'faux-b' } });
    await runtime.session?.flush();

    const history = readSubagentHistory(runtime.session?.snapshot().entries ?? []);
    expect(history).toHaveLength(1);
    expect(history[0].model).toEqual({ provider: 'faux', modelId: 'faux-a' });
  });
});

describe('the wire status vocabulary keeps the distinctions the reader needs', () => {
  it('maps our lifecycle onto the wire without collapsing stopped or truncated', () => {
    const cases: [SubagentRunStatus, string][] = [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['aborted', 'cancelled'],
      ['stopped', 'stopped'],
      ['truncated', 'truncated'],
      ['timed_out', 'failed'],
    ];
    for (const [ours, wire] of cases) expect(wireStatus(ours), ours).toBe(wire);
  });
});
