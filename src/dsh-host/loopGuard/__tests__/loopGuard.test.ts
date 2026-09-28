import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  LOOP_GUARD_SERVICE,
  LOOP_GUARD_SOURCE_KIND,
  TOOL_CALL_REPETITION,
  TURN_CEILING_CANCEL_REASON,
  TURN_CEILING_TOOL_REFUSAL,
  turnCeilingPrompt,
} from '../constants.ts';
import type {
  DshAgentView,
  DshMessageSource,
  DshPreStepDecision,
  DshPreToolDecision,
  DshStreamChunk,
  DshUserMessage,
} from '../dshTypes.ts';
import {
  type DshLoopGuard,
  installLoopGuard,
  type LoopGuardRowContext,
  resolveLoopGuardSettings,
} from '../loopGuard.ts';

/**
 * The aiclient-loop-guard row against a fake DSH context (decisions 065, 066):
 * listener lists with Cordis' prepend semantics, waterfall dispatch, and the
 * loop's order of events around a step (pre-step, step/start, pre-execute,
 * step/end).
 */

type AnyListener = (...args: unknown[]) => unknown;

function fakeDsh() {
  const lists = new Map<string, Array<{ listener: AnyListener; prepend: boolean }>>();
  const services = new Map<string, unknown>();
  const ctx: LoopGuardRowContext = {
    on: (name, listener, options) => {
      const list = lists.get(name) ?? [];
      const hook = { listener: listener as unknown as AnyListener, prepend: !!options?.prepend };
      if (hook.prepend) list.unshift(hook);
      else list.push(hook);
      lists.set(name, list);
      return () => true;
    },
    provide: (name, value) => {
      services.set(name, value);
      return () => services.delete(name);
    },
  };
  const waterfall = <T>(name: string, args: unknown[], inner: () => T): T => {
    const callbacks = (lists.get(name) ?? []).map((hook) => hook.listener);
    const next = (): T => {
      const callback = callbacks.shift();
      return callback ? (callback(...args, next) as T) : inner();
    };
    return next();
  };
  const emit = (name: string, ...args: unknown[]) => {
    for (const hook of lists.get(name) ?? []) hook.listener(...args);
  };
  return { ctx, lists, services, waterfall, emit };
}

let messageIds = 0;
const createUserMessage = (input: {
  content: Array<{ type: 'text'; text: string }>;
  source: DshMessageSource;
}): DshUserMessage => ({ id: `m${++messageIds}`, role: 'user', ...input });
const message = (kind: string, text = 'hi'): DshUserMessage =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind } });

function agentView(id: string): DshAgentView & { cancel: ReturnType<typeof vi.fn> } {
  return { id, session: { id }, cancel: vi.fn() };
}

function setup(stepCeiling = 3, env: Record<string, string | undefined> = {}) {
  const dsh = fakeDsh();
  const lines: string[] = [];
  const isAgentLoopRequest = (request: unknown) =>
    (request as { loop?: boolean } | null)?.loop === true;
  const api = installLoopGuard(dsh.ctx, resolveLoopGuardSettings({ stepCeiling }, env), {
    isAgentLoopRequest,
    createUserMessage,
    log: (line) => lines.push(line),
  });
  /** One loop step: pre-step, then (if entered) step/start, the calls, step/end. */
  const step = async (
    agent: DshAgentView,
    turn: number,
    stepNo: number,
    claimed: DshUserMessage[],
    calls: string[] = []
  ) => {
    const decision = await dsh.waterfall<Promise<DshPreStepDecision>>(
      'agent/pre-step',
      [{ agent, messages: claimed, turn, step: stepNo }],
      async () => ({ kind: 'enter', messages: claimed, startsRequestSeries: stepNo === 1 })
    );
    const entered = decision.kind === 'enter' && !(stepNo === 1 && decision.messages.length === 0);
    const results: DshPreToolDecision[] = [];
    if (entered) {
      dsh.emit('session/event', agent.session, {
        type: 'step/start',
        data: { turn, step: stepNo },
      });
      for (const name of calls) {
        results.push(
          await dsh.waterfall<Promise<DshPreToolDecision>>(
            'tools/pre-execute',
            [{ callId: `${name}-${turn}-${stepNo}`, name, agent }],
            async () => ({ kind: 'allow' })
          )
        );
      }
      dsh.emit('session/event', agent.session, { type: 'step/end', data: { turn, step: stepNo } });
    }
    return { decision, entered, results };
  };
  const endTurn = (agent: DshAgentView, turn: number) =>
    dsh.emit('session/event', agent.session, { type: 'turn/end', data: { turn } });
  return { dsh, api, lines, step, endTurn };
}

const texts = (decision: DshPreStepDecision) =>
  decision.kind === 'enter'
    ? decision.messages.map((m) => (m.content[0] as { text: string }).text)
    : [];

describe('resolveLoopGuardSettings', () => {
  it('is on unless the switch is exactly 0, and defaults to 500 steps', () => {
    expect(resolveLoopGuardSettings(undefined, {})).toEqual({ enabled: true, stepCeiling: 500 });
    for (const value of ['1', 'false', 'off', '']) {
      expect(resolveLoopGuardSettings({}, { AICLIENT_RUNTIME_LOOP_GUARD: value }).enabled).toBe(
        true
      );
    }
    expect(resolveLoopGuardSettings({}, { AICLIENT_RUNTIME_LOOP_GUARD: '0' }).enabled).toBe(false);
  });

  it('takes a positive integer ceiling and falls back to 500 on anything else', () => {
    expect(resolveLoopGuardSettings({ stepCeiling: 7 }, {}).stepCeiling).toBe(7);
    for (const bad of [0, -1, 2.5, '10', null]) {
      const warn = vi.fn();
      expect(resolveLoopGuardSettings({ stepCeiling: bad }, {}, warn).stepCeiling).toBe(500);
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the row with the switch off', () => {
  it('registers nothing, and its service refuses nothing', () => {
    const { dsh, api, lines } = setup(3, { AICLIENT_RUNTIME_LOOP_GUARD: '0' });
    expect([...dsh.lists.keys()]).toEqual([]);
    expect(api.enabled).toBe(false);
    expect(api.refusalFor({ agent: agentView('a') })).toBeUndefined();
    expect(dsh.services.get(LOOP_GUARD_SERVICE)).toBe(api);
    expect(lines.join('\n')).toContain('AICLIENT_RUNTIME_LOOP_GUARD=0');
  });
});

describe('rule B wiring (decision 065)', () => {
  const stream = (chunks: DshStreamChunk[]): AsyncIterable<DshStreamChunk> => ({
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  });
  const repeated = [0, 1, 2, 3].flatMap((index) => [
    { type: 'block-start', index, blockType: 'tool-call' },
    {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: `t${index}`, name: 'job_list', arguments: '{}' },
    },
  ]) as DshStreamChunk[];

  it('wraps agent-loop requests only', async () => {
    const { dsh, lines } = setup();
    const downstream = stream(repeated);
    const passed = dsh.waterfall<AsyncIterable<DshStreamChunk>>(
      'llm/stream',
      [{ loop: false }],
      () => downstream
    );
    expect(passed).toBe(downstream);
    const guarded = dsh.waterfall<AsyncIterable<DshStreamChunk>>(
      'llm/stream',
      [{ loop: true, sessionId: 's1' }],
      () => stream(repeated)
    );
    const out: DshStreamChunk[] = [];
    for await (const chunk of guarded) out.push(chunk);
    expect(out.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: TOOL_CALL_REPETITION } },
    });
    expect(out.filter((chunk) => chunk.type === 'block-end')).toHaveLength(3);
    expect(lines.some((line) => line.startsWith('cut a reply of s1: identical_call'))).toBe(true);
  });

  it('keeps a cut reply from being retried, and leaves every other failure to the retry row', async () => {
    const { dsh } = setup();
    // llm-retry's listener, registered by an earlier row: retries everything (mode always).
    dsh.ctx.on('agent/request-error', async () => ({ kind: 'retry' }));
    const ask = (code: string) =>
      dsh.waterfall<Promise<unknown>>(
        'agent/request-error',
        [{ turn: 1, step: 1, failure: { code, message: 'x' } }],
        async () => undefined
      );
    expect(dsh.lists.get('agent/request-error')?.[0]?.prepend).toBe(true);
    expect(await ask(TOOL_CALL_REPETITION)).toBeUndefined();
    expect(await ask('SERVER')).toEqual({ kind: 'retry' });
  });
});

describe('rule C: the step ceiling (decision 066)', () => {
  it('counts steps, then turns the next step into a tool-less wrap-up that ends the turn', async () => {
    const { step, lines } = setup(3);
    const agent = agentView('s1');
    const first = await step(agent, 1, 1, [message('user')], ['bash']);
    expect(first.results).toEqual([{ kind: 'allow' }]);
    await step(agent, 1, 2, [], ['read']);
    await step(agent, 1, 3, [], ['read']);
    expect(agent.cancel).not.toHaveBeenCalled();

    const wrap = await step(agent, 1, 4, [], ['bash', 'job_list']);
    expect(wrap.entered).toBe(true);
    expect(texts(wrap.decision)).toEqual([turnCeilingPrompt(3, false)]);
    const instruction = (wrap.decision as { messages: readonly DshUserMessage[] }).messages[0];
    expect(instruction?.source).toMatchObject({ kind: LOOP_GUARD_SOURCE_KIND, form: 'notice' });
    expect(wrap.results).toEqual([
      {
        kind: 'deny',
        reason: TURN_CEILING_TOOL_REFUSAL,
        info: { name: 'LoopGuard', code: 'turn_ceiling' },
      },
      {
        kind: 'deny',
        reason: TURN_CEILING_TOOL_REFUSAL,
        info: { name: 'LoopGuard', code: 'turn_ceiling' },
      },
    ]);
    expect(agent.cancel).toHaveBeenCalledTimes(1);
    expect(agent.cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: TURN_CEILING_CANCEL_REASON },
      { keepInbox: true }
    );
    expect(lines.some((line) => line.includes('turn 1 step 4 is the wrap-up'))).toBe(true);
  });

  it('keeps startsRequestSeries and every claimed message, the instruction last', async () => {
    const { step } = setup(1);
    const agent = agentView('s1');
    await step(agent, 1, 1, [message('user')], ['bash']);
    const notice = message('tool-jobs', 'job j1 finished');
    const wrap = await step(agent, 2, 1, [notice]);
    expect(wrap.decision).toMatchObject({ kind: 'enter', startsRequestSeries: true });
    expect(texts(wrap.decision)).toEqual(['job j1 finished', turnCeilingPrompt(1, true)]);
  });

  it('refuses nothing once the wrap-up step ended, and nothing before the ceiling', async () => {
    const { step, api } = setup(2);
    const agent = agentView('s1');
    await step(agent, 1, 1, [message('user')], ['bash']);
    expect(api.refusalFor({ agent })).toBeUndefined();
    await step(agent, 1, 2, [], ['bash']);
    await step(agent, 1, 3, [], ['bash']);
    expect(api.refusalFor({ agent })).toBeUndefined();
  });

  it('turns every step a notice opens after the ceiling into a wrap-up, until the user speaks', async () => {
    const { step, endTurn } = setup(2);
    const agent = agentView('s1');
    await step(agent, 1, 1, [message('user')], ['bash']);
    await step(agent, 1, 2, [], ['bash']);
    await step(agent, 1, 3, []);
    endTurn(agent, 1);
    expect(agent.cancel).toHaveBeenCalledTimes(1);

    for (const [turn, kind] of [
      [2, 'tool-jobs'],
      [3, 'subagent-settled'],
      [4, LOOP_GUARD_SOURCE_KIND],
    ] as const) {
      const woken = await step(agent, turn, 1, [message(kind)], ['bash']);
      expect(woken.results, kind).toEqual([expect.objectContaining({ kind: 'deny' })]);
      endTurn(agent, turn);
    }
    expect(agent.cancel).toHaveBeenCalledTimes(4);

    const resumed = await step(agent, 5, 1, [message('user', 'continue')], ['bash']);
    expect(resumed.results).toEqual([{ kind: 'allow' }]);
    expect(texts(resumed.decision)).toEqual(['continue']);
    expect(agent.cancel).toHaveBeenCalledTimes(4);
  });

  it('opens a new count on a user message, a retry continuation and a goal round', async () => {
    for (const kind of ['user', 'aiclient-retry', 'goal']) {
      const { step } = setup(2);
      const agent = agentView('s1');
      await step(agent, 1, 1, [message('user')], ['bash']);
      await step(agent, 1, 2, [], ['bash']);
      // An interjection mid-turn (next-step input) resets the count too.
      const steered = await step(agent, 1, 3, [message(kind)], ['bash']);
      expect(steered.results, kind).toEqual([{ kind: 'allow' }]);
      await step(agent, 1, 4, [], ['bash']);
      const wrap = await step(agent, 1, 5, [], ['bash']);
      expect(wrap.results[0]?.kind, kind).toBe('deny');
    }
  });

  it('does not wake a turn that would run no step', async () => {
    const { step } = setup(1);
    const agent = agentView('s1');
    await step(agent, 1, 1, [message('user')]);
    const empty = await step(agent, 2, 1, []);
    expect(empty.entered).toBe(false);
    expect(texts(empty.decision)).toEqual([]);
    expect(agent.cancel).not.toHaveBeenCalled();
  });

  it('passes a rejected step through untouched', async () => {
    const { dsh, step } = setup(1);
    const agent = agentView('s1');
    await step(agent, 1, 1, [message('user')]);
    const rejected = await dsh.waterfall<Promise<DshPreStepDecision>>(
      'agent/pre-step',
      [{ agent, messages: [], turn: 1, step: 2 }],
      async () => ({ kind: 'reject' })
    );
    expect(rejected).toEqual({ kind: 'reject' });
  });

  it('counts each agent on its own, a delegate included', async () => {
    const { step } = setup(2);
    const parent = agentView('parent');
    const child = agentView('child');
    await step(parent, 1, 1, [message('user')], ['subagent']);
    await step(child, 1, 1, [message('user', 'child task')], ['bash']);
    await step(parent, 1, 2, [], ['job_output']);
    await step(child, 1, 2, [], ['bash']);
    const childWrap = await step(child, 1, 3, [], ['bash']);
    expect(childWrap.results[0]?.kind).toBe('deny');
    expect(child.cancel).toHaveBeenCalledTimes(1);
    expect(parent.cancel).not.toHaveBeenCalled();
  });

  it('forgets a disposed agent, and ignores sessions it never saw', async () => {
    const { dsh, step } = setup(1);
    const agent = agentView('s1');
    await step(agent, 1, 1, [message('user')]);
    dsh.emit('agent/disposed', { agent });
    dsh.emit('session/event', { id: 'other' }, { type: 'step/end', data: { turn: 1, step: 1 } });
    const fresh = await step(agent, 1, 1, [message('tool-jobs')], ['bash']);
    expect(fresh.results).toEqual([{ kind: 'allow' }]);
  });

  it('refuses ahead of a permission gate registered before it', async () => {
    const { dsh, step } = setup(1);
    const gate = vi.fn(async () => ({ kind: 'ask' }) as DshPreToolDecision);
    // aiclient-permissions' prepend happened first; the guard's prepend lands in front of it.
    const fresh = fakeDsh();
    fresh.ctx.on('tools/pre-execute', gate, { prepend: true });
    installLoopGuard(fresh.ctx, resolveLoopGuardSettings({ stepCeiling: 1 }, {}), {
      isAgentLoopRequest: () => false,
      createUserMessage,
    });
    expect(fresh.lists.get('tools/pre-execute')?.[1]?.listener).toBe(gate);
    // And the query service answers the same, for a gate that asks first.
    const agent = agentView('s1');
    await step(agent, 1, 1, [message('user')]);
    const service = dsh.services.get(LOOP_GUARD_SERVICE) as DshLoopGuard;
    await dsh.waterfall<Promise<DshPreStepDecision>>(
      'agent/pre-step',
      [{ agent, messages: [], turn: 1, step: 2 }],
      async () => ({ kind: 'enter', messages: [] })
    );
    expect(service.refusalFor({ agent })).toBe(TURN_CEILING_TOOL_REFUSAL);
  });
});

describe('the names the rest of the app keys on', () => {
  it('uses the failure-card key the renderer already has for a cut reply', () => {
    const renderer = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'renderer',
        'components',
        'chat',
        'sessionFailure.ts'
      ),
      'utf8'
    );
    expect(renderer).toContain(`${TOOL_CALL_REPETITION}: {`);
  });
});
