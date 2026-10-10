import { describe, expect, it } from 'vitest';
import { type CacheStepVerdict, DEFAULT_TTL_MS } from '../../../shared/cacheChain.ts';
import { buildDshModelPlan } from '../../../shared/dshModelPlan/build.ts';
import type {
  ClientPrefixEvidence,
  ClientPrefixVerdict,
} from '../../../shared/types/requestScope.ts';
import {
  cacheChainLogLines,
  dshCacheChainOptions,
  LONG_CACHE_TTL_MS,
  stepPrefixEvidence,
} from '../cacheChainReport.ts';
import type { DshBridgeModelPlan } from '../modelRoute.ts';
import { TEST_PLAN } from './testPlan.ts';

/**
 * Decision 173 B2 (issue #9) — the bridge's reading of a step's cache verdict:
 * which routes the chain follows and how long their cache lives, which prefix
 * evidence is a step's own, and the log lines. The live wiring is in
 * `liveEvents.test.ts`.
 */

const GW = 'https://gw.example.test/v1';

/** A plan by the product's own rules: Claude and a Claude Code relay on anthropic-messages, GLM not. */
function plan(promptCacheTtl: '5m' | '1h'): DshBridgeModelPlan {
  return buildDshModelPlan({
    models: {
      providers: {
        claude: { baseUrl: GW, api: 'anthropic-messages', models: [{ id: 'claude-opus-5-5' }] },
        glm: { baseUrl: GW, api: 'openai-completions', models: [{ id: 'glm-5.3' }] },
      },
    },
    keyed: { claude: true, glm: true },
    settings: { promptCacheTtl },
  });
}

describe('dshCacheChainOptions', () => {
  it('follows anthropic-messages routes only, by the name DSH gives a step', () => {
    const options = dshCacheChainOptions(() => plan('1h'));
    expect(options.cacheAware('claude', 'claude-opus-5-5')).toBe(true);
    expect(options.cacheAware('glm', 'glm-5.3')).toBe(false);
    expect(options.cacheAware('elsewhere')).toBe(false);
    expect(options.cacheAware(undefined)).toBe(false);
  });

  it('lives an hour on a long retention, five minutes on a short one, the default when unnamed', () => {
    expect(dshCacheChainOptions(() => plan('1h')).ttlMsFor('claude')).toBe(LONG_CACHE_TTL_MS);
    expect(LONG_CACHE_TTL_MS).toBe(3_600_000);
    expect(dshCacheChainOptions(() => plan('5m')).ttlMsFor('claude')).toBe(DEFAULT_TTL_MS);
    expect(dshCacheChainOptions(() => plan('1h')).ttlMsFor('elsewhere')).toBeUndefined();
  });

  it('reads the plan per step, and stays silent without one', () => {
    let current: DshBridgeModelPlan | undefined;
    const options = dshCacheChainOptions(() => current);
    expect(options.cacheAware('claude')).toBe(false);
    current = plan('1h');
    expect(options.cacheAware('claude')).toBe(true);
    // A plan without routes (an older host): nothing is followed.
    current = TEST_PLAN;
    expect(options.cacheAware('aiclient-gateway')).toBe(false);
    expect(options.ttlMsFor('aiclient-gateway')).toBeUndefined();
    const throwing = dshCacheChainOptions(() => {
      throw new Error('no plan');
    });
    expect(throwing.cacheAware('claude')).toBe(false);
    expect(throwing.ttlMsFor('claude')).toBeUndefined();
  });
});

const evidence = (
  at: number,
  requestSeq = 7,
  verdict: ClientPrefixVerdict = { kind: 'append', added: 2 }
): ClientPrefixEvidence => ({ verdict, requestSeq, at });

describe('stepPrefixEvidence', () => {
  const WINDOW = { from: 1_000, to: 9_000 };

  it("takes the newest request seen inside the step's window, ends included", () => {
    for (const at of [1_000, 5_000, 9_000]) {
      expect(stepPrefixEvidence(evidence(at), WINDOW)).toEqual(evidence(at));
    }
  });

  it('takes none from before or after the window, or with an end unknown', () => {
    expect(stepPrefixEvidence(evidence(999), WINDOW)).toBeUndefined();
    expect(stepPrefixEvidence(evidence(9_001), WINDOW)).toBeUndefined();
    expect(stepPrefixEvidence(evidence(5_000), { to: 9_000 })).toBeUndefined();
    expect(stepPrefixEvidence(evidence(5_000), { from: 1_000 })).toBeUndefined();
    expect(stepPrefixEvidence(evidence(Number.NaN), WINDOW)).toBeUndefined();
    expect(stepPrefixEvidence(undefined, WINDOW)).toBeUndefined();
  });

  it('never gives one request to two steps', () => {
    const given = { requestSeq: 7, at: 5_000 };
    expect(stepPrefixEvidence(evidence(5_000, 7), WINDOW, given)).toBeUndefined();
    expect(stepPrefixEvidence(evidence(5_200, 8), WINDOW, given)).toEqual(evidence(5_200, 8));
    // The host restarts its count after a long idle: a lower number is still news.
    expect(stepPrefixEvidence(evidence(5_200, 1), WINDOW, given)).toEqual(evidence(5_200, 1));
  });
});

describe('cacheChainLogLines', () => {
  const SESSION = 'aiclient-chat-1';
  /** Issue #9's step 17: the 36,848-token system prefix read back, nothing local to explain it. */
  const rebuild = (overrides: Partial<CacheStepVerdict> = {}): CacheStepVerdict => ({
    turn: 1,
    step: 17,
    provider: 'claude',
    model: 'claude-opus-5-5',
    prompt: 174_880,
    read: 36_848,
    write: 138_030,
    input: 2,
    prevPrompt: 157_890,
    lost: 121_042,
    kind: 'rebuild',
    explained: false,
    causes: [],
    ...overrides,
  });
  const warm = rebuild({ kind: 'warm', read: 157_888, write: 16_990, lost: 2 });
  const diverged = (
    at: 'config' | 'tools' | 'system' | 'messages',
    extra: Partial<Extract<ClientPrefixVerdict, { kind: 'diverged' }>> = {}
  ): ClientPrefixVerdict => ({
    kind: 'diverged',
    at,
    truncated: false,
    prevMessages: 70,
    messages: 72,
    ...extra,
  });

  it('writes one line for an unexplained notable step, numbers only', () => {
    expect(cacheChainLogLines(SESSION, rebuild(), evidence(5_000, 18))).toEqual([
      'cache-chain: upstream cache inconsistency session=aiclient-chat-1 step=t1s17 kind=rebuild prompt=174880 prev=157890 read=36848 write=138030 lost=121042 matched=- prefix=append',
    ]);
    expect(
      cacheChainLogLines(
        SESSION,
        rebuild({ kind: 'warm', read: 169_776, lost: 0, matched: { turn: 1, step: 14 } })
      )
    ).toEqual([
      'cache-chain: upstream cache inconsistency session=aiclient-chat-1 step=t1s17 kind=warm prompt=174880 prev=157890 read=169776 write=138030 lost=0 matched=t1s14 prefix=-',
    ]);
  });

  it('keeps quiet about an explained step and an ordinary one', () => {
    expect(
      cacheChainLogLines(SESSION, rebuild({ explained: true, causes: ['plan-mode'] }))
    ).toEqual([]);
    expect(cacheChainLogLines(SESSION, warm, evidence(5_000))).toEqual([]);
    expect(cacheChainLogLines(SESSION, rebuild({ kind: 'turn-shrink' }))).toEqual([]);
  });

  it.each([
    [
      diverged('messages', { index: 41, role: 'assistant' }),
      'at=messages index=41/72 role=assistant truncated=false',
    ],
    [
      diverged('messages', { index: 70, role: 'user', truncated: true }),
      'at=messages index=70/72 role=user truncated=true',
    ],
    [diverged('config', { field: 'thinking' }), 'at=config field=thinking'],
    [diverged('config', { field: 'a field with spaces' }), 'at=config field=?'],
    [diverged('tools', { index: 3 }), 'at=tools index=3'],
    [diverged('system'), 'at=system'],
  ])('flags a request that diverged with no cause logged: %o', (verdict, fields) => {
    expect(cacheChainLogLines(SESSION, warm, evidence(5_000, 18, verdict))).toEqual([
      `cache-chain: client request diverged without a logged cause session=aiclient-chat-1 step=t1s17 ${fields} request=18`,
    ]);
  });

  it('lets a local cause account for a diverged request', () => {
    expect(
      cacheChainLogLines(
        SESSION,
        rebuild({ explained: true, causes: ['compaction'] }),
        evidence(5_000, 18, diverged('messages', { index: 3, role: 'user' }))
      )
    ).toEqual([]);
  });

  it('writes both lines when an unexplained rebuild follows our own divergence', () => {
    const lines = cacheChainLogLines(SESSION, rebuild(), evidence(5_000, 18, diverged('system')));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/upstream cache inconsistency .* prefix=diverged$/);
    expect(lines[1]).toBe(
      'cache-chain: client request diverged without a logged cause session=aiclient-chat-1 step=t1s17 at=system request=18'
    );
  });
});
