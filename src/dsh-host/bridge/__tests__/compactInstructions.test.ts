import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import { describe, expect, it } from 'vitest';
import {
  armCompactInstructions,
  type CompactInstructionsArm,
  type CompactInstructionsLease,
  compactInstructionsPrompt,
  installSummaryHook,
  summaryReasoningEffort,
  summaryRequestProblem,
} from '../compactInstructions.ts';
import {
  isSessionStub,
  STUB_COMPACT_INSTRUCTIONS_MAX_CHARS,
  STUB_COMPACT_INSTRUCTIONS_MAX_ENTRIES,
  stubCompactInstructions,
  withCompactInstructionsNote,
} from '../stub.ts';

/**
 * dsh-rebase decision 179 — `/compact <instructions>`: the summary hook of
 * DSH's compaction service, wrapped once per instance. A session with a lease
 * out has its summary request extended after DSH's template; every other
 * call is the original's. An engine that cannot carry them is refused before
 * anything runs, and a request of another shape is never sent.
 */

const TEMPLATE = 'You are now acting as a compaction engine for this AI coding assistant.';

interface Message {
  role: string;
  content: { type: string; text?: string }[];
}

function text(value: string): Message {
  return { role: 'user', content: [{ type: 'text', text: value }] };
}

function agentOf(
  sessionId: string,
  config: Record<string, unknown> = { provider: 'p', model: 'm' }
) {
  return {
    options: {},
    session: {
      id: sessionId,
      requestHeader: () => ({ config }),
      toolHistory: () => [],
    },
  };
}

/**
 * The shape of `dsh-compaction-basic`'s hook: the conversation, then the
 * template as one more user message, streamed through `this.ctx.llm`.
 * `variant` bends one thing for the fail-safe cases.
 */
function fakeEngine(
  variant:
    | 'dsh'
    | 'no-model-call'
    | 'throws'
    | 'system-template'
    | 'two-calls'
    | 'drops-on-long' = 'dsh'
) {
  const requests: {
    messages: Message[];
    purpose?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  }[] = [];
  const engine = {
    ctx: {
      llm: {
        stream(options: { messages: Message[]; purpose?: string }) {
          requests.push(options);
          return 'stream';
        },
      },
    },
    async summarize(
      this: { ctx: { llm: { stream(options: unknown): unknown } } },
      input: { messages: Message[] },
      agent: {
        session: {
          id: string;
          requestHeader(): { config: { provider?: string; model?: string } } | undefined;
        };
      }
    ) {
      if (variant === 'no-model-call') return { summary: [] };
      if (variant === 'throws') throw new Error('engine broke');
      const instruction = Object.freeze(text(TEMPLATE));
      const messages =
        variant === 'system-template'
          ? [{ role: 'system', content: [{ type: 'text', text: TEMPLATE }] }, ...input.messages]
          : variant === 'drops-on-long' && input.messages.length > 2
            ? [...input.messages.slice(1), instruction]
            : [...input.messages, instruction];
      // DSH routes the summary where the conversation's latest request went.
      const latest = agent.session.requestHeader()?.config;
      const options = {
        provider: latest?.provider,
        model: latest?.model,
        messages,
        purpose: 'compaction',
        sessionId: agent.session.id,
      };
      if (variant === 'two-calls') {
        try {
          this.ctx.llm.stream(options);
        } catch {
          // Asked again below, as a hook that retries would.
        }
      }
      this.ctx.llm.stream(options);
      return { summary: [{ type: 'text', text: '## Current Work\n- (none)' }] };
    },
  };
  return { engine, requests };
}

function leaseOf(armed: CompactInstructionsArm): CompactInstructionsLease {
  if (armed.kind !== 'armed') throw new Error(`not armed: ${JSON.stringify(armed)}`);
  return armed.lease;
}

const conversation = [text('first prompt'), { role: 'assistant', content: [] }];

describe('compact instructions — the wrapped summary hook (decision 179)', () => {
  it('[179-H-01] a session without a lease goes through as DSH sent it', async () => {
    const { engine, requests } = fakeEngine();
    const original = engine.summarize;
    leaseOf(await armCompactInstructions(engine, 'other', 'keep the plan')).release();
    expect(engine.summarize).not.toBe(original);

    await engine.summarize({ messages: conversation }, agentOf('s1'));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.at(-1)).toEqual(text(TEMPLATE));
    expect(requests[0]?.messages.slice(0, -1)).toEqual(conversation);
  });

  it('[179-H-02] a leased session: the instructions follow the template, nothing before it changes', async () => {
    const { engine, requests } = fakeEngine();
    const lease = leaseOf(await armCompactInstructions(engine, 's1', '保留未完成的任务和失败经验'));
    expect(lease.applied).toBe(false);

    await engine.summarize({ messages: conversation }, agentOf('s1'));

    const sent = requests[0]?.messages ?? [];
    expect(sent).toHaveLength(conversation.length + 1);
    // The cached prefix: the very same message objects.
    for (const [index, message] of sent.slice(0, -1).entries()) {
      expect(message).toBe(conversation[index]);
    }
    expect(sent.at(-1)).toEqual(
      text(`${TEMPLATE}\n\n${compactInstructionsPrompt('保留未完成的任务和失败经验')}`)
    );
    expect(lease.applied).toBe(true);
    expect(lease.refused).toBeUndefined();

    // Released: the next summary (an automatic one, say) is DSH's own again.
    lease.release();
    await engine.summarize({ messages: conversation }, agentOf('s1'));
    expect(requests[1]?.messages.at(-1)).toEqual(text(TEMPLATE));
  });

  it('[179-H-03] two sessions at once each get their own; a second lease of one session is busy', async () => {
    const { engine, requests } = fakeEngine();
    const one = leaseOf(await armCompactInstructions(engine, 's1', 'keep the API decisions'));
    const two = leaseOf(await armCompactInstructions(engine, 's2', 'keep the failing tests'));
    expect((await armCompactInstructions(engine, 's1', 'something else')).kind).toBe('busy');

    await engine.summarize({ messages: conversation }, agentOf('s2'));
    await engine.summarize({ messages: conversation }, agentOf('s1'));

    expect(requests[0]?.messages.at(-1)?.content[0]?.text).toContain('keep the failing tests');
    expect(requests[1]?.messages.at(-1)?.content[0]?.text).toContain('keep the API decisions');
    // A release lifts only its own lease, however often it is called.
    one.release();
    const again = leaseOf(await armCompactInstructions(engine, 's1', 'later'));
    one.release();
    await engine.summarize({ messages: conversation }, agentOf('s1'));
    expect(requests[2]?.messages.at(-1)?.content[0]?.text).toContain('later');
    again.release();
    two.release();
  });

  it('[179-H-04] an engine that cannot carry them is refused before anything runs, and left as it was', async () => {
    expect(await armCompactInstructions(undefined, 's1', 'x')).toEqual({
      kind: 'unsupported',
      reason: 'this host has no compaction service',
    });
    expect(await armCompactInstructions({ ctx: {} }, 's1', 'x')).toEqual({
      kind: 'unsupported',
      reason: 'the compaction service has no summary hook',
    });
    const cases: [Parameters<typeof fakeEngine>[0], RegExp, boolean][] = [
      ['no-model-call', /finished without asking the model/, false],
      ['throws', /failed before asking the model: engine broke/, false],
      // Decision 181: one summary request, of another shape: wrapped for its
      // reasoning effort, still no instructions.
      ['system-template', /message 0 of the summary request is not the conversation's/, true],
      ['two-calls', /asked the model 2 times/, false],
    ];
    for (const [variant, reason, wrapsForEffort] of cases) {
      const { engine, requests } = fakeEngine(variant);
      const original = engine.summarize;
      const armed = await armCompactInstructions(engine, 's1', 'x');
      expect(armed.kind, variant).toBe('unsupported');
      expect(armed.kind === 'unsupported' ? armed.reason : '', variant).toMatch(reason);
      // Nothing was sent by the dry run; only a hook asking once is wrapped.
      expect(requests, variant).toEqual([]);
      if (wrapsForEffort) expect(engine.summarize, variant).not.toBe(original);
      else expect(engine.summarize, variant).toBe(original);
      expect((await installSummaryHook(engine)).kind, variant).toBe(
        wrapsForEffort ? 'wrapped' : 'unsupported'
      );
      // Asked again: the same answer, without a second dry run.
      expect((await armCompactInstructions(engine, 's1', 'x')).kind, variant).toBe('unsupported');
    }
  });

  it('[179-H-05] a real request of another shape is not sent: the lease is refused, the hook unsupported', async () => {
    const { engine, requests } = fakeEngine('drops-on-long');
    const lease = leaseOf(await armCompactInstructions(engine, 's1', 'keep it'));
    const longer = [...conversation, text('another prompt')];

    await expect(engine.summarize({ messages: longer }, agentOf('s1'))).rejects.toThrow(
      /instructions for \/compact cannot be added: the summary request has 3 messages/
    );

    expect(requests).toEqual([]);
    expect(lease.applied).toBe(false);
    expect(lease.refused).toMatch(/has 3 messages/);
    lease.release();
    expect(await armCompactInstructions(engine, 's1', 'again')).toMatchObject({
      kind: 'unsupported',
    });
    // Without a lease the hook is DSH's own, as before.
    await engine.summarize({ messages: longer }, agentOf('s1'));
    expect(requests).toHaveLength(1);
  });

  it('[179-H-06] a summary written without the hook marks it unsupported (markUnused)', async () => {
    const { engine } = fakeEngine();
    const lease = leaseOf(await armCompactInstructions(engine, 's1', 'keep it'));
    lease.markUnused();
    lease.release();
    expect((await armCompactInstructions(engine, 's1', 'again')).kind).toBe('unsupported');
  });

  it("[179-H-07] Cordis's traceable proxy: the hook is wrapped on the instance behind it", async () => {
    const { engine, requests } = fakeEngine();
    const traced = new Proxy(engine, {
      get: (target, key) =>
        key === Symbol.for('cordis.original') ? target : Reflect.get(target, key),
    });
    const lease = leaseOf(await armCompactInstructions(traced, 's1', 'keep it'));
    // DSH calls the hook on the instance (`this.summarize` in `regionDependencies`).
    await engine.summarize({ messages: conversation }, agentOf('s1'));
    expect(requests[0]?.messages.at(-1)?.content[0]?.text).toContain('keep it');
    lease.release();
    // One installation per instance, whichever handle reached it.
    expect((await armCompactInstructions(engine, 's1', 'x')).kind).toBe('armed');
  });

  it('[179-H-08] the shape check names what differs', () => {
    const input = { messages: conversation };
    const ok = { purpose: 'compaction', messages: [...conversation, text(TEMPLATE)] };
    expect(summaryRequestProblem(ok, input)).toBeUndefined();
    // A copy of the conversation is as good as the same objects.
    expect(
      summaryRequestProblem(
        { ...ok, messages: [...structuredClone(conversation), text(TEMPLATE)] },
        input
      )
    ).toBeUndefined();
    expect(summaryRequestProblem({ ...ok, purpose: 'chat' }, input)).toMatch(/purpose chat/);
    expect(
      summaryRequestProblem(
        { ...ok, messages: [text('changed'), conversation[1], text(TEMPLATE)] },
        input
      )
    ).toMatch(/message 0/);
    expect(
      summaryRequestProblem(
        { ...ok, messages: [...conversation, { role: 'assistant', content: [] }] },
        input
      )
    ).toMatch(/not a user message/);
    expect(
      summaryRequestProblem(
        { ...ok, messages: [...conversation, { role: 'user', content: [{ type: 'image' }] }] },
        input
      )
    ).toMatch(/not text/);
  });
});

/**
 * The upgrade check: the hook of the `dsh-compaction-basic` this host ships,
 * run against a stand-in model service. If DSH moves the template, renames
 * the hook or stops calling it through `this.ctx.llm.stream`, this fails here
 * before a person sees `/compact <instructions>` refused.
 */
describe("compact instructions — DSH's own summary hook (decision 179 §4)", () => {
  function dshEngine() {
    const requests: {
      messages: Message[];
      purpose?: string;
      maxTokens?: number;
      provider?: string;
      model?: string;
      reasoningEffort?: string;
    }[] = [];
    const stop = new Error('stop after the request');
    const instance = Object.create(BasicCompactionEngine.prototype) as Record<string, unknown>;
    instance.config = {
      thresholdRatio: 0.8,
      headroomTokens: 65536,
      retainRatio: 0.16,
      summarizationProvider: '',
      summarizationModel: '',
      maxTokens: 8192,
      compactionRetries: 1,
      maxOverflowRetries: 1,
      modelPolicies: [],
      auto: true,
    };
    instance.ctx = {
      llm: {
        stream(options: { messages: Message[] }) {
          requests.push(options);
          throw stop;
        },
      },
    };
    return { instance, requests, stop };
  }

  it('[179-H-09] passes the dry run, and a leased summary is DSH’s request with the instructions last', async () => {
    const { instance, requests, stop } = dshEngine();
    const lease = leaseOf(await armCompactInstructions(instance, 's1', 'keep the open tasks'));
    const summarize = instance.summarize as (
      input: unknown,
      agent: unknown,
      signal?: AbortSignal
    ) => Promise<unknown>;

    await expect(summarize.call(instance, { messages: conversation }, agentOf('s1'))).rejects.toBe(
      stop
    );
    lease.release();
    await expect(summarize.call(instance, { messages: conversation }, agentOf('s1'))).rejects.toBe(
      stop
    );

    const [leased, plain] = requests;
    expect(leased?.purpose).toBe('compaction');
    expect(plain?.purpose).toBe('compaction');
    const template = plain?.messages.at(-1)?.content[0]?.text ?? '';
    expect(template).toMatch(/^You are now acting as a compaction engine/);
    expect(template).toContain('## Pending Jobs');
    expect(template).toContain('## Critical Context');
    expect(leased?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: `${template}\n\n${compactInstructionsPrompt('keep the open tasks')}` },
    ]);
    // Everything before the instruction is the conversation, in both.
    expect(leased?.messages.slice(0, -1)).toEqual(conversation);
    expect(plain?.messages.slice(0, -1)).toEqual(conversation);
    expect(leased?.maxTokens).toBe(plain?.maxTokens);
  });

  it('[181-H-10] DSH’s own summary request, wrapped: the conversation’s route, model and level', async () => {
    const { instance, requests, stop } = dshEngine();
    expect(
      await installSummaryHook(instance, {
        efforts: (provider) => (provider === 'gw' ? ['off', 'low', 'medium', 'high'] : undefined),
      })
    ).toEqual({ kind: 'wrapped' });
    const summarize = instance.summarize as (
      input: unknown,
      agent: unknown,
      signal?: AbortSignal
    ) => Promise<unknown>;
    const agent = agentOf('s1', { provider: 'gw', model: 'sol', reasoningEffort: 'high' });
    await expect(summarize.call(instance, { messages: conversation }, agent)).rejects.toBe(stop);
    // Without the wrapping DSH names no level (pi-ai would send the model's `off`).
    expect(requests[0]).toMatchObject({
      provider: 'gw',
      model: 'sol',
      purpose: 'compaction',
      reasoningEffort: 'high',
    });
    // A summarizer routed elsewhere by the row's config: that model's lowest level.
    instance.config = {
      ...(instance.config as object),
      summarizationProvider: 'gw',
      summarizationModel: 'mini',
    };
    await expect(
      summarize.call(
        instance,
        { messages: conversation },
        agentOf('s1', { provider: 'claude', model: 'opus', reasoningEffort: 'max' })
      )
    ).rejects.toBe(stop);
    expect(requests[1]).toMatchObject({ provider: 'gw', model: 'mini', reasoningEffort: 'low' });
  });
});

/**
 * dsh-rebase decision 181 — every summary request names a reasoning effort:
 * the conversation's latest request's on the same route and model (none
 * included), else the lowest level the plan offers besides `off`. DSH names
 * none, and pi-ai then sends the model's `off` (`'none'` on OpenAI
 * Responses: GPT 6.1 Sol refuses it with a 400).
 */
describe('summary requests name the conversation’s reasoning effort (decision 181)', () => {
  const GPT = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
  // Decision 141: an adaptive-only Claude row never offers `off`.
  const CLAUDE = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

  it('[181-E-01] the rule: the request’s own, the conversation’s, else the lowest besides off', () => {
    const request = { provider: 'gw', model: 'sol' };
    const pick = (
      latest: Record<string, unknown> | undefined,
      offered: readonly string[] | undefined,
      own: Record<string, unknown> = request
    ) => summaryReasoningEffort({ request: own, latest, offered });
    // The conversation's level, as it was sent.
    expect(pick({ ...request, reasoningEffort: 'high' }, GPT)).toEqual({
      effort: 'high',
      source: 'conversation',
    });
    // Its `off` too: the same request the turns went out with.
    expect(pick({ ...request, reasoningEffort: 'off' }, GPT)).toEqual({
      effort: 'off',
      source: 'conversation',
    });
    // It named none: none, as its turns did.
    expect(pick({ ...request }, GPT)).toEqual({ effort: undefined, source: 'conversation' });
    // No plan to check against: taken as it stands.
    expect(pick({ ...request, reasoningEffort: 'max' }, undefined)).toEqual({
      effort: 'max',
      source: 'conversation',
    });
    // Never a request on this model (none at all, another model, another
    // route): the lowest level besides off, never off itself.
    expect(pick(undefined, GPT)).toEqual({ effort: 'low', source: 'lowest' });
    expect(pick({ provider: 'gw', model: 'luna', reasoningEffort: 'off' }, GPT)).toEqual({
      effort: 'low',
      source: 'lowest',
    });
    expect(pick({ provider: 'other', model: 'sol', reasoningEffort: 'high' }, CLAUDE)).toEqual({
      effort: 'low',
      source: 'lowest',
    });
    expect(pick(undefined, ['off', 'minimal', 'low'])).toEqual({
      effort: 'minimal',
      source: 'lowest',
    });
    // A level the plan stopped offering (a new plan since that request).
    expect(pick({ ...request, reasoningEffort: 'xhigh' }, ['off', 'low', 'high'])).toEqual({
      effort: 'low',
      source: 'lowest',
    });
    // Nothing to name: a model that does not think, or one the plan does not serve.
    expect(pick(undefined, [])).toEqual({ effort: undefined, source: 'none' });
    expect(pick(undefined, ['off'])).toEqual({ effort: undefined, source: 'none' });
    expect(pick(undefined, undefined)).toEqual({ effort: undefined, source: 'none' });
    // One the request names already stays.
    expect(pick(undefined, GPT, { ...request, reasoningEffort: 'medium' })).toEqual({
      effort: 'medium',
      source: 'request',
    });
  });

  it('[181-E-02] every summary of a session goes out at its latest request’s level, instructions or not', async () => {
    const { engine, requests } = fakeEngine();
    const logged: string[] = [];
    expect(
      await installSummaryHook(engine, {
        efforts: (provider, model) => (provider === 'gw' && model === 'sol' ? GPT : undefined),
        log: (...args) => logged.push(args.join(' ')),
      })
    ).toEqual({ kind: 'wrapped' });
    const agent = agentOf('s1', { provider: 'gw', model: 'sol', reasoningEffort: 'xhigh' });

    // An automatic compaction: no lease.
    await engine.summarize({ messages: conversation }, agent);
    // A `/compact` with instructions: both.
    const lease = leaseOf(await armCompactInstructions(engine, 's1', 'keep it'));
    await engine.summarize({ messages: conversation }, agent);
    lease.release();

    expect(requests.map((request) => request.reasoningEffort)).toEqual(['xhigh', 'xhigh']);
    expect(requests[1]?.messages.at(-1)?.content[0]?.text).toContain('keep it');
    // Nothing else of the request moves: the cached prefix is the same objects.
    for (const request of requests) {
      expect(request.provider).toBe('gw');
      expect(request.model).toBe('sol');
      for (const [index, message] of request.messages.slice(0, -1).entries()) {
        expect(message).toBe(conversation[index]);
      }
    }
    expect(logged).toEqual([
      '[dsh-bridge] summary request of s1 on gw/sol: reasoning effort xhigh (conversation)',
      '[dsh-bridge] summary request of s1 on gw/sol: reasoning effort xhigh (conversation)',
    ]);
  });

  it('[181-E-03] a session with no request on its model: the lowest level besides off', async () => {
    const { engine, requests } = fakeEngine();
    await installSummaryHook(engine, {
      efforts: (provider) => (provider === 'claude' ? CLAUDE : provider === 'gpt' ? GPT : []),
    });
    // DSH falls back to the agent's model when no request was routed: here
    // the header names the route, without an effort of the same model.
    await engine.summarize(
      { messages: conversation },
      agentOf('s1', { provider: 'gpt', model: 'sol' })
    );
    await engine.summarize(
      { messages: conversation },
      agentOf('s2', { provider: 'claude', model: 'opus', reasoningEffort: 'off' })
    );
    // A model that does not think: nothing named, as before.
    await engine.summarize(
      { messages: conversation },
      agentOf('s3', { provider: 'plain', model: 'x' })
    );
    // `gpt`: the conversation named none, so none (its turns' own request).
    // `claude`: `off` is not offered there (decision 141), so the lowest level.
    expect(requests.map((request) => request.reasoningEffort)).toEqual([
      undefined,
      'low',
      undefined,
    ]);
  });

  it('[181-E-04] a hook that is not one summary request is left as DSH ships it, and said so', async () => {
    const { engine, requests } = fakeEngine('two-calls');
    const original = engine.summarize;
    const logged: unknown[][] = [];
    const state = await installSummaryHook(engine, { log: (...args) => logged.push(args) });
    expect(state).toEqual({
      kind: 'unsupported',
      reason: 'the summary hook asked the model 2 times',
    });
    expect(engine.summarize).toBe(original);
    expect(requests).toEqual([]);
    expect(String(logged[0]?.[0])).toContain('summary hook left as DSH ships it');
    expect(await installSummaryHook(undefined)).toEqual({
      kind: 'unsupported',
      reason: 'this host has no compaction service',
    });
  });
});

describe('compact instructions — what the stub keeps (decision 179)', () => {
  it('[179-STUB-1] newest last, one per compaction, the oldest dropped past either bound', () => {
    const entry = (id: string, size = 10) => ({
      compactionId: id,
      instructions: 'x'.repeat(size),
      at: 1,
    });
    let list = withCompactInstructionsNote([], entry('a'));
    list = withCompactInstructionsNote(list, entry('b'));
    list = withCompactInstructionsNote(list, { ...entry('a'), instructions: 'again' });
    expect(list.map((item) => item.compactionId)).toEqual(['b', 'a']);
    for (let index = 0; index < STUB_COMPACT_INSTRUCTIONS_MAX_ENTRIES + 5; index += 1) {
      list = withCompactInstructionsNote(list, entry(`n${index}`));
    }
    expect(list).toHaveLength(STUB_COMPACT_INSTRUCTIONS_MAX_ENTRIES);
    expect(list.at(-1)?.compactionId).toBe(`n${STUB_COMPACT_INSTRUCTIONS_MAX_ENTRIES + 4}`);
    for (let index = 0; index < 10; index += 1) {
      list = withCompactInstructionsNote(list, entry(`big${index}`, 2000));
    }
    expect(list.reduce((total, item) => total + item.instructions.length, 0)).toBeLessThanOrEqual(
      STUB_COMPACT_INSTRUCTIONS_MAX_CHARS
    );
    expect(list.at(-1)?.compactionId).toBe('big9');
  });

  it('[179-STUB-2] a malformed list costs its entries, never the stub', () => {
    const stub = {
      engine: 'dsh' as const,
      version: 2 as const,
      dshSessionId: 'aiclient-x',
      logicalSessionId: 'x',
      cwd: '/repo',
      createdAt: 1,
      compactInstructions: [
        { compactionId: 'k1', instructions: 'keep it', at: 5 },
        { compactionId: 'k2', instructions: '' },
        { compactionId: 3, instructions: 'x' },
        null,
        { compactionId: 'k4', instructions: 'no time' },
      ],
    };
    expect(isSessionStub(stub)).toBe(true);
    expect(stubCompactInstructions(stub as never)).toEqual([
      { compactionId: 'k1', instructions: 'keep it', at: 5 },
      { compactionId: 'k4', instructions: 'no time', at: 0 },
    ]);
    expect(stubCompactInstructions({ ...stub, compactInstructions: 'nope' } as never)).toEqual([]);
  });
});
