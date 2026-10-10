import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyCacheChain,
  CACHE_CHAIN_STATE_VERSION,
  type CacheChainEvent,
  type CacheChainOptions,
  type CacheStepVerdict,
  foldCacheChain,
  initCacheChain,
  isNotableVerdict,
  isUnexplainedVerdict,
  lastStepVerdict,
  MATCH_WINDOW,
  MAX_KEPT_VERDICTS,
  restoreCacheChain,
  viewCacheChain,
} from '../cacheChain.ts';

/**
 * Issue #9: the prompt-cache chain of a session log, judged step by step —
 * first over the sanitized log of the incident, then over synthetic logs, one
 * rule each.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface FixtureEvent {
  type: string;
  seq: number;
  t: number;
  data?: Record<string, unknown>;
}

/**
 * The incident's log. The sanitizer wrote relative times as `t` and each
 * step's route as `data.provider` / `data.model`; put both back where DSH
 * writes them: `time`, and the assistant message's `source`.
 */
function issue9Events(): CacheChainEvent[] {
  const url = new URL('./fixtures/cacheChain/issue-9.sanitized.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(url, 'utf8')) as { events: FixtureEvent[] };
  return fixture.events.map(({ type, seq, t, data }) => {
    if (type !== 'assistant/message' || !data) return { type, seq, time: t, data };
    const { provider, model, ...rest } = data;
    return {
      type,
      seq,
      time: t,
      data: { ...rest, message: { role: 'assistant', source: { kind: 'model', provider, model } } },
    };
  });
}

/** The incident's routes: Claude is followed, with the 1-hour TTL; the GLM route is not. */
const ISSUE_9: CacheChainOptions = {
  cacheAware: (provider) => provider === 'claude',
  ttlMsFor: (provider) => (provider === 'claude' ? HOUR : undefined),
};

describe('the issue #9 log', () => {
  const events = issue9Events();
  const { totals, verdicts } = viewCacheChain(foldCacheChain(events, ISSUE_9));
  const at = (turn: number, step: number): CacheStepVerdict => {
    const verdict = verdicts.find((entry) => entry.turn === turn && entry.step === step);
    if (!verdict) throw new Error(`no verdict for turn ${turn} step ${step}`);
    return verdict;
  };

  it('opens cold, and shrinks at step 2 with nothing local to explain it', () => {
    // The first system prompt is no cause; the plan mode entered before the
    // first step is one, on a step with nothing to compare.
    expect(at(1, 1)).toMatchObject({ kind: 'cold', prompt: 43_975, causes: ['plan-mode'] });
    expect(at(1, 2)).toMatchObject({
      kind: 'shrink',
      prompt: 24_115,
      prevPrompt: 43_975,
      lost: 43_975,
      explained: false,
    });
    expect(isUnexplainedVerdict(at(1, 2))).toBe(true);
  });

  it('sees requests alternating between two caches', () => {
    expect(at(1, 3)).toMatchObject({ kind: 'warm', read: 43_973, matched: { turn: 1, step: 1 } });
    expect(isNotableVerdict(at(1, 3))).toBe(true);
    expect(at(1, 4)).toMatchObject({ read: 24_113, matched: { turn: 1, step: 2 } });
    expect(at(1, 6)).toMatchObject({
      kind: 'rebuild',
      lost: 12_675,
      matched: { turn: 1, step: 1 },
    });
    expect(
      verdicts.filter((entry) => entry.matched).map((entry) => [entry.step, entry.matched?.step])
    ).toEqual([
      [3, 1],
      [4, 2],
      [6, 1],
      [8, 5],
      [9, 1],
      [11, 1],
      [37, 33],
      [39, 37],
      [43, 39],
      [74, 69],
    ]);
  });

  it('flags step 17, back to the 36,848-token prefix, as an unexplained rebuild', () => {
    // Its baseline is step 16, which (like step 15) reported a shorter prompt than step 14.
    expect(at(1, 17)).toMatchObject({
      kind: 'rebuild',
      read: 36_848,
      prevPrompt: 157_890,
      lost: 121_042,
      explained: false,
    });
  });

  it('explains step 69 by the plan-mode exit, and finds step 70 warm', () => {
    const step69 = at(1, 69);
    expect(step69.kind).toBe('shrink');
    expect(step69.causes).toEqual(expect.arrayContaining(['system-prompt', 'plan-mode', 'series']));
    // 47 minutes after step 68's request started: inside the hour.
    expect(step69.causes).not.toContain('ttl-expired');
    expect(step69.gapMs).toBe(7_815_894 - 4_982_445);
    expect(step69.explained).toBe(true);
    expect(isNotableVerdict(step69)).toBe(true);
    expect(isUnexplainedVerdict(step69)).toBe(false);
    expect(at(1, 70)).toMatchObject({ kind: 'warm', read: 325_119, causes: [] });
    expect(isNotableVerdict(at(1, 70))).toBe(false);
  });

  it('flags the jump to 717k tokens at step 73 and the fall back at step 74', () => {
    expect(at(1, 73)).toMatchObject({
      kind: 'rebuild',
      read: 0,
      prompt: 717_566,
      explained: false,
    });
    expect(at(1, 74)).toMatchObject({ kind: 'shrink', read: 325_119, explained: false });
  });

  it('records the GLM turn without judging it', () => {
    const turn2 = verdicts.filter((entry) => entry.turn === 2);
    expect(turn2).toHaveLength(131);
    expect(turn2.every((entry) => entry.kind === 'untracked' && !isNotableVerdict(entry))).toBe(
      true
    );
    expect(at(2, 1).causes).toEqual(['seed', 'resume', 'model', 'route']);
  });

  it('pins the unexplained steps and the totals', () => {
    expect(verdicts.filter(isUnexplainedVerdict).map((entry) => entry.step)).toEqual([
      2, 3, 4, 6, 8, 9, 10, 11, 15, 17, 30, 31, 33, 34, 37, 38, 39, 40, 43, 44, 55, 59, 63, 73, 74,
      79, 81,
    ]);
    // 88 Claude steps: one cold, 87 judged (63 warm, 17 shrinks, 7 rebuilds);
    // 24 lossy plus 4 warm ones that read another chain's cache are notable,
    // and only step 69 (362,578 tokens lost) is explained.
    expect(totals).toEqual({
      steps: 219,
      evaluated: 87,
      rebuilds: 7,
      shrinks: 17,
      unexplained: 27,
      lostTokens: 5_668_498,
      unexplainedLostTokens: 5_305_920,
    });
  });

  it('survives a JSON round trip mid-step, and skips what it already holds', () => {
    const whole = foldCacheChain(events, ISSUE_9);
    // Cut after step 69's header: its causes are collected, its verdict not yet made.
    const cut = events.findIndex((event) => event.seq === 458) + 1;
    const first = foldCacheChain(events.slice(0, cut), ISSUE_9);
    expect(first.causes).toEqual(['plan-mode', 'system-prompt', 'series']);
    const copy: unknown = JSON.parse(JSON.stringify(first));
    expect(copy).toStrictEqual(first);
    const restored = restoreCacheChain(copy);
    if (!restored) throw new Error('the round trip was refused');
    for (const event of events.slice(cut)) applyCacheChain(restored, event, ISSUE_9);
    expect(restored).toStrictEqual(whole);
    for (const event of events) expect(applyCacheChain(restored, event, ISSUE_9)).toBeUndefined();
    expect(restored).toStrictEqual(whole);
  });
});

// ---- synthetic logs --------------------------------------------------------------

const CLAUDE = { provider: 'claude', model: 'claude-opus-5-5' };
const GLM = { provider: 'zhipu-ai-glm', model: 'glm-5.3' };

/** Follows Claude with the default TTL. */
const FOLLOW_CLAUDE: CacheChainOptions = {
  cacheAware: (provider) => provider === 'claude',
  ttlMsFor: () => undefined,
};

const TOOLS = [
  { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
  { name: 'bash', description: 'Run a command.', parameters: { type: 'object' } },
];

function header(reason: string, config: Record<string, unknown> = {}, tools: unknown = TOOLS) {
  return {
    reason,
    header: {
      config: { ...CLAUDE, reasoningEffort: 'max', maxTokens: 128_000, ...config },
      tools,
    },
  };
}

interface StepUsage {
  input?: number;
  read?: number;
  write?: number;
}

/** A log written in order: each event one seq on, at `now` unless timed. */
class Log {
  readonly events: CacheChainEvent[] = [];
  private seq = 0;
  private now = 0;

  event(type: string, data: unknown = {}, at = this.now): this {
    this.now = at;
    this.events.push({ type, seq: this.seq, time: at, data });
    this.seq += 1;
    return this;
  }

  /** A step whose request starts `after` ms from now and answers `takes` ms later. */
  step(
    turn: number,
    step: number,
    usage: StepUsage,
    { after = 1_000, takes = 1_000, route = CLAUDE } = {}
  ): this {
    this.event('step/start', { turn, step }, this.now + after);
    this.event(
      'assistant/message',
      {
        turn,
        step,
        message: { role: 'assistant', source: { kind: 'model', ...route }, content: [] },
        usage: {
          inputTokens: usage.input ?? 2,
          outputTokens: 50,
          ...(usage.read ? { cacheReadTokens: usage.read } : {}),
          ...(usage.write ? { cacheWriteTokens: usage.write } : {}),
        },
      },
      this.now + takes
    );
    return this.event('step/end', { turn, step });
  }

  /** `count` steps that each read all the step before cached and cache what they add. */
  appendOnly(turn: number, count: number, first = 10_000, grow = 2_000): this {
    let cached = 0;
    for (let step = 1; step <= count; step += 1) {
      const prompt = first + (step - 1) * grow;
      this.step(turn, step, { read: cached, write: prompt - 2 - cached });
      cached = prompt - 2;
    }
    return this;
  }

  fold(options: CacheChainOptions = FOLLOW_CLAUDE) {
    return foldCacheChain(this.events, options);
  }

  last(options?: CacheChainOptions): CacheStepVerdict | undefined {
    return lastStepVerdict(this.fold(options));
  }
}

describe('the cache chain', () => {
  it('calls an append-only chain cold, then warm', () => {
    const { verdicts, totals } = viewCacheChain(new Log().appendOnly(1, 5).fold());
    expect(verdicts.map((entry) => entry.kind)).toEqual(['cold', 'warm', 'warm', 'warm', 'warm']);
    expect(verdicts.map((entry) => entry.lost)).toEqual([0, 2, 2, 2, 2]);
    expect(totals).toEqual({
      steps: 5,
      evaluated: 4,
      rebuilds: 0,
      shrinks: 0,
      unexplained: 0,
      lostTokens: 0,
      unexplainedLostTokens: 0,
    });
  });

  it('returns the verdict of the step an event recorded, and hands out views that stay put', () => {
    const log = new Log().appendOnly(1, 2);
    const state = initCacheChain();
    const returned = log.events.map((event) => applyCacheChain(state, event, FOLLOW_CLAUDE));
    expect(returned.filter(Boolean)).toEqual(viewCacheChain(state).verdicts);
    expect(lastStepVerdict(state)).toBe(returned.findLast(Boolean));
    const early = viewCacheChain(state);
    applyCacheChain(
      state,
      { type: 'step/start', seq: 99, data: { turn: 1, step: 3 } },
      FOLLOW_CLAUDE
    );
    applyCacheChain(
      state,
      {
        type: 'assistant/message',
        seq: 100,
        data: { turn: 1, step: 3, usage: { inputTokens: 9 } },
      },
      FOLLOW_CLAUDE
    );
    expect(early.verdicts).toHaveLength(2);
    expect(early.totals.steps).toBe(2);
    expect(viewCacheChain(state).totals.steps).toBe(3);
  });

  it('explains a loss by a compaction since the step before', () => {
    const log = new Log()
      .appendOnly(1, 3)
      .event('compaction/start', { compactionId: 'c1', turn: 1 })
      .event('compaction/summary', { compactionId: 'c1' })
      .event('user/message', { source: { kind: 'compact-checkpoint' } })
      .event('compaction/end', { compactionId: 'c1', turn: 1 })
      .step(1, 4, { read: 3_000, write: 2_000 });
    const verdict = log.last();
    expect(verdict).toMatchObject({ kind: 'shrink', explained: true, causes: ['compaction'] });
    expect(verdict && isNotableVerdict(verdict)).toBe(true);
    expect(verdict && isUnexplainedVerdict(verdict)).toBe(false);
  });

  it('explains a rebuild by a resumed loop', () => {
    const log = new Log()
      .event('request/header', header('initial'))
      .appendOnly(1, 2)
      .event('request/header', header('resume'))
      .step(1, 3, { write: 14_000 });
    expect(log.last()).toMatchObject({ kind: 'rebuild', causes: ['resume'], explained: true });
  });

  const reordered = TOOLS.map(({ parameters, description, name }) => ({
    parameters,
    description,
    name,
  }));

  it.each([
    ['another model', { model: 'claude-sonnet-5' }, TOOLS, ['model']],
    ['another effort', { reasoningEffort: 'high' }, TOOLS, ['effort']],
    ['another tool set', {}, TOOLS.slice(1), ['tools']],
    ['the same tools, keys reordered', {}, reordered, ['header']],
    ['nothing it compares', { maxTokens: 64_000 }, TOOLS, ['header']],
  ])('names a `change` header by what changed: %s', (_label, config, tools, causes) => {
    const log = new Log()
      .event('request/header', header('initial'))
      .appendOnly(1, 2)
      .event('request/header', header('change', config, tools))
      .step(1, 3, { write: 14_000 });
    expect(log.last()).toMatchObject({ kind: 'rebuild', causes, explained: true });
  });

  it('counts a changed route, not the first one nor a repeat', () => {
    const context = (contextWindow: number) => ({ ...CLAUDE, contextWindow });
    const log = new Log()
      .event('request/context', context(200_000))
      .step(1, 1, { write: 10_000 })
      .event('request/context', context(200_000))
      .step(1, 2, { read: 10_000, write: 1_000 })
      .event('request/context', context(1_000_000))
      .step(1, 3, { write: 11_500 });
    expect(viewCacheChain(log.fold()).verdicts.map((entry) => entry.causes)).toEqual([
      [],
      [],
      ['route'],
    ]);
  });

  it('blames the TTL by request start, so a long generation counts', () => {
    // Step 1 generated for 4 minutes; step 2 started 2 minutes after it answered.
    const log = new Log()
      .step(1, 1, { write: 20_000 }, { takes: 4 * MINUTE })
      .step(1, 2, { write: 22_000 }, { after: 2 * MINUTE });
    expect(log.last()).toMatchObject({
      kind: 'rebuild',
      gapMs: 6 * MINUTE,
      causes: ['ttl-expired'],
      explained: true,
    });
    // The route's own TTL, when it names one.
    expect(log.last({ ...FOLLOW_CLAUDE, ttlMsFor: () => HOUR })).toMatchObject({
      kind: 'rebuild',
      causes: [],
      explained: false,
    });
    const quick = new Log()
      .step(1, 1, { write: 20_000 }, { takes: MINUTE })
      .step(1, 2, { write: 22_000 }, { after: 2 * MINUTE });
    expect(quick.last()).toMatchObject({ gapMs: 3 * MINUTE, causes: [], explained: false });
  });

  it('times a retried step from its last attempt', () => {
    const log = new Log()
      .step(1, 1, { write: 20_000 })
      .event('step/start', { turn: 1, step: 2 }, 3_000)
      .event('assistant/attempt', { turn: 1, step: 2 }, 3_000 + 4 * MINUTE)
      .event(
        'assistant/message',
        {
          turn: 1,
          step: 2,
          message: { role: 'assistant', source: { kind: 'model', ...CLAUDE }, content: [] },
          usage: { inputTokens: 2, outputTokens: 9, cacheReadTokens: 20_000 },
        },
        3_000 + 5 * MINUTE
      );
    expect(log.last()).toMatchObject({ kind: 'warm', gapMs: 4 * MINUTE + 2_000 });
  });

  it('records a route it does not follow without judging it, and starts cold after it', () => {
    const log = new Log()
      .step(1, 1, { input: 50_000 }, { route: GLM })
      .step(1, 2, { input: 1_000, read: 49_000 }, { route: GLM })
      .step(1, 3, { input: 500, read: 10_000 }, { route: GLM })
      .step(1, 4, { write: 9_000 });
    const { verdicts, totals } = viewCacheChain(log.fold());
    expect(verdicts.map((entry) => entry.kind)).toEqual([
      'untracked',
      'untracked',
      'untracked',
      'cold',
    ]);
    expect(verdicts.some(isNotableVerdict)).toBe(false);
    expect(totals).toMatchObject({ steps: 4, evaluated: 0, shrinks: 0, unexplained: 0 });
  });

  it('only notes a shrink at a turn’s first step', () => {
    const log = new Log()
      .appendOnly(1, 3)
      .event('turn/end', { turn: 1, reason: { kind: 'completed' } })
      .event('turn/start', { turn: 2 })
      .step(2, 1, { read: 9_000, write: 3_000 });
    const state = log.fold();
    const verdict = lastStepVerdict(state);
    expect(verdict).toMatchObject({ kind: 'turn-shrink', prevPrompt: 14_000, explained: false });
    expect(verdict && isNotableVerdict(verdict)).toBe(false);
    expect(viewCacheChain(state).totals).toMatchObject({
      evaluated: 3,
      shrinks: 0,
      unexplained: 0,
    });
  });

  it('matches no older step when the read is what the step before cached', () => {
    // Step 2 adds nothing, so it caches what step 1 did; step 3 reads that.
    const log = new Log()
      .step(1, 1, { write: 10_000 })
      .step(1, 2, { read: 10_000 })
      .step(1, 3, { read: 10_000, write: 500 });
    const verdict = log.last();
    expect(verdict).toMatchObject({ kind: 'warm' });
    expect(verdict?.matched).toBeUndefined();
  });

  it('carries causes past a step that reported no usage', () => {
    const log = new Log()
      .appendOnly(1, 2)
      .event('plan/mode', { active: true })
      .event('step/start', { turn: 1, step: 3 })
      .event('assistant/message', { turn: 1, step: 3, interrupted: true, message: {} })
      .step(1, 4, { write: 13_000 });
    expect(log.last()).toMatchObject({
      step: 4,
      kind: 'rebuild',
      prevPrompt: 12_000,
      causes: ['plan-mode'],
    });
  });

  it('takes malformed events without a verdict or a cause', () => {
    const state = initCacheChain();
    const malformed = [
      null,
      { type: 42 },
      { type: 'assistant/message' },
      { type: 'assistant/message', data: { turn: 1, step: 1 } },
      { type: 'assistant/message', data: { usage: { inputTokens: 5 } } },
      { type: 'request/header', data: 'header' },
      { type: 'request/context', data: null },
      { type: 'system/message', data: { message: 7 } },
      { type: 'step/start', data: { turn: 'one' } },
    ];
    for (const event of malformed)
      expect(applyCacheChain(state, event as CacheChainEvent, FOLLOW_CLAUDE)).toBeUndefined();
    expect(state).toStrictEqual(initCacheChain());
  });

  it('keeps the newest verdicts and a bounded window, and counts every step', () => {
    const steps = MAX_KEPT_VERDICTS + 100;
    const state = new Log().appendOnly(1, steps, 2_000, 100).fold();
    expect(state.verdicts).toHaveLength(MAX_KEPT_VERDICTS);
    expect(state.verdicts[0]?.step).toBe(101);
    expect(state.window).toHaveLength(MATCH_WINDOW);
    expect(viewCacheChain(state).totals).toMatchObject({ steps, evaluated: steps - 1 });
  });

  it('restores only a state of its own version and shape', () => {
    const state = new Log().appendOnly(1, 2).fold();
    const json = JSON.parse(JSON.stringify(state));
    expect(restoreCacheChain(json)).toBe(json);
    const refused = [
      { ...json, version: CACHE_CHAIN_STATE_VERSION + 1 },
      { ...json, version: undefined },
      undefined,
      null,
      'state',
      [],
      {},
      { ...json, verdicts: {} },
      { ...json, causes: ['weather'] },
      { ...json, totals: { ...json.totals, steps: -1 } },
      { ...json, verdicts: [{ ...json.verdicts[0], kind: 'tepid' }] },
      { ...json, last: { turn: 1 } },
      { ...json, last: { ...json.last, startedAt: 'noon' } },
    ];
    for (const raw of refused) expect(restoreCacheChain(raw)).toBeUndefined();
  });
});
