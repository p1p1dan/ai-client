/**
 * The subagent tool loop (2026-09-24 field report, GLM-5.2 on v1.0.2).
 *
 * The measured failure: ONE assistant message carrying 5,709 tool calls. The
 * first 47 were a mixed bag (edits, a `git add`, a `Task`, a `TaskWait`, a
 * `TaskList`, reads); from there on it was `TaskList {}` → `TaskStop
 * {"delegationIds":[]}` → `TaskWait {"delegationIds":[],"mode":"any",
 * "timeoutSeconds":3}`, byte for byte, ~1,900 times. None of it ran — pi runs
 * tool calls only once a message is complete — and the stream went on for
 * nineteen minutes until the user pressed Stop, with every row drawn as it was
 * dictated. The turn ceiling counts replies, so it never saw any of it.
 *
 * The degenerate replies here are SYNTHETIC reproductions of that shape; no
 * part of the user's session is in this repository.
 *
 * What is pinned, by layer:
 *
 * - the guard's own rules (pure): what "the same call" means, where it trips,
 *   and that a real fan-out never does;
 * - form B end to end: the reply is cut WHILE it streams, the provider request
 *   is cancelled, nothing in it runs, no further request is made, the user gets
 *   a failure they can continue from, and evidence lands in the session file;
 * - form A end to end: replies made of nothing but idle delegation calls are
 *   refused, then wrapped up;
 * - the tool answers that fed the loop: an id-less `TaskWait` delivers what is
 *   owed, `TaskStop` shows what it stopped and cannot hang, `TaskList` says
 *   where each report stands;
 * - a reopened session remembers its delegations;
 * - and the normal flows — delegate, work, collect; a parallel fan-out; a wait
 *   by id — are untouched.
 */

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  Context as PiContext,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { LOOP_GUARD_CUSTOM_TYPE } from '../../shared/types/sessionHistory.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import type { RuntimeRunResult } from '../contracts.ts';
import { LOOP_GUARD_ENV } from '../flags.ts';
import {
  DELEGATION_TOOL_NAMES,
  delegationCallSignature,
  isIdleDelegationResult,
  MAX_DELEGATION_CALLS_PER_REPLY,
  MAX_IDENTICAL_DELEGATION_CALLS_PER_REPLY,
  MAX_IDLE_DELEGATION_REPLIES,
  ReplyRepetitionTracker,
  TOOL_CALL_REPETITION,
} from '../plugins/agent-loop/delegationLoopGuard.ts';
import { SUBAGENT_TOOL_NAMES } from '../plugins/subagent/index.ts';
import { SUBAGENT_ENTRY } from '../plugins/subagent/records.ts';
import { neverAsked } from './fixtures/approval.ts';

type ScriptStep = (
  context: PiContext,
  options?: SimpleStreamOptions
) => AssistantMessage | Promise<AssistantMessage>;

interface Script {
  parent: ScriptStep[];
  delegate?: ScriptStep[];
}

const TIMED_OUT = Symbol('timed out');
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms)),
  ]);
}

/** The mixed first part of the measured reply, rebuilt from invented calls. */
function mixedPrefix(): AssistantMessage['content'] {
  const calls = [
    fauxToolCall('read', { path: 'notes.txt' }, { id: 'p-read' }),
    fauxToolCall('write', { path: 'WRITE-SHOULD-NOT-EXIST.txt', content: 'x' }, { id: 'p-write' }),
    fauxToolCall('bash', { command: 'touch BASH-SHOULD-NOT-RUN' }, { id: 'p-bash' }),
    fauxToolCall(
      'edit',
      { path: 'notes.txt', oldString: 'notes', newString: 'EDITED' },
      { id: 'p-edit' }
    ),
    fauxToolCall('Task', { agent: 'code-reviewer', task: 'review the change' }, { id: 'p-task' }),
    fauxToolCall('TaskWait', { delegationIds: ['d-unknown'] }, { id: 'p-wait' }),
    fauxToolCall('TaskList', {}, { id: 'p-list' }),
    fauxToolCall('grep', { pattern: 'TODO' }, { id: 'p-grep' }),
  ];
  for (let index = calls.length; index < 47; index += 1)
    calls.push(fauxToolCall('read', { path: `f${index}.txt` }, { id: `p-read-${index}` }));
  return calls;
}

/** The periodic part: the same three calls, verbatim, `cycles` times. */
function periodicTriples(cycles: number): AssistantMessage['content'] {
  return Array.from({ length: cycles }, (_, cycle) => [
    fauxToolCall('TaskList', {}, { id: `l-${cycle}` }),
    fauxToolCall('TaskStop', { delegationIds: [] }, { id: `s-${cycle}` }),
    fauxToolCall(
      'TaskWait',
      { delegationIds: [], mode: 'any', timeoutSeconds: 3 },
      { id: `w-${cycle}` }
    ),
  ]).flat();
}

function degenerateReply(cycles: number): AssistantMessage {
  return fauxAssistantMessage(
    [fauxText('Let me check on the reviewer.'), ...mixedPrefix(), ...periodicTriples(cycles)],
    { stopReason: 'toolUse' }
  );
}

const idleTriple = (tag: string) =>
  fauxAssistantMessage(
    [
      fauxToolCall('TaskList', {}, { id: `${tag}-list` }),
      fauxToolCall('TaskStop', { delegationIds: [] }, { id: `${tag}-stop` }),
      fauxToolCall(
        'TaskWait',
        { delegationIds: [], mode: 'any', timeoutSeconds: 3 },
        { id: `${tag}-wait` }
      ),
    ],
    { stopReason: 'toolUse' }
  );

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(calls, { stopReason: 'toolUse' });

function contextText(context: PiContext | undefined): string {
  return JSON.stringify(context?.messages ?? []);
}

function lastMessageText(context: PiContext | undefined): string {
  const content = (context?.messages.at(-1) as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .map((block) =>
      (block as { type?: string }).type === 'text' ? (block as { text: string }).text : ''
    )
    .join('');
}

describe('the loop guard rules', () => {
  it('knows the same family the subagent plugin registers', () => {
    expect([...DELEGATION_TOOL_NAMES].sort()).toEqual([...SUBAGENT_TOOL_NAMES].sort());
  });

  it('treats an empty id list as no ids, and ignores how long or how a wait waits', () => {
    expect(delegationCallSignature('TaskStop', { delegationIds: [] })).toBe(
      delegationCallSignature('TaskStop', {})
    );
    expect(
      delegationCallSignature('TaskWait', { delegationIds: [], mode: 'any', timeoutSeconds: 3 })
    ).toBe(delegationCallSignature('TaskWait', { timeoutSeconds: 600 }));
    expect(delegationCallSignature('TaskWait', { delegationIds: ['b', 'a', 'a'] })).toBe(
      delegationCallSignature('TaskWait', { delegationIds: ['a', 'b'] })
    );
    // A different target is a different call.
    expect(delegationCallSignature('TaskWait', { delegationIds: ['a'] })).not.toBe(
      delegationCallSignature('TaskWait', {})
    );
  });

  it('tells two briefs apart, and ignores the display label', () => {
    expect(
      delegationCallSignature('Task', { agent: 'explorer', task: 'a', description: 'one' })
    ).toBe(delegationCallSignature('Task', { agent: 'explorer', task: 'a', description: 'two' }));
    expect(delegationCallSignature('Task', { agent: 'explorer', task: 'a' })).not.toBe(
      delegationCallSignature('Task', { agent: 'explorer', task: 'b' })
    );
  });

  it('trips on the measured shape within the first cycles of the period', () => {
    const content = [...mixedPrefix(), ...periodicTriples(1_900)];
    const tracker = new ReplyRepetitionTracker();
    let verdict: ReturnType<ReplyRepetitionTracker['inspect']>;
    // Fed the way a stream proves blocks complete: each new block closes the
    // one before it.
    for (let index = 1; index <= content.length && !verdict; index += 1)
      verdict = tracker.inspect(content.slice(0, index + 1), index - 1);
    expect(verdict).toBeDefined();
    expect(verdict?.rule).toBe('identical_call');
    expect(verdict?.signature).toBe('TaskList {}');
    expect(verdict?.occurrences).toBe(MAX_IDENTICAL_DELEGATION_CALLS_PER_REPLY);
    // "Within tens of calls", not thousands: the prefix plus two cycles.
    expect(verdict?.blockIndex).toBeLessThan(47 + 3 * 3);
  });

  it('never trips on a real fan-out and its wait', () => {
    const content = [
      ...Array.from({ length: 5 }, (_, index) =>
        fauxToolCall('Task', { agent: 'explorer', task: `direction ${index}` })
      ),
      fauxToolCall('TaskWait', {}),
      fauxToolCall('read', { path: 'a.ts' }),
    ];
    expect(new ReplyRepetitionTracker().inspect(content, content.length - 1)).toBeUndefined();
  });

  it('bounds a reply that varies its arguments to dodge the identical-call rule', () => {
    const content = Array.from({ length: MAX_DELEGATION_CALLS_PER_REPLY + 1 }, (_, index) =>
      fauxToolCall('TaskWait', { delegationIds: [`id-${index}`] })
    );
    const verdict = new ReplyRepetitionTracker().inspect(content, content.length - 1);
    expect(verdict?.rule).toBe('call_count');
    expect(verdict?.delegationCalls).toBe(MAX_DELEGATION_CALLS_PER_REPLY + 1);
  });

  it('does not judge the call still being written', () => {
    // Two briefs cut at the same point parse to the same prefix; judging the
    // last block before it is complete would call them identical.
    const partial = [
      fauxToolCall('Task', { agent: 'explorer' }),
      fauxToolCall('Task', { agent: 'explorer' }),
      fauxToolCall('Task', { agent: 'explorer' }),
    ];
    expect(new ReplyRepetitionTracker().inspect(partial, partial.length - 2)).toBeUndefined();
  });

  it('reads the idle mark only off the three control tools', () => {
    expect(isIdleDelegationResult({ toolName: 'TaskList', details: { idle: true } })).toBe(true);
    expect(isIdleDelegationResult({ toolName: 'TaskList', details: {} })).toBe(false);
    expect(isIdleDelegationResult({ toolName: 'read', details: { idle: true } })).toBe(false);
  });
});

describe('subagent tool loops, end to end', () => {
  let workspace: string;
  const runtimes: RuntimeHandle[] = [];
  let release: () => void = () => {};

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loop-guard-'));
    await writeFile(join(workspace, 'notes.txt'), 'notes\n', 'utf8');
    release = () => {};
  });

  afterEach(async () => {
    release();
    for (const runtime of runtimes.splice(0)) await runtime.dispose().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  });

  interface Built {
    runtime: RuntimeHandle;
    requests: { parent: PiContext[]; delegate: PiContext[] };
    signals: AbortSignal[];
    events: RuntimeEventDraft[];
  }

  async function build(
    script: Script,
    options: {
      session?: 'create' | 'resume';
      tokensPerSecond?: number;
      stopTimeoutMs?: number;
      /** `AICLIENT_RUNTIME_LOOP_GUARD` and friends; defaults to unset (guard on). */
      env?: NodeJS.ProcessEnv;
    } = {}
  ): Promise<Built> {
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'faux-loop', name: 'Loop guard' }],
      ...(options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond } : {}),
    });
    const requests = { parent: [] as PiContext[], delegate: [] as PiContext[] };
    const signals: AbortSignal[] = [];
    const route = async (context: PiContext, streamOptions?: SimpleStreamOptions) => {
      const isDelegate = /You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? '');
      const seen = isDelegate ? requests.delegate : requests.parent;
      const steps = isDelegate ? (script.delegate ?? []) : script.parent;
      const step = steps[seen.length];
      seen.push(context);
      if (!isDelegate && streamOptions?.signal) signals.push(streamOptions.signal);
      if (!step) throw new Error(`no scripted ${isDelegate ? 'delegate' : 'parent'} response`);
      return step(context, streamOptions);
    };
    faux.setResponses(Array.from({ length: 64 }, () => route));
    const runtime = await createRuntime({
      env: options.env ?? {},
      providers: [faux.provider],
      tools: { cwd: workspace },
      permissions: { approve: neverAsked, gear: 'auto' },
      subagents: {
        home: join(workspace, 'home'),
        ...(options.stopTimeoutMs ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
      },
      ...(options.session
        ? {
            session: {
              cwd: workspace,
              mode: options.session,
              file: join(workspace, 'session.jsonl'),
            },
          }
        : {}),
      loop: { singleTurn: false },
    });
    runtimes.push(runtime);
    const events: RuntimeEventDraft[] = [];
    runtime.events.subscribe((event) => events.push(event));
    return { runtime, requests, signals, events };
  }

  /** Every tool result the parent model was handed, in order. */
  function collectResults(into: { tool: string; text: string; details: unknown }[]) {
    return (event: AgentEvent) => {
      if (event.type !== 'tool_execution_end') return;
      const result = event.result as {
        content?: { type: string; text?: string }[];
        details?: unknown;
      };
      into.push({
        tool: event.toolName,
        text: (result?.content ?? []).map((block) => block.text ?? '').join(''),
        details: result?.details,
      });
    };
  }

  function loopGuardRecords(runtime: RuntimeHandle): Record<string, unknown>[] {
    return (runtime.session?.snapshot().entries ?? []).flatMap((entry) =>
      entry.type === 'custom' && entry.customType === LOOP_GUARD_CUSTOM_TYPE
        ? [entry.data as Record<string, unknown>]
        : []
    );
  }

  async function exists(path: string): Promise<boolean> {
    return access(path).then(
      () => true,
      () => false
    );
  }

  describe('form B · one reply that repeats itself', () => {
    it('cuts the reply while it streams, runs none of it, asks nothing more, and leaves a sendable session', async () => {
      const { runtime, requests, signals, events } = await build(
        {
          parent: [() => degenerateReply(600), () => fauxAssistantMessage('Back on track.')],
        },
        // Paced so "cut while streaming" is observable: the full reply is ~2,000
        // chunks, the cut lands well inside the first hundred.
        { session: 'create', tokensPerSecond: 4_000 }
      );
      const started: string[] = [];
      const result = (await within(
        runtime.run({
          prompt: 'review my change with a subagent',
          onEvent: (event) => {
            if (event.type === 'tool_execution_start') started.push(event.toolName);
          },
        }),
        10_000
      )) as RuntimeRunResult | typeof TIMED_OUT;
      expect(result).not.toBe(TIMED_OUT);
      const ended = result as RuntimeRunResult;

      // Ends as its own kind of failure, not as a provider cut or a crash.
      expect(ended.success).toBe(false);
      expect(ended.error?.code).toBe(TOOL_CALL_REPETITION);
      expect(ended.error?.message).toContain('TaskList {}');
      expect(ended.error?.message).toContain('ran none of its tool calls');
      // One request, and the guard cancelled it: no resume, no wrap-up, no retry.
      expect(requests.parent).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      // Nothing in the degenerate reply ran — not the delegation, not the write,
      // not the shell command, not the edit.
      expect(started).toEqual([]);
      expect(requests.delegate).toHaveLength(0);
      expect(await exists(join(workspace, 'WRITE-SHOULD-NOT-EXIST.txt'))).toBe(false);
      expect(await exists(join(workspace, 'BASH-SHOULD-NOT-RUN'))).toBe(false);
      expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('notes\n');

      // The screen: rows stopped appearing at the cut, every row it drew has a
      // terminal, and the turn ended failed-then-idle.
      const rows = events.filter((event) => event.type === 'tool.started');
      const total = 47 + 600 * 3;
      expect(rows.length).toBeLessThan(80);
      expect(rows.length).toBeLessThan(total);
      const settled = new Set(
        events
          .filter((event) => event.type === 'tool.completed')
          .map((event) => (event.payload as { toolCallId: string }).toolCallId)
      );
      for (const row of rows)
        expect(settled.has((row.payload as { toolCallId: string }).toolCallId)).toBe(true);
      const failed = events.find((event) => event.type === 'session.failed');
      expect(failed?.payload).toMatchObject({ errorCode: TOOL_CALL_REPETITION });
      // This payload is what Main writes to main.log (`turn failed: <code>: <error>`),
      // so the sentence itself carries the repeated call, the count and the run.
      const failedText = (failed?.payload as { error?: string } | undefined)?.error ?? '';
      expect(failedText).toContain('TaskList {}');
      expect(failedText).toMatch(/with \d+ tool calls in that reply/);
      expect(failedText).toContain(ended.runId);
      const lastStatus = events.filter((event) => event.type === 'session.status').at(-1);
      expect(lastStatus?.payload).toMatchObject({ status: 'idle' });

      // The file keeps the cut reply as a record, bounded at the cut, and keeps
      // it OUT of what the model is sent next.
      await runtime.session?.flush();
      const snapshot = runtime.session?.snapshot();
      const stored = (snapshot?.entries ?? [])
        .flatMap((entry) => (entry.type === 'message' ? [entry.message] : []))
        .filter((message) => message.role === 'assistant')
        .at(-1) as AssistantMessage | undefined;
      expect(stored?.stopReason).toBe('error');
      const storedCalls = (stored?.content ?? []).filter((block) => block.type === 'toolCall');
      expect(storedCalls.length).toBeLessThan(60);
      expect(JSON.stringify(stored)).not.toContain('partialArgs');
      expect(JSON.stringify(snapshot?.messages)).not.toContain('TaskStop');

      // Default-on evidence: rule, run, the repeated call and the count.
      const [record] = loopGuardRecords(runtime);
      expect(record).toMatchObject({
        rule: 'identical_call',
        runId: ended.runId,
        signature: 'TaskList {}',
        occurrences: MAX_IDENTICAL_DELEGATION_CALLS_PER_REPLY,
      });
      expect(record?.toolCalls).toBeGreaterThanOrEqual(47);
      expect(record?.toolCalls).toBeLessThan(60);
      // Bookkeeping, like the run-stop record: no system row, no tree node.
      const guardEntry = (runtime.session?.snapshot().entries ?? []).find(
        (entry) => entry.type === 'custom' && entry.customType === LOOP_GUARD_CUSTOM_TYPE
      );
      expect(events.some((event) => event.type === 'custom.entry')).toBe(false);
      expect(runtime.session?.tree().nodes.map((node) => node.id)).not.toContain(guardEntry?.id);

      // And the session is usable: the next message runs normally, without the
      // degenerate reply in its context.
      const next = await runtime.run({ prompt: 'continue' });
      expect(next.success).toBe(true);
      expect(next.text).toContain('Back on track.');
      expect(contextText(requests.parent[1])).not.toContain('TaskStop');
    }, 20_000);

    it('cuts a reply that only finishes repeating at its very end, and runs none of it', async () => {
      // Short enough to arrive whole: the third identical call is the last
      // block, so only the end of the stream proves it complete.
      const { runtime, requests } = await build({
        parent: [
          () =>
            toolUse(
              fauxToolCall('read', { path: 'notes.txt' }, { id: 'r1' }),
              fauxToolCall('TaskList', {}, { id: 'l1' }),
              fauxToolCall('TaskList', {}, { id: 'l2' }),
              fauxToolCall('TaskList', {}, { id: 'l3' })
            ),
          () => fauxAssistantMessage('SHOULD NOT HAPPEN'),
        ],
      });
      const started: string[] = [];
      const result = await runtime.run({
        prompt: 'go',
        onEvent: (event) => {
          if (event.type === 'tool_execution_start') started.push(event.toolName);
        },
      });
      expect(result.error?.code).toBe(TOOL_CALL_REPETITION);
      expect(started).toEqual([]);
      expect(requests.parent).toHaveLength(1);
    });

    it(`runs the same reply to completion, uncut, with ${LOOP_GUARD_ENV}=0`, async () => {
      // Same shape as the test above — the third identical `TaskList {}` is
      // the reply's last block — but with the guard's kill switch set. Every
      // call must now actually run instead of being cut mid-stream.
      const { runtime, requests } = await build(
        {
          parent: [
            () =>
              toolUse(
                fauxToolCall('read', { path: 'notes.txt' }, { id: 'r1' }),
                fauxToolCall('TaskList', {}, { id: 'l1' }),
                fauxToolCall('TaskList', {}, { id: 'l2' }),
                fauxToolCall('TaskList', {}, { id: 'l3' })
              ),
            () => fauxAssistantMessage('ran to completion, never cut'),
          ],
        },
        { env: { [LOOP_GUARD_ENV]: '0' } }
      );
      const results: { tool: string; text: string; details: unknown }[] = [];
      const result = await runtime.run({ prompt: 'go', onEvent: collectResults(results) });
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.text).toContain('ran to completion, never cut');
      // All four calls ran, in one reply — the guard never aborted the stream.
      expect(results.map((entry) => entry.tool)).toEqual([
        'read',
        'TaskList',
        'TaskList',
        'TaskList',
      ]);
      expect(requests.parent).toHaveLength(2);
      // No forensic record either: nothing tripped.
      expect(loopGuardRecords(runtime)).toEqual([]);
    });
  });

  describe('form A · replies of nothing but idle delegation calls', () => {
    it('answers once, refuses after, and wraps the run up after two idle replies', async () => {
      const { runtime, requests } = await build(
        {
          parent: [
            () => toolUse(fauxToolCall('Task', { agent: 'explorer', task: 'look' }, { id: 't1' })),
            () => fauxAssistantMessage('waiting for the explorer'),
            // The report is delivered by the auto-resume; from here on nothing
            // is running and nothing is owed.
            () => idleTriple('a'),
            () => idleTriple('b'),
            () => fauxAssistantMessage('SUMMARY: the explorer found the entry point.'),
            () => fauxAssistantMessage('SHOULD NOT HAPPEN'),
          ],
          delegate: [() => fauxAssistantMessage('EXPLORER-REPORT: entry point is main.ts')],
        },
        { session: 'create' }
      );
      const results: { tool: string; text: string; details: unknown }[] = [];
      const result = await runtime.run({ prompt: 'find it', onEvent: collectResults(results) });

      // Task + idle turn + resume triple + second triple + wrap-up.
      expect(requests.parent).toHaveLength(5);
      const wrapUp = lastMessageText(requests.parent[4]);
      expect(wrapUp).toContain('kept calling TaskList, TaskStop or TaskWait');
      expect(wrapUp).toContain('do not call any tool');
      expect(result.success).toBe(true);
      expect(result.text).toContain('SUMMARY');
      expect(result.text).not.toContain('SHOULD NOT HAPPEN');
      // Not a turn ceiling, so not drawn as one.
      expect(result.stopCause).toBeUndefined();

      const control = results.filter((entry) => entry.tool !== 'Task');
      expect(control).toHaveLength(6);
      // The first idle call gets the full answer, with the ids and the stop.
      expect(control[0]?.tool).toBe('TaskList');
      expect(control[0]?.text).toContain('report already delivered to you');
      expect(control[0]?.text).toContain('Nothing is left to wait for');
      expect(control[0]?.text).toContain('Do not call TaskWait, TaskStop or TaskList');
      // Everything after it is refused with the same instruction.
      for (const entry of control.slice(1)) {
        expect(entry.text.startsWith('Refused:')).toBe(true);
        expect(entry.text).toContain('Nothing is left to wait for');
        expect(isIdleDelegationResult({ toolName: entry.tool, details: entry.details })).toBe(true);
      }
      // The words that read as "try another call" are gone.
      for (const entry of control) expect(entry.text).not.toMatch(/matching/i);

      const [record] = loopGuardRecords(runtime);
      expect(record).toMatchObject({ rule: 'idle_replies', replies: MAX_IDLE_DELEGATION_REPLIES });
      expect(record?.calls).toEqual(['TaskList {}', 'TaskStop {}', 'TaskWait {}']);
    });

    it(`never refuses idle calls or forces a wrap-up with ${LOOP_GUARD_ENV}=0`, async () => {
      // Same idle-triple shape as the test above, run three times over (past
      // MAX_IDLE_DELEGATION_REPLIES) instead of two: with the switch off,
      // nothing should ever refuse and nothing should force the model to stop
      // — it has to end the run on its own, by finally replying with no tool
      // calls at all.
      const { runtime, requests } = await build(
        {
          parent: [
            () => toolUse(fauxToolCall('Task', { agent: 'explorer', task: 'look' }, { id: 't1' })),
            () => fauxAssistantMessage('waiting for the explorer'),
            () => idleTriple('a'),
            () => idleTriple('b'),
            () => idleTriple('c'),
            () => fauxAssistantMessage('finished on its own, never wrapped up'),
          ],
          delegate: [() => fauxAssistantMessage('EXPLORER-REPORT: entry point is main.ts')],
        },
        { session: 'create', env: { [LOOP_GUARD_ENV]: '0' } }
      );
      const results: { tool: string; text: string; details: unknown }[] = [];
      const result = await runtime.run({ prompt: 'find it', onEvent: collectResults(results) });

      expect(result.success).toBe(true);
      expect(result.text).toContain('finished on its own, never wrapped up');
      // Not a forced wrap-up: the model reached its own stop, so no
      // `stopCause` and none of the wrap-up instruction text anywhere.
      expect(result.stopCause).toBeUndefined();
      const control = results.filter((entry) => entry.tool !== 'Task');
      expect(control.length).toBeGreaterThan(0);
      for (const entry of control) {
        expect(entry.text.startsWith('Refused:')).toBe(false);
        expect((entry.details as { refused?: boolean } | undefined)?.refused).toBeUndefined();
      }
      for (const context of requests.parent)
        expect(lastMessageText(context)).not.toContain(
          'kept calling TaskList, TaskStop or TaskWait'
        );
      // Nine idle control calls (three triples), every one of them let through.
      expect(control).toHaveLength(9);
      expect(requests.parent).toHaveLength(6);
      // No forensic record: neither guard ever tripped.
      expect(loopGuardRecords(runtime)).toEqual([]);
    });

    it('does not count an idle call as a loop when the model then does real work', async () => {
      const { runtime, requests } = await build({
        parent: [
          () => toolUse(fauxToolCall('TaskList', {}, { id: 'l1' })),
          () => toolUse(fauxToolCall('read', { path: 'notes.txt' }, { id: 'r1' })),
          () => toolUse(fauxToolCall('TaskWait', {}, { id: 'w1' })),
          () => toolUse(fauxToolCall('read', { path: 'notes.txt' }, { id: 'r2' })),
          () => fauxAssistantMessage('done on my own'),
        ],
      });
      const result = await runtime.run({ prompt: 'go' });
      expect(result.success).toBe(true);
      expect(result.text).toContain('done on my own');
      expect(requests.parent).toHaveLength(5);
    });
  });

  describe('the tool answers', () => {
    it('hands a report that settled between runs to the next run’s id-less TaskWait', async () => {
      // The interjection fix leaves delegates running across runs. One that
      // finishes in the gap used to leave the next run in exactly the state
      // the loop was measured in: an id-less TaskWait said "No subagents are
      // currently running." while the report was still owed.
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let parentIdle = false;
      const { runtime } = await build(
        {
          parent: [
            () =>
              toolUse(fauxToolCall('Task', { agent: 'explorer', task: 'long job' }, { id: 't1' })),
            () => {
              parentIdle = true;
              return fauxAssistantMessage('started it');
            },
            () => toolUse(fauxToolCall('TaskWait', {}, { id: 'w1' })),
            () => fauxAssistantMessage('integrated'),
            () => fauxAssistantMessage('SHOULD NOT HAPPEN: delivered twice'),
          ],
          delegate: [
            async () => {
              await gate;
              return fauxAssistantMessage('LATE-REPORT: found it');
            },
          ],
        },
        { session: 'create' }
      );
      const first = runtime.run({ prompt: 'find it' });
      await vi.waitFor(() => expect(parentIdle).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 30));
      runtime.loop.interject();
      expect((await first).stopCause).toBe('interjected');
      release();
      await vi.waitFor(() =>
        expect(runtime.ctx.runtimeSubagents.registry.undelivered()).toHaveLength(1)
      );

      const results: { tool: string; text: string; details: unknown }[] = [];
      const second = await runtime.run({
        prompt: 'what did it find?',
        onEvent: collectResults(results),
      });
      const wait = results.find((entry) => entry.tool === 'TaskWait');
      expect(wait?.text).toContain('LATE-REPORT: found it');
      expect(wait?.text).not.toContain('No subagents are currently running');
      expect(second.text).toContain('integrated');
      expect(second.text).not.toContain('SHOULD NOT HAPPEN');
    });

    it('shows TaskStop’s caller what the stopped delegate had produced', async () => {
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let delegateTurn = 0;
      const { runtime } = await build({
        parent: [
          () => toolUse(fauxToolCall('Task', { agent: 'explorer', task: 'survey' }, { id: 't1' })),
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 120));
            return toolUse(fauxToolCall('TaskStop', {}, { id: 's1' }));
          },
          () => fauxAssistantMessage('stopped it'),
          () => fauxAssistantMessage('SHOULD NOT HAPPEN: delivered again'),
        ],
        delegate: [
          () => {
            delegateTurn += 1;
            return fauxAssistantMessage(
              [
                fauxText('PARTIAL-FINDING: notes.txt exists'),
                fauxToolCall('read', { path: 'notes.txt' }, { id: 'r1' }),
              ],
              { stopReason: 'toolUse' }
            );
          },
          async () => {
            delegateTurn += 1;
            await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 400))]);
            return fauxAssistantMessage('too late to matter');
          },
        ],
      });
      const results: { tool: string; text: string; details: unknown }[] = [];
      const result = await runtime.run({ prompt: 'go', onEvent: collectResults(results) });
      const stop = results.find((entry) => entry.tool === 'TaskStop');
      expect(stop?.text).toContain('Stopped 1 subagent');
      // The partial output is IN the answer, not merely counted.
      expect(stop?.text).toContain('PARTIAL-FINDING');
      const record = runtime.ctx.runtimeSubagents.registry.all()[0];
      expect(record?.status).toBe('stopped');
      expect(record?.deliveredAt).toBeDefined();
      expect((stop?.details as { delivered?: string[] }).delivered).toEqual([record?.delegationId]);
      expect(result.text).not.toContain('SHOULD NOT HAPPEN');
      expect(delegateTurn).toBeGreaterThan(0);
    }, 15_000);

    it('bounds TaskStop’s wait on a delegate that never converges', async () => {
      const { runtime } = await build(
        {
          parent: [
            () => toolUse(fauxToolCall('TaskStop', {}, { id: 's1' })),
            () => fauxAssistantMessage('moved on'),
          ],
        },
        { stopTimeoutMs: 50 }
      );
      // What a delegate wedged on a host call looks like from here: running,
      // and its abort does nothing.
      runtime.ctx.runtimeSubagents.registry.admit({
        delegationId: 'wedged',
        agentName: 'explorer',
        abort: () => {},
      });
      const results: { tool: string; text: string; details: unknown }[] = [];
      const result = await within(
        runtime.run({ prompt: 'go', onEvent: collectResults(results) }),
        5_000
      );
      expect(result).not.toBe(TIMED_OUT);
      expect(runtime.ctx.runtimeSubagents.registry.get('wedged')?.status).toBe('timed_out');
      expect(results.find((entry) => entry.tool === 'TaskStop')?.text).toContain(
        'did not converge'
      );
    });

    it('lets the user’s Ctrl+Enter end a TaskStop that is still waiting', async () => {
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { runtime } = await build({
        parent: [
          () => toolUse(fauxToolCall('Task', { agent: 'explorer', task: 'x' }, { id: 't1' })),
          () => toolUse(fauxToolCall('TaskStop', {}, { id: 's1' })),
          () => fauxAssistantMessage('unused'),
        ],
        delegate: [
          async () => {
            // Ignores its abort until released: a delegate slow to close.
            await gate;
            return fauxAssistantMessage('closed');
          },
        ],
      });
      const results: { tool: string; text: string; details: unknown }[] = [];
      const run = runtime.run({
        prompt: 'go',
        onEvent: (event) => {
          if (event.type === 'tool_execution_start' && event.toolName === 'TaskStop')
            setTimeout(() => runtime.loop.interject(), 30);
          collectResults(results)(event);
        },
      });
      const result = await within(run, 5_000);
      expect(result).not.toBe(TIMED_OUT);
      expect((result as RuntimeRunResult).stopCause).toBe('interjected');
      const stop = results.find((entry) => entry.tool === 'TaskStop');
      expect(stop?.text).toContain('still closing');
      // Not delivered: nothing of it was shown yet.
      expect(runtime.ctx.runtimeSubagents.registry.all()[0]?.deliveredAt).toBeUndefined();
    });

    it('says in TaskList where each report stands', async () => {
      const { runtime } = await build({
        parent: [
          () => toolUse(fauxToolCall('Task', { agent: 'explorer', task: 'quick' }, { id: 't1' })),
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return toolUse(fauxToolCall('TaskList', {}, { id: 'l1' }));
          },
          () => toolUse(fauxToolCall('TaskWait', {}, { id: 'w1' })),
          () => toolUse(fauxToolCall('TaskList', {}, { id: 'l2' })),
          () => fauxAssistantMessage('done'),
        ],
        delegate: [() => fauxAssistantMessage('QUICK-REPORT')],
      });
      const results: { tool: string; text: string; details: unknown }[] = [];
      await runtime.run({ prompt: 'go', onEvent: collectResults(results) });
      const [before, after] = results.filter((entry) => entry.tool === 'TaskList');
      const id = runtime.ctx.runtimeSubagents.registry.all()[0]?.delegationId ?? '';
      expect(before?.text).toContain('report NOT yet delivered: call TaskWait with this id');
      expect(before?.text).toContain(id);
      expect(after?.text).toContain('report already delivered to you');
      expect(after?.text).toContain('Nothing is left to wait for');
    });

    it('describes the tools without scripting list → stop → wait', async () => {
      const { runtime } = await build({ parent: [() => fauxAssistantMessage('ok')] });
      const described = runtime.ctx.runtimeTools
        .list()
        .filter((tool) => DELEGATION_TOOL_NAMES.includes(tool.name))
        .map((tool) => tool.description)
        .join('\n');
      expect(described).not.toContain('before TaskStop');
      expect(described).not.toContain('Call TaskStop only');
      expect(described).not.toContain('partial work is lost');
    });

    it('bounds one auto-resume pass instead of waiting on a silent delegate forever', async () => {
      const { runtime } = await build({ parent: [() => fauxAssistantMessage('ok')] });
      runtime.ctx.runtimeSubagents.registry.admit({
        delegationId: 'silent',
        agentName: 'explorer',
        abort: () => {},
      });
      const collected = await within(
        runtime.ctx.runtimeSubagents.collectFinished(undefined, 30),
        3_000
      );
      expect(collected).not.toBe(TIMED_OUT);
      expect(collected).toMatchObject({ timedOut: true });
      expect((collected as { text: string }).text).toContain('silent');
      // Nothing was stopped by the deadline itself.
      expect(runtime.ctx.runtimeSubagents.registry.get('silent')?.status).toBe('running');
      await runtime.ctx.runtimeSubagents.drain(20);
    });
  });

  describe('a reopened session', () => {
    it('remembers its delegations, and which reports were delivered', async () => {
      const first = await build(
        {
          parent: [
            () => toolUse(fauxToolCall('Task', { agent: 'explorer', task: 'look' }, { id: 't1' })),
            () => fauxAssistantMessage('waiting'),
            () => fauxAssistantMessage('integrated'),
          ],
          delegate: [() => fauxAssistantMessage('REPORT-BEFORE-RESTART')],
        },
        { session: 'create' }
      );
      await first.runtime.run({ prompt: 'go' });
      const id = first.runtime.ctx.runtimeSubagents.registry.all()[0]?.delegationId ?? '';
      await first.runtime.session?.flush();
      await first.runtime.dispose();

      const reopened = await build(
        {
          parent: [
            () => toolUse(fauxToolCall('TaskList', {}, { id: 'l1' })),
            () => fauxAssistantMessage('listed'),
          ],
        },
        { session: 'resume' }
      );
      const record = reopened.runtime.ctx.runtimeSubagents.registry.get(id);
      expect(record?.status).toBe('completed');
      expect(record?.deliveredAt).toBeDefined();
      expect(reopened.runtime.ctx.runtimeSubagents.registry.running()).toHaveLength(0);
      const results: { tool: string; text: string; details: unknown }[] = [];
      const result = await reopened.runtime.run({
        prompt: 'status?',
        onEvent: collectResults(results),
      });
      expect(result.success).toBe(true);
      const list = results.find((entry) => entry.tool === 'TaskList');
      expect(list?.text).not.toContain('No subagents have been started');
      expect(list?.text).toContain(id);
      expect(list?.text).toContain('report already delivered to you');
      // Delivered already, so reopening does not hand it over a second time.
      expect(result.text).not.toContain('REPORT-BEFORE-RESTART');
    });

    it('restores a delegation the worker died under as interrupted, never as running', async () => {
      const first = await build(
        { parent: [() => fauxAssistantMessage('ok')] },
        { session: 'create' }
      );
      await first.runtime.session?.appendEntry({
        type: 'custom',
        customType: SUBAGENT_ENTRY,
        data: {
          kind: 'started',
          delegationId: 'orphan',
          agentName: 'fixer',
          parentToolCallId: 'call-x',
          runId: 'run-x',
          task: 'a task nobody finished',
          model: { provider: 'faux', modelId: 'faux-loop' },
          startedAt: Date.now(),
        },
      });
      await first.runtime.session?.flush();
      await first.runtime.dispose();

      const reopened = await build(
        {
          parent: [
            () => toolUse(fauxToolCall('TaskList', {}, { id: 'l1' })),
            () => fauxAssistantMessage('listed'),
          ],
        },
        { session: 'resume' }
      );
      const registry = reopened.runtime.ctx.runtimeSubagents.registry;
      expect(registry.running()).toHaveLength(0);
      expect(registry.get('orphan')?.result?.error?.code).toBe('delegation_interrupted');
      const results: { tool: string; text: string; details: unknown }[] = [];
      const result = await within(
        reopened.runtime.run({ prompt: 'status?', onEvent: collectResults(results) }),
        5_000
      );
      // Nothing to wait on, so the run ends by itself.
      expect(result).not.toBe(TIMED_OUT);
      expect(results.find((entry) => entry.tool === 'TaskList')?.text).toContain(
        'interrupted before it finished'
      );
    });

    it('keeps a report that settled after the last run for the next one', async () => {
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let parentIdle = false;
      const first = await build(
        {
          parent: [
            () => toolUse(fauxToolCall('Task', { agent: 'explorer', task: 'long' }, { id: 't1' })),
            () => {
              parentIdle = true;
              return fauxAssistantMessage('started');
            },
          ],
          delegate: [
            async () => {
              await gate;
              return fauxAssistantMessage('REPORT-ACROSS-RESTART');
            },
          ],
        },
        { session: 'create' }
      );
      const run = first.runtime.run({ prompt: 'go' });
      await vi.waitFor(() => expect(parentIdle).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 30));
      first.runtime.loop.interject();
      await run;
      release();
      await vi.waitFor(() =>
        expect(first.runtime.ctx.runtimeSubagents.registry.undelivered()).toHaveLength(1)
      );
      await first.runtime.session?.flush();
      await first.runtime.dispose();

      const reopened = await build(
        {
          parent: [
            () => toolUse(fauxToolCall('TaskWait', {}, { id: 'w1' })),
            () => fauxAssistantMessage('integrated after restart'),
            () => fauxAssistantMessage('SHOULD NOT HAPPEN'),
          ],
        },
        { session: 'resume' }
      );
      expect(reopened.runtime.ctx.runtimeSubagents.registry.undelivered()).toHaveLength(1);
      const results: { tool: string; text: string; details: unknown }[] = [];
      const result = await reopened.runtime.run({
        prompt: 'and?',
        onEvent: collectResults(results),
      });
      expect(results.find((entry) => entry.tool === 'TaskWait')?.text).toContain(
        'REPORT-ACROSS-RESTART'
      );
      expect(result.text).not.toContain('SHOULD NOT HAPPEN');
    });
  });

  describe('normal use is untouched', () => {
    it('delegate, do other work, then collect the report by id', async () => {
      const { runtime, requests } = await build(
        {
          parent: [
            () => toolUse(fauxToolCall('Task', { agent: 'explorer', task: 'look' }, { id: 't1' })),
            () => toolUse(fauxToolCall('read', { path: 'notes.txt' }, { id: 'r1' })),
            () => {
              const id = runtimes[0]?.ctx.runtimeSubagents.registry.all()[0]?.delegationId ?? '';
              return toolUse(fauxToolCall('TaskWait', { delegationIds: [id] }, { id: 'w1' }));
            },
            () => fauxAssistantMessage('all done'),
          ],
          delegate: [
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 30));
              return fauxAssistantMessage('BY-ID-REPORT');
            },
          ],
        },
        { session: 'create' }
      );
      const results: { tool: string; text: string; details: unknown }[] = [];
      const result = await runtime.run({ prompt: 'go', onEvent: collectResults(results) });
      expect(result.success).toBe(true);
      expect(result.text).toContain('all done');
      expect(results.find((entry) => entry.tool === 'read')?.text).toContain('notes');
      expect(results.find((entry) => entry.tool === 'TaskWait')?.text).toContain('BY-ID-REPORT');
      expect(requests.parent).toHaveLength(4);
      expect(loopGuardRecords(runtime)).toEqual([]);
    });

    it('fans out five delegates in one reply and collects them with one wait', async () => {
      const { runtime } = await build(
        {
          parent: [
            () =>
              toolUse(
                ...Array.from({ length: 5 }, (_, index) =>
                  fauxToolCall(
                    'Task',
                    { agent: 'explorer', task: `direction ${index}` },
                    { id: `t${index}` }
                  )
                )
              ),
            () => toolUse(fauxToolCall('TaskWait', {}, { id: 'w1' })),
            () => fauxAssistantMessage('merged five reports'),
          ],
          delegate: [
            () => fauxAssistantMessage('FAN-REPORT'),
            () => fauxAssistantMessage('FAN-REPORT'),
            () => fauxAssistantMessage('FAN-REPORT'),
            () => fauxAssistantMessage('FAN-REPORT'),
            () => fauxAssistantMessage('FAN-REPORT'),
          ],
        },
        { session: 'create' }
      );
      const results: { tool: string; text: string; details: unknown }[] = [];
      const result = await runtime.run({ prompt: 'survey', onEvent: collectResults(results) });
      expect(result.success).toBe(true);
      expect(result.text).toContain('merged five reports');
      const records = runtime.ctx.runtimeSubagents.registry.all();
      expect(records).toHaveLength(5);
      expect(records.every((record) => record.status === 'completed')).toBe(true);
      expect(records.every((record) => record.deliveredAt !== undefined)).toBe(true);
      const wait = results.find((entry) => entry.tool === 'TaskWait');
      expect(wait?.text.match(/FAN-REPORT/g)).toHaveLength(5);
      expect(loopGuardRecords(runtime)).toEqual([]);
    });
  });
});
