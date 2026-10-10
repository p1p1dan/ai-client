import { describe, expect, it, vi } from 'vitest';
import {
  applyCacheChain,
  type CacheChainOptions,
  type CacheStepVerdict,
  initCacheChain,
  viewCacheChain,
} from '../../../shared/cacheChain.ts';
import { projectDshHistory } from '../../../shared/dshHistory/projection.ts';
import {
  AICLIENT_LOOP_GUARD_DENIAL,
  AICLIENT_TURN_CEILING_REASON,
  type DshLogEvent,
} from '../../../shared/dshHistory/types.ts';
import type { ToolCallPresentation } from '../../../shared/dshToolPresentation.ts';
import { readPiUsagePayload } from '../../../shared/piUsage.ts';
import type { ClientPrefixEvidence } from '../../../shared/types/requestScope.ts';
import { TURN_CEILING_CANCEL_REASON } from '../../loopGuard/constants.ts';
import type { DshCacheStep } from '../historyCache.ts';
import {
  type BridgeDraft,
  type CommandSendView,
  DshLiveEvents,
  type DshUsageView,
  type LiveTurn,
  type StreamFrame,
  streamingArgsSummary,
  TOOL_ARG_COALESCE_MS,
} from '../liveEvents.ts';

/**
 * dsh-rebase P1-4d1 (decision 099) — the live half of the bridge, against a
 * fake host: DSH's own events and stream frames in, the RuntimeEvents the
 * renderer draws out. The real engine runs under tools/bridge-record.ts.
 */

const SID = 'aiclient-s1';

interface Emitted {
  type: string;
  requestId?: string;
  payload: Record<string, unknown>;
}

function harness(
  options: {
    turn?: LiveTurn | null;
    usage?: DshUsageView;
    steps?: number;
    rounds?: number;
    /** P1-4c1: Ctrl+Enter messages the runtime steered in, by message id. */
    steered?: Map<string, { attemptId: string }>;
    /** P1-4d2: a command send waiting for its `command/run`. */
    command?: CommandSendView;
    /** Decision 131: the plugin-title presenter the runtime hands in. */
    presentCall?: (name: string, args: unknown) => ToolCallPresentation | undefined;
    /**
     * Decision 173: fold the session's cache chain with these route options,
     * each event before the translation sees it, as the runtime's history
     * cache does. Absent: the check is off.
     */
    chain?: CacheChainOptions;
    /** Decision 173: stands in for the history cache's answer instead of `chain`. */
    cacheStep?: (seq: number) => DshCacheStep | undefined;
    /** Decision 173: the host's newest prefix evidence on the session's requests. */
    evidence?: () => ClientPrefixEvidence | undefined;
  } = {}
) {
  const events: Emitted[] = [];
  const lines: string[] = [];
  let turn: LiveTurn | null =
    options.turn === undefined ? { requestId: 'turn-1', synthetic: false } : options.turn;
  let clock = 1_000;
  let seq = 0;
  let pendingCommand = options.command;
  const commands = new Map<string, CommandSendView>();
  const chain = options.chain ? initCacheChain() : undefined;
  let lastStep: { seq: number; verdict: CacheStepVerdict } | undefined;
  const live = new DshLiveEvents({
    // As the runtime: an event's own requestId (a command send's) wins over the turn's.
    emit: (event: BridgeDraft) =>
      events.push({
        ...(turn ? { requestId: turn.requestId } : {}),
        ...(event as unknown as Emitted),
      }),
    route: () => 'aiclient-gateway/fake-1',
    dshSessionId: () => SID,
    turn: () => turn,
    openSyntheticTurn: (number) => {
      turn = { requestId: `dsh-turn-${SID}-${number}`, synthetic: true };
      events.push({ type: 'session.status', payload: { status: 'running' } });
    },
    closeTurn: () => {
      turn = null;
    },
    takeSteered: (messageId) => {
      const steered = options.steered?.get(messageId);
      options.steered?.delete(messageId);
      return steered;
    },
    usageView: () => options.usage,
    usageSteps: () => options.steps ?? 0,
    goalMaxRounds: () => options.rounds,
    claimCommand: (commandId) => {
      const send = pendingCommand;
      pendingCommand = undefined;
      if (send) commands.set(commandId, send);
      return send;
    },
    commandSend: (commandId) => commands.get(commandId),
    now: () => clock,
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
    ...(options.cacheStep
      ? { cacheStep: options.cacheStep }
      : chain
        ? {
            cacheStep: (at: number) =>
              lastStep?.seq === at
                ? { verdict: lastStep.verdict, totals: viewCacheChain(chain).totals }
                : undefined,
          }
        : {}),
    ...(options.evidence ? { prefixEvidence: options.evidence } : {}),
    log: (line: string) => lines.push(line),
  });
  const durable = (type: string, data: Record<string, unknown>) => {
    seq += 1;
    const event = { type, seq, time: 1_790_000_000_000 + seq, data };
    log.push(event);
    // The history cache folds the event first (`dshSessionRuntime.ts`).
    if (chain && options.chain) {
      const verdict = applyCacheChain(chain, event, options.chain);
      if (verdict) lastStep = { seq, verdict };
    }
    live.onSessionEvent(event);
    return event;
  };
  const log: DshLogEvent[] = [];
  const frame = (value: StreamFrame) => live.onStreamFrame(value);
  const chunk = (chunk: Record<string, unknown>, attemptId = 'att-1') =>
    frame({ type: 'chunk', attemptId, index: 0, chunk } as StreamFrame);
  return {
    live,
    events,
    log,
    /** Decision 173: the lines written to the bridge's log. */
    lines,
    durable,
    frame,
    chunk,
    tick: (ms: number) => {
      clock += ms;
    },
    setTurn: (next: LiveTurn | null) => {
      turn = next;
    },
    of: (type: string) => events.filter((event) => event.type === type),
  };
}

const STEP_1 = `dsh-${SID}-t1-s1`;

describe('the loop guard names the bridge reads without taking the row in', () => {
  it("[D1-PIN] the shared copies are the loop guard's own (the bridge bundle may not import it)", () => {
    expect(AICLIENT_TURN_CEILING_REASON).toBe(TURN_CEILING_CANCEL_REASON);
    // permissionHost.test.ts pins the refusal's `info.name` to the same word.
    expect(AICLIENT_LOOP_GUARD_DENIAL).toBe('LoopGuard');
  });
});

describe('DshLiveEvents — thinking (decision 099 rule 2)', () => {
  it('[D1-THINK-1] opens and closes a thought on its reasoning block', () => {
    const h = harness();
    h.frame({ type: 'start', attemptId: 'att-1', turn: 1, step: 1 });
    h.chunk({ type: 'block-start', index: 0, blockType: 'reasoning' });
    h.chunk({ type: 'reasoning-delta', index: 0, text: 'let me think' });
    h.chunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'let me think' } });
    h.chunk({ type: 'block-start', index: 1, blockType: 'text' });
    h.chunk({ type: 'text-delta', index: 1, text: 'answer' });
    expect(h.events.map((event) => [event.type, event.payload.blockId])).toEqual([
      ['message.started', undefined],
      ['thinking.started', `${STEP_1}-r0`],
      ['thinking.delta', `${STEP_1}-r0`],
      ['thinking.completed', `${STEP_1}-r0`],
      ['message.delta', `${STEP_1}-b1`],
    ]);
  });

  it('[D1-THINK-2] a thought the stream cut is closed with its step', () => {
    const h = harness();
    h.frame({ type: 'start', attemptId: 'att-1', turn: 1, step: 1 });
    h.chunk({ type: 'reasoning-delta', index: 0, text: 'hmm' });
    h.durable('step/end', { turn: 1, step: 1 });
    expect(h.events.map((event) => event.type)).toEqual([
      'message.started',
      'thinking.started',
      'thinking.delta',
      'thinking.completed',
      'message.completed',
    ]);
  });
});

describe('DshLiveEvents — streaming tool arguments (decision 099 rule 14)', () => {
  it('[D1-ARGS-1] opens the row on the first named delta with the size so far, then coalesces', () => {
    const h = harness();
    h.frame({ type: 'start', attemptId: 'att-1', turn: 1, step: 1 });
    h.chunk({
      type: 'tool-call-delta',
      index: 0,
      id: 'c1',
      name: 'write',
      argumentsDelta: '{"file_',
    });
    h.chunk({
      type: 'tool-call-delta',
      index: 0,
      id: 'c1',
      name: 'write',
      argumentsDelta: 'path":"a.txt","content":"x',
    });
    h.tick(TOOL_ARG_COALESCE_MS);
    h.chunk({
      type: 'tool-call-delta',
      index: 0,
      id: 'c1',
      name: 'write',
      argumentsDelta: '\\ny\\n',
    });
    const args = '{"file_path":"a.txt","content":"x\\ny\\n"}';
    h.chunk({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'c1', name: 'write', arguments: args },
    });
    expect(h.events.slice(1).map((event) => [event.type, event.payload.input])).toEqual([
      ['tool.started', { __streaming: { bytes: 7, lines: 1 } }],
      // The second delta fell inside the window; the third reports all of it.
      [
        'tool.updated',
        { __streaming: streamingArgsSummary('{"file_path":"a.txt","content":"x\\ny\\n') },
      ],
      ['tool.updated', { file_path: 'a.txt', content: 'x\ny\n', path: 'a.txt' }],
    ]);
    // The durable call carries the same arguments: nothing more to send.
    h.durable('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: args });
    expect(h.of('tool.updated')).toHaveLength(2);
  });

  it('[D1-ARGS-2] counts the lines the model wrote inside strings, not escaped backslashes', () => {
    expect(streamingArgsSummary('{"content":"a\\nb\\n')).toEqual({ bytes: 18, lines: 2 });
    expect(streamingArgsSummary('{"content":"C:\\\\new')).toEqual({ bytes: 19, lines: 1 });
    expect(streamingArgsSummary('')).toEqual({ bytes: 0, lines: 0 });
    expect(streamingArgsSummary('"中"').bytes).toBe(5);
  });

  it('[D1-ARGS-3] a call the stream never named still gets its row from the durable call', () => {
    const h = harness();
    h.durable('tool/call', {
      turn: 1,
      step: 1,
      callId: 'c9',
      name: 'bash',
      arguments: '{"command":"ls"}',
    });
    expect(h.of('tool.started')[0]?.payload).toMatchObject({
      toolCallId: 'c9',
      name: 'bash',
      input: { command: 'ls' },
    });
  });
});

describe('DshLiveEvents — a plugin call names itself (decision 131)', () => {
  const OFFICE_ARGS = '{"path":"out/report.docx","title":"Q3"}';
  /** As `dshToolPresenter` answers: DSH's own tools never, the office plugin's by its `presentCall`. */
  const presentCall = vi.fn((name: string, args: unknown): ToolCallPresentation | undefined =>
    name === 'word_create'
      ? {
          card: 'generic',
          title: `Create ${(args as { path: string }).path}`,
          kind: 'edit',
        }
      : undefined
  );
  const TITLE: ToolCallPresentation = {
    card: 'generic',
    title: 'Create out/report.docx',
    kind: 'edit',
  };

  it('[D131-LIVE-1] streamed: the row opens on the size alone and takes the title with the complete arguments', () => {
    const h = harness({ presentCall });
    h.frame({ type: 'start', attemptId: 'att-1', turn: 1, step: 1 });
    h.chunk({
      type: 'tool-call-delta',
      index: 0,
      id: 'c1',
      name: 'word_create',
      argumentsDelta: '{"path":"out/',
    });
    h.chunk({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'c1', name: 'word_create', arguments: OFFICE_ARGS },
    });
    const [started, updated] = h.events.slice(1);
    expect(started?.type).toBe('tool.started');
    expect(started?.payload).not.toHaveProperty('presentation');
    expect(updated).toMatchObject({
      type: 'tool.updated',
      payload: { toolCallId: 'c1', presentation: TITLE },
    });
    // The durable call carries the same arguments: nothing more to send.
    h.durable('tool/call', {
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'word_create',
      arguments: OFFICE_ARGS,
    });
    expect(h.of('tool.updated')).toHaveLength(1);
  });

  it('[D131-LIVE-2] a call the stream never named gets the title on the row the durable call opens, as the history does', () => {
    const h = harness({ presentCall });
    h.durable('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c9', name: 'word_create', arguments: OFFICE_ARGS }],
      },
    });
    h.durable('tool/call', {
      turn: 1,
      step: 1,
      callId: 'c9',
      name: 'word_create',
      arguments: OFFICE_ARGS,
    });
    expect(h.of('tool.started')[0]?.payload).toMatchObject({
      toolCallId: 'c9',
      name: 'word_create',
      presentation: TITLE,
    });
    const replayed = projectDshHistory(h.log, { presentCall })[0]?.blocks[0] as {
      presentation?: unknown;
    };
    expect(replayed.presentation).toEqual(h.of('tool.started')[0]?.payload.presentation);
  });

  it("[D131-LIVE-3] reverse: DSH's own tools, and a runtime with no presenter, carry none", () => {
    const h = harness({ presentCall });
    h.durable('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' });
    expect(h.of('tool.started')[0]?.payload).not.toHaveProperty('presentation');
    const bare = harness();
    bare.durable('tool/call', {
      turn: 1,
      step: 1,
      callId: 'c2',
      name: 'word_create',
      arguments: OFFICE_ARGS,
    });
    expect(bare.of('tool.started')[0]?.payload).not.toHaveProperty('presentation');
  });

  it('[D131-LIVE-4] a presenter that throws costs the title, never the row', () => {
    const h = harness({
      presentCall: () => {
        throw new Error('plugin bug');
      },
    });
    h.durable('tool/call', {
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'word_create',
      arguments: OFFICE_ARGS,
    });
    expect(h.of('tool.started')[0]?.payload).toMatchObject({
      toolCallId: 'c1',
      input: { path: 'out/report.docx', title: 'Q3' },
    });
    expect(h.of('tool.started')[0]?.payload).not.toHaveProperty('presentation');
  });
});

describe('DshLiveEvents — tool rows (decision 099 rules 5, 6)', () => {
  const result = (callId: string, extra: Record<string, unknown>, content = 'out') => ({
    turn: 1,
    step: 1,
    message: {
      id: `r-${callId}`,
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text: content }],
      ...(extra.isError ? { isError: true } : {}),
    },
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.meta ? { meta: extra.meta } : {}),
  });

  it('[D1-FLAGS-LIVE] flags a row by DSH error code: not run, stopped, refused, outcome unknown', () => {
    const h = harness();
    for (const [callId, error] of [
      ['c1', { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' }],
      ['c2', { name: 'AbortError', code: 'ABORTED' }],
      ['c3', { name: 'PermissionDenial', code: 'tool_denied', reason: 'user-denied' }],
      ['c4', { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' }],
    ] as const) {
      h.durable('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' });
      h.durable('tool/result', result(callId, { isError: true, error }, 'Error: x'));
    }
    const completed = h.of('tool.completed').map((event) => event.payload);
    expect(completed.map((payload) => (payload.output as { details: unknown }).details)).toEqual([
      { notStarted: true },
      { stopped: true },
      { refused: true },
      { outcomeUnknown: true },
    ]);
    expect(completed.every((payload) => payload.ok === false && payload.error === 'Error: x')).toBe(
      true
    );
  });

  it('[D1-REVIEW-LIVE] a write carries the review of its diff card, the same record the history keeps', () => {
    const h = harness();
    const args = JSON.stringify({ file_path: 'n.txt', content: 'hello\n' });
    h.durable('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: args }],
      },
    });
    h.durable('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: args });
    h.durable(
      'tool/result',
      result('c1', { meta: { operation: 'create', diffs: [] } }, 'Created file')
    );
    const output = h.of('tool.completed')[0]?.payload.output as {
      content: unknown;
      details: { review: unknown };
    };
    expect(output.content).toEqual([{ type: 'text', text: 'Created file' }]);
    const replayed = projectDshHistory(h.log)[0]?.blocks.at(-1) as { review?: unknown };
    expect(output.details.review).toEqual(replayed.review);
    expect(output.details.review).toMatchObject({ status: 'added', path: 'n.txt' });
  });

  it('[D1-PLAIN] an ordinary result stays a plain string', () => {
    const h = harness();
    h.durable('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' });
    h.durable('tool/result', result('c1', {}, 'fine'));
    expect(h.of('tool.completed')[0]?.payload).toMatchObject({ ok: true, output: 'fine' });
  });
});

describe('DshLiveEvents — usage (decision 099 rule 1)', () => {
  it('[D1-USAGE-1] sends the prompt side while streaming, then the settled bill with occupancy and total', () => {
    const h = harness({
      usage: {
        tokenUsage: {
          uncachedInputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
        },
        contextPressure: { pressureTokens: 150, projectedTokens: 170, contextWindow: 1000 },
      },
      steps: 2,
    });
    h.frame({ type: 'start', attemptId: 'att-1', turn: 1, step: 1 });
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, totalTokens: 45 };
    h.chunk({ type: 'usage', usage });
    h.chunk({ type: 'usage', usage });
    h.durable('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      usage: { ...usage, reasoningTokens: 3 },
    });
    const [pending, settled] = h.of('usage.updated').map((event) => event.payload);
    expect(h.of('usage.updated')).toHaveLength(2);
    expect(pending).toEqual({
      input: 10,
      output: 0,
      cacheRead: 30,
      cacheWrite: 0,
      totalTokens: 40,
      costUsd: 0,
      pending: true,
    });
    expect(readPiUsagePayload(settled)).toEqual({
      input: 10,
      output: 5,
      cacheRead: 30,
      cacheWrite: 0,
      totalTokens: 45,
      costUsd: 0,
      reasoning: 3,
      context: { tokens: 170, contextWindow: 1000, percent: 17 },
      session: {
        turns: 2,
        toolResults: 0,
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 0,
        totalTokens: 170,
        costUsd: 0,
      },
    });
  });

  it('[D1-USAGE-2] without the projections a step still reports its own bill', () => {
    const h = harness();
    h.durable('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'a1', role: 'assistant', content: [] },
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(h.of('usage.updated')[0]?.payload).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      costUsd: 0,
    });
  });

  it('[D1-USAGE-3] a step Stop cut mid-stream says its bill was never reported', () => {
    const h = harness();
    h.durable('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'par' }] },
      interrupted: true,
    });
    expect(h.of('usage.updated')[0]?.payload).toMatchObject({ output: 0, unreported: true });
  });
});

describe('DshLiveEvents — retries and endings (decision 099 rules 3, 4)', () => {
  it('[D1-RETRY] raises the banner on llm/retry and takes it down when the retry starts', () => {
    const h = harness();
    const retry = h.durable('llm/retry', {
      retryId: 'rt-1',
      turn: 1,
      step: 1,
      provider: 'aiclient-gateway',
      mode: 'normal',
      policyKey: 'k',
      retry: 2,
      maxRetries: 5,
      delayMs: 800,
      failure: { message: 'overloaded', code: 'SERVER', status: 503 },
    });
    h.durable('llm/retry-started', { retryId: 'rt-1', turn: 1, step: 1, retry: 2 });
    expect(h.of('session.status').map((event) => event.payload)).toEqual([
      {
        status: 'running',
        retry: {
          attempt: 2,
          maxRetries: 5,
          delayMs: 800,
          errorStatus: '503',
          error: 'SERVER',
          retryAt: retry.time + 800,
        },
      },
      { status: 'running' },
    ]);
  });

  it("[D1-RETRY-ALWAYS] an 'always' policy has no ceiling: maxRetries is the banner's absent sentinel", () => {
    const h = harness();
    h.durable('llm/retry', {
      retry: 7,
      mode: 'always',
      delayMs: 100,
      failure: { message: 'reset', code: 'TRANSPORT' },
    });
    expect(h.of('session.status')[0]?.payload.retry).toMatchObject({
      attempt: 7,
      maxRetries: 0,
      errorStatus: null,
      error: 'TRANSPORT',
    });
  });

  it("[D1-FAIL] a failed turn reports DSH's sentence and our code, not the reason as JSON", () => {
    const h = harness();
    h.durable('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'Connection error.', code: 'TRANSPORT' } },
    });
    expect(h.of('session.failed')[0]?.payload).toEqual({
      error: 'Connection error.',
      errorCode: 'NETWORK_ERROR',
    });
    expect(h.events.at(-1)).toMatchObject({ type: 'session.status', payload: { status: 'idle' } });
  });

  it('[E2B-FAIL-TEXT] a gateway stream gate and a refused model setting are read off their text (decision 140)', () => {
    const gate = harness();
    gate.durable('turn/end', {
      turn: 1,
      reason: {
        kind: 'error',
        error: {
          message:
            '502 {"error":{"type":"stream_gate_precommit","reason":"prebuffer_overflow","family":"anthropic"}}',
          code: 'SERVER',
          status: 502,
        },
      },
    });
    expect(gate.of('session.failed')[0]?.payload).toEqual({
      error:
        '502 {"error":{"type":"stream_gate_precommit","reason":"prebuffer_overflow","family":"anthropic"}}',
      errorCode: 'GATEWAY_STREAM_GATE',
    });
    const setting = harness();
    setting.durable('turn/end', {
      turn: 1,
      reason: {
        kind: 'error',
        error: {
          message: '400 "thinking.type.disabled" is not supported for this model',
          code: 'INVALID_REQUEST',
        },
      },
    });
    expect(setting.of('session.failed')[0]?.payload.errorCode).toBe('MODEL_SETTING_UNSUPPORTED');
    // Any other text keeps the code's own mapping.
    const plain = harness();
    plain.durable('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: '500 upstream exploded', code: 'SERVER' } },
    });
    expect(plain.of('session.failed')[0]?.payload.errorCode).toBe('PROVIDER_ERROR');
  });

  it('[D1-FAIL-REPETITION] the loop guard cut keeps its own code, which has its own card', () => {
    const h = harness();
    h.durable('turn/end', {
      turn: 1,
      reason: {
        kind: 'error',
        error: {
          message: 'The model wrote the same subagent tool call 3 times',
          code: 'tool_call_repetition',
        },
      },
    });
    expect(h.of('session.failed')[0]?.payload.errorCode).toBe('tool_call_repetition');
  });

  it('[D1-TURN-LIMIT] the step ceiling ends the run as a turn limit; a user stop stays a stop', () => {
    const h = harness();
    h.durable('turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'aiclient-turn-ceiling' } },
    });
    h.setTurn({ requestId: 'turn-2', synthetic: false });
    h.durable('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } });
    expect(
      h.events.filter(
        (event) => event.type.startsWith('session.') && event.type !== 'session.status'
      )
    ).toEqual([
      { type: 'session.completed', requestId: 'turn-1', payload: { stopCause: 'turn_limit' } },
      { type: 'session.stopped', requestId: 'turn-2', payload: {} },
    ]);
  });

  it('[D1-ENDINGS] a blocked or length-capped turn completes', () => {
    for (const kind of ['completed', 'blocked', 'max-tokens']) {
      const h = harness();
      h.durable('turn/end', { turn: 1, reason: { kind } });
      expect(h.of('session.completed'), kind).toHaveLength(1);
    }
  });
});

describe('DshLiveEvents — notices and turn heads (decisions 072, 081, 099 rules 7, 8)', () => {
  const notice = (kind: string, summary: string) => ({
    id: `m-${kind}`,
    role: 'user',
    content: [{ type: 'text', text: 'model-facing body' }],
    source: { kind, form: 'notice', summary },
  });

  it('[D1-HEAD-LIVE-1] a goal round DSH started is headed by its origin, with the budget', () => {
    const h = harness({ turn: null, rounds: 5 });
    h.durable('turn/start', { turn: 4 });
    h.durable('step/start', { turn: 4, step: 1 });
    const round = h.durable('user/message', {
      id: 'g1',
      role: 'user',
      content: [{ type: 'text', text: '<goal_round>' }],
      source: { kind: 'goal', goalId: 'x', revision: 1, round: 2 },
    });
    expect(h.events.map((event) => [event.type, event.requestId])).toEqual([
      ['session.status', undefined],
      ['message.started', `dsh-turn-${SID}-4`],
      ['message.completed', `dsh-turn-${SID}-4`],
    ]);
    expect(h.events[1]?.payload).toEqual({
      messageId: `dsh-user-${round.seq}`,
      role: 'user',
      origin: { kind: 'goal', round: 2, maxRounds: 5 },
    });
  });

  it('[D1-HEAD-LIVE-2] a job wake-up is headed by its account; the next account is a notice', () => {
    const h = harness({ turn: null });
    h.durable('turn/start', { turn: 2 });
    const head = h.durable('user/message', notice('tool-jobs', 'bash sleep 1 exited 0'));
    const next = h.durable('user/message', notice('subagent-settled', 'explore done'));
    expect(h.of('message.started')[0]?.payload).toMatchObject({
      messageId: `dsh-user-${head.seq}`,
      origin: { kind: 'job' },
    });
    expect(h.of('message.delta')[0]?.payload.text).toBe('bash sleep 1 exited 0');
    expect(h.of('custom.message')[0]?.payload).toEqual({
      messageId: `dsh-notice-${next.seq}`,
      customType: 'dsh:subagent-settled',
      content: 'explore done',
    });
  });

  it('[D1-NOTICE-LIVE] in a turn the user sent, accounts are notices and our wrap-up is hidden', () => {
    const h = harness({ turn: { requestId: 'turn-1', synthetic: false, userMessageId: 'u1' } });
    h.durable('turn/start', { turn: 1 });
    h.durable('user/message', notice('tool-jobs', 'bash x exited 0'));
    h.durable('user/message', {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'my prompt' }],
      source: { kind: 'user' },
    });
    h.durable('user/message', notice('aiclient-loop-guard', 'wrap up'));
    h.durable('user/message', notice('tool-goal', 'complete: x'));
    expect(h.events.map((event) => event.type)).toEqual([
      'custom.message',
      'message.started',
      'message.delta',
      'message.completed',
    ]);
    expect(h.of('message.started')[0]?.payload).not.toHaveProperty('origin');
  });

  it('[C1-STEER-ECHO] a message steered into the turn echoes with its own attempt id (P1-4c1)', () => {
    const steered = new Map([['s1', { attemptId: 'interject-1' }]]);
    const h = harness({
      turn: { requestId: 'turn-1', attemptId: 'attempt-1', synthetic: false, userMessageId: 'u1' },
      steered,
    });
    const typed = (id: string, text: string) => ({
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    h.durable('turn/start', { turn: 1 });
    h.durable('step/start', { turn: 1, step: 1 });
    h.durable('user/message', typed('u1', 'list the files'));
    h.frame({ type: 'start', attemptId: 'att-1', turn: 1, step: 1 });
    h.durable('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'listing' }] },
    });
    h.durable('step/end', { turn: 1, step: 1 });
    h.durable('step/start', { turn: 1, step: 2 });
    h.durable('user/message', typed('s1', 'also count them'));
    // Typed by the user, but its attempt id did not survive (a host restart).
    h.durable('user/message', typed('x1', 'from before'));
    const users = h
      .of('message.started')
      .filter((event) => event.payload.role === 'user')
      .map((event) => [event.payload.messageId, event.payload.attemptId]);
    expect(users).toEqual([
      ['dsh-user-3', 'attempt-1'],
      ['dsh-user-7', 'interject-1'],
      ['dsh-user-8', undefined],
    ]);
    // Taken once: the id is forgotten with its echo.
    expect(steered.size).toBe(0);
    // Same turn, same request: the interjection never ends it.
    expect(h.events.every((event) => event.requestId === 'turn-1')).toBe(true);
    // The history shows the same user rows under the same live ids.
    const rows = projectDshHistory(h.log, { liveSessionId: SID });
    expect(rows.filter((row) => row.role === 'user').map((row) => row.liveMessageId)).toEqual([
      'dsh-user-3',
      'dsh-user-7',
      'dsh-user-8',
    ]);
  });

  it('[D1-HEAD-PARITY] the live ids are the ones the history names on its rows', () => {
    const h = harness({ turn: null });
    h.durable('turn/start', { turn: 1 });
    h.durable('step/start', { turn: 1, step: 1 });
    h.durable('user/message', notice('tool-jobs', 'bash x exited 0'));
    h.frame({ type: 'start', attemptId: 'att-1', turn: 1, step: 1 });
    h.durable('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    });
    h.durable('step/end', { turn: 1, step: 1 });
    h.durable('step/start', { turn: 1, step: 2 });
    h.durable('user/message', notice('subagent-settled', 'explore done'));
    const liveIds = h.events
      .filter((event) => event.type === 'message.started' || event.type === 'custom.message')
      .map((event) => event.payload.messageId);
    const rows = projectDshHistory(h.log, { liveSessionId: SID });
    expect(rows.map((row) => row.liveMessageId)).toEqual(liveIds);
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'system']);
  });
});

describe('DshLiveEvents — command sends (P1-4d2, decisions 099 rule 9, 113)', () => {
  const send = { requestId: 'turn-GOAL', attemptId: 'attempt-GOAL' };

  it('[D2-CMD-LIVE-1] echoes the admitted line with its attempt id, then the answer, no turn', () => {
    const h = harness({ turn: null, command: send });
    h.durable('command/run', {
      commandId: 'cmd-a-1',
      name: 'goal',
      args: ' fix CI',
      source: { kind: 'user' },
    });
    h.durable('command/done', { commandId: 'cmd-a-1', kind: 'success', text: 'Goal created' });
    expect(h.events).toEqual([
      { type: 'session.status', requestId: 'turn-GOAL', payload: { status: 'running' } },
      {
        type: 'message.started',
        requestId: 'turn-GOAL',
        payload: { messageId: 'dsh-command-1', role: 'user', attemptId: 'attempt-GOAL' },
      },
      {
        type: 'message.delta',
        requestId: 'turn-GOAL',
        payload: {
          messageId: 'dsh-command-1',
          blockId: 'dsh-command-1-text',
          text: '/goal fix CI',
        },
      },
      {
        type: 'message.completed',
        requestId: 'turn-GOAL',
        payload: { messageId: 'dsh-command-1' },
      },
      {
        type: 'custom.message',
        requestId: 'turn-GOAL',
        payload: { messageId: 'dsh-command-2', customType: 'dsh:command', content: 'Goal created' },
      },
    ]);
  });

  it('[D2-CMD-LIVE-2] a refusal is an error notice; an answer without text shows nothing', () => {
    const h = harness({ turn: null, command: send });
    h.durable('command/run', { commandId: 'cmd-a-2', name: 'goal', source: { kind: 'user' } });
    h.durable('command/done', { commandId: 'cmd-a-2', kind: 'error', text: 'Usage: /goal' });
    expect(h.of('custom.message').map((event) => event.payload)).toEqual([
      { messageId: 'dsh-command-2', customType: 'dsh:command-error', content: 'Usage: /goal' },
    ]);
    expect(h.of('message.delta')[0]?.payload.text).toBe('/goal');
    const quiet = harness({ turn: null, command: send });
    quiet.durable('command/run', { commandId: 'cmd-a-3', name: 'goal', source: { kind: 'user' } });
    quiet.durable('command/done', { commandId: 'cmd-a-3', kind: 'success' });
    expect(quiet.of('custom.message')).toEqual([]);
  });

  it('[D2-CMD-LIVE-3] a command no send of ours carried (worker.compact) shows nothing live', () => {
    const h = harness({ turn: null });
    h.durable('command/run', { commandId: 'cmd-a-4', name: 'compact', source: { kind: 'user' } });
    h.durable('command/done', { commandId: 'cmd-a-4', kind: 'success', text: 'Compacted 3' });
    expect(h.events).toEqual([]);
  });
});

describe('DshLiveEvents — the prompt cache of each step (decision 173 B2)', () => {
  const CLAUDE = { kind: 'model', provider: 'claude', model: 'claude-opus-5-5' };
  const GLM = { kind: 'model', provider: 'zhipu-ai-glm', model: 'glm-5.3' };
  /** As `dshCacheChainOptions` answers for a plan whose one anthropic-messages route is `claude`. */
  const FOLLOW_CLAUDE: CacheChainOptions = {
    cacheAware: (provider) => provider === 'claude',
    ttlMsFor: () => undefined,
  };
  type Harness = ReturnType<typeof harness>;

  /**
   * One model step: its start, `request` (what the host's fetch wrapper saw
   * while the step waited), its answer with usage, its end. Returns the
   * step's settled usage.
   */
  function step(
    h: Harness,
    turn: number,
    index: number,
    usage: { read?: number; write?: number },
    {
      source = CLAUDE,
      request,
    }: { source?: Record<string, unknown>; request?: (startedAt: number) => void } = {}
  ): Record<string, unknown> | undefined {
    const start = h.durable('step/start', { turn, step: index });
    request?.(start.time);
    h.durable('assistant/message', {
      turn,
      step: index,
      message: {
        id: `a${turn}.${index}`,
        role: 'assistant',
        source,
        content: [{ type: 'text', text: 'ok' }],
      },
      usage: {
        inputTokens: 2,
        outputTokens: 10,
        ...(usage.read ? { cacheReadTokens: usage.read } : {}),
        ...(usage.write ? { cacheWriteTokens: usage.write } : {}),
      },
    });
    h.durable('step/end', { turn, step: index });
    return h.of('usage.updated').at(-1)?.payload;
  }

  /** Two steps of an append-only chain: the second reads what the first cached. */
  function warmChain(h: Harness): void {
    step(h, 1, 1, { write: 10_000 });
    step(h, 1, 2, { read: 10_000, write: 2_000 });
  }

  it('[D173-LIVE-1] sends a rebuild nothing explains with its settled usage, and logs it', () => {
    let evidence: ClientPrefixEvidence | undefined;
    const h = harness({ chain: FOLLOW_CLAUDE, evidence: () => evidence });
    expect(step(h, 1, 1, { write: 10_000 })).not.toHaveProperty('cache');
    expect(step(h, 1, 2, { read: 10_000, write: 2_000 })).not.toHaveProperty('cache');
    const settled = step(
      h,
      1,
      3,
      { write: 13_000 },
      {
        request: (at) => {
          evidence = { verdict: { kind: 'append', added: 2 }, requestSeq: 3, at };
        },
      }
    );
    const cache = {
      turn: 1,
      step: 3,
      kind: 'rebuild',
      explained: false,
      lost: 12_002,
      prompt: 13_002,
      read: 0,
      write: 13_000,
      prevPrompt: 12_002,
      prefix: 'append',
      session: { unexplained: 1, unexplainedLostTokens: 12_002 },
    };
    expect(settled?.cache).toEqual(cache);
    expect(readPiUsagePayload(settled)?.cache).toEqual(cache);
    expect(h.lines).toEqual([
      'cache-chain: upstream cache inconsistency session=aiclient-s1 step=t1s3 kind=rebuild prompt=13002 prev=12002 read=0 write=13000 lost=12002 matched=- prefix=append',
    ]);
  });

  it('[D173-LIVE-2] sends an explained rebuild with its causes, and logs nothing', () => {
    const h = harness({ chain: FOLLOW_CLAUDE });
    warmChain(h);
    h.durable('plan/mode', { active: false });
    const settled = step(h, 1, 3, { write: 13_000 });
    expect(settled?.cache).toMatchObject({
      kind: 'rebuild',
      explained: true,
      causes: ['plan-mode'],
      session: { unexplained: 0, unexplainedLostTokens: 0 },
    });
    expect(h.lines).toEqual([]);
  });

  it('[D173-LIVE-3] says nothing while the check is switched off', () => {
    const h = harness({
      evidence: () => ({
        verdict: {
          kind: 'diverged',
          at: 'system',
          truncated: false,
          prevMessages: 2,
          messages: 3,
        },
        requestSeq: 1,
        at: 1_790_000_000_000,
      }),
    });
    warmChain(h);
    const rebuilt = step(h, 1, 3, { write: 13_000 });
    expect(rebuilt).toMatchObject({ input: 2, cacheWrite: 13_000 });
    expect(h.of('usage.updated').some((event) => 'cache' in event.payload)).toBe(false);
    expect(h.lines).toEqual([]);
  });

  it('[D173-LIVE-4] never judges a route it does not follow', () => {
    const h = harness({ chain: FOLLOW_CLAUDE });
    step(h, 1, 1, { write: 50_000 }, { source: GLM });
    step(h, 1, 2, { write: 60_000 }, { source: GLM });
    step(h, 1, 3, { read: 1_000 }, { source: GLM });
    expect(h.of('usage.updated').some((event) => 'cache' in event.payload)).toBe(false);
    expect(h.lines).toEqual([]);
  });

  it('[D173-LIVE-5] flags our own request diverging when nothing local explains it', () => {
    let evidence: ClientPrefixEvidence | undefined;
    const diverged = (requestSeq: number) => (at: number) => {
      evidence = {
        verdict: {
          kind: 'diverged',
          at: 'messages',
          index: 1,
          role: 'assistant',
          truncated: false,
          prevMessages: 3,
          messages: 5,
        },
        requestSeq,
        at,
      };
    };
    const h = harness({ chain: FOLLOW_CLAUDE, evidence: () => evidence });
    step(h, 1, 1, { write: 10_000 });
    // A warm step sends no verdict, but the divergence is ours to look at.
    const warm = step(h, 1, 2, { read: 10_000, write: 2_000 }, { request: diverged(2) });
    expect(warm).not.toHaveProperty('cache');
    expect(h.lines).toEqual([
      'cache-chain: client request diverged without a logged cause session=aiclient-s1 step=t1s2 at=messages index=1/5 role=assistant truncated=false request=2',
    ]);
    // A compaction since the step before accounts for the next one.
    h.durable('compaction/start', { compactionId: 'c1', turn: 1 });
    h.durable('compaction/end', { compactionId: 'c1', turn: 1 });
    const compacted = step(h, 1, 3, { read: 4_000, write: 1_000 }, { request: diverged(3) });
    expect(compacted?.cache).toMatchObject({
      kind: 'shrink',
      explained: true,
      causes: ['compaction'],
      prefix: 'diverged',
    });
    expect(h.lines).toHaveLength(1);
  });

  it("[D173-LIVE-6] gives a step only its own request's evidence", () => {
    let evidence: ClientPrefixEvidence | undefined;
    const seen = (requestSeq: number) => (at: number) => {
      evidence = { verdict: { kind: 'append', added: 1 }, requestSeq, at };
    };
    const h = harness({ chain: FOLLOW_CLAUDE, evidence: () => evidence });
    step(h, 1, 1, { write: 10_000 }, { request: seen(1) });
    // The watch saw nothing of step 2's request: step 1's evidence is not its.
    const unseen = step(h, 1, 2, { write: 12_000 });
    expect(unseen?.cache).toMatchObject({ kind: 'rebuild' });
    expect(unseen?.cache).not.toHaveProperty('prefix');
    expect(h.lines.at(-1)).toMatch(/ prefix=-$/);

    // A retried step: the host keeps what it found on the first attempt (the
    // retry repeats that request), seen inside the step all the same.
    const start = h.durable('step/start', { turn: 1, step: 3 });
    seen(2)(start.time);
    h.durable('assistant/attempt', { turn: 1, step: 3, attemptId: 'att-3a' });
    h.durable('assistant/message', {
      turn: 1,
      step: 3,
      message: { id: 'a1.3', role: 'assistant', source: CLAUDE, content: [] },
      usage: { inputTokens: 2, outputTokens: 10, cacheWriteTokens: 13_000 },
    });
    expect(h.of('usage.updated').at(-1)?.payload.cache).toMatchObject({
      kind: 'rebuild',
      prefix: 'append',
    });
    expect(h.lines.at(-1)).toMatch(/ step=t1s3 .* prefix=append$/);
  });

  it('[D173-LIVE-7] keeps the bill when the verdict cannot be read', () => {
    const h = harness({
      cacheStep: () => {
        throw new Error('cache gone');
      },
    });
    const settled = step(h, 1, 1, { write: 10_000 });
    expect(settled).toMatchObject({ input: 2, output: 10, cacheWrite: 10_000 });
    expect(settled).not.toHaveProperty('cache');
    expect(h.lines).toEqual([]);
  });
});
