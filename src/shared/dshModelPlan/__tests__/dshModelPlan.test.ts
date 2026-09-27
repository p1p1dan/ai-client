import { describe, expect, it } from 'vitest';
import type { AgentModelCatalog } from '../../types/agentCatalog.ts';
import {
  applyDshPlanToCatalog,
  buildDshModelPlan,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  type DshModelPlan,
  type DshModelPlanInput,
  dshRouteSettings,
  keyRefFor,
  resolveRoute,
  translateReasoningEfforts,
} from '../index.ts';

/**
 * dsh-rebase P1-5a — the translation rules of design shard 03 §2 (R1-R11),
 * `resolveRoute` and the menu join, on hand-built `models.json` documents.
 * Case ids follow shard 05 §3 (MP-xx, RR-xx, MN-01). The run over the shipped
 * catalog snapshot, through Main's real assembly, is
 * `src/main/services/piModelConfig/__tests__/dshModelPlan.test.ts`.
 */

type Provider = Record<string, unknown>;

function plan(
  providers: Record<string, Provider>,
  extra: Partial<Omit<DshModelPlanInput, 'models'>> = {}
): DshModelPlan {
  const keyed = extra.keyed ?? Object.fromEntries(Object.keys(providers).map((id) => [id, true]));
  return buildDshModelPlan({ models: { providers }, ...extra, keyed });
}

const GW = 'https://gw.example.test';

function provider(api: string, models: Array<Record<string, unknown>>, rest: Provider = {}) {
  return { baseUrl: `${GW}/v1`, api, models, ...rest };
}

describe('MP-02 effort declarations (R8, decision 040 rule 1)', () => {
  it('never writes null, keeps a valued off, and names the implied three', () => {
    expect(translateReasoningEfforts(true, { off: null, high: 'high', max: 'max' })).toStrictEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max',
    });
    expect(
      translateReasoningEfforts(true, { off: 'none', low: 'low', xhigh: 'xhigh' })
    ).toStrictEqual({ off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' });
  });

  it('drops a null among the implied three, and an empty wire value', () => {
    expect(translateReasoningEfforts(true, { low: null, medium: '', high: 'deep' })).toStrictEqual({
      high: 'deep',
    });
  });

  it('turns reasoning:false, a missing flag and an off-only map into a non-reasoning model', () => {
    expect(translateReasoningEfforts(false, { high: 'high' })).toBe(false);
    expect(translateReasoningEfforts(undefined, undefined)).toBe(false);
    expect(
      translateReasoningEfforts(true, { off: 'none', low: null, medium: null, high: null })
    ).toBe(false);
    expect(translateReasoningEfforts(true, { low: null, medium: null, high: null })).toBe(false);
  });

  it('indexes the levels DSH will accept, in escalation order', () => {
    const p = plan({
      china: provider('openai-completions', [
        { id: 'glm', reasoning: true, thinkingLevelMap: { off: null, high: 'high', max: 'max' } },
        { id: 'plain', reasoning: false },
        { id: 'gpt', reasoning: true, thinkingLevelMap: { off: 'none', xhigh: 'xhigh' } },
      ]),
    });
    expect(p.index['china/glm']?.efforts).toEqual(['low', 'medium', 'high', 'max']);
    expect(p.index['china/plain']?.efforts).toEqual([]);
    expect(p.index['china/gpt']?.efforts).toEqual(['off', 'low', 'medium', 'high', 'xhigh']);
    expect(p.routes.china?.models[1]?.reasoningEfforts).toBe(false);
  });
});

describe('MP-04 compat (R6)', () => {
  it('keeps only the keys the protocol offers and records the rest; the model stays', () => {
    const p = plan({
      claude: provider(
        'anthropic-messages',
        [
          {
            id: 'sonnet',
            compat: { supportsStrictTools: true, noSuchSwitch: 1, allowEmptySignature: null },
          },
        ],
        { compat: { forceAdaptiveThinking: true, supportsToolReferences: false } }
      ),
    });
    expect(p.routes.claude?.compat).toEqual({ forceAdaptiveThinking: true });
    expect(p.routes.claude?.models[0]?.compat).toEqual({ supportsStrictTools: true });
    expect(p.index['claude/sonnet']).toBeDefined();
    expect(p.dropped).toEqual(
      expect.arrayContaining([
        {
          kind: 'field',
          providerId: 'claude',
          field: 'compat.supportsToolReferences',
          reason: 'compat_not_offered',
        },
        {
          kind: 'field',
          providerId: 'claude',
          modelId: 'sonnet',
          field: 'compat.noSuchSwitch',
          reason: 'compat_not_offered',
        },
        {
          kind: 'field',
          providerId: 'claude',
          modelId: 'sonnet',
          field: 'compat.allowEmptySignature',
          reason: 'compat_unset',
        },
      ])
    );
  });

  it('filters a provider-level switch per route protocol', () => {
    const p = plan({
      mixed: provider('openai-completions', [{ id: 'a' }, { id: 'b', api: 'openai-responses' }], {
        compat: { supportsReasoningEffort: true, supportsDeveloperRole: true },
      }),
    });
    expect(p.routes.mixed?.compat).toEqual({
      supportsReasoningEffort: true,
      supportsDeveloperRole: true,
    });
    expect(p.routes['mixed~2']?.compat).toEqual({ supportsDeveloperRole: true });
  });
});

describe('MP-05 protocols and defaults (R2, R7, decision 036)', () => {
  const ALL_TEN = [
    'openai-completions',
    'openai-responses',
    'openai-codex-responses',
    'azure-openai-responses',
    'anthropic-messages',
    'google-generative-ai',
    'google-vertex',
    'bedrock-converse-stream',
    'mistral-conversations',
    'pi-messages',
  ];

  it('keeps the three DSH protocols and drops the other seven with a reason', () => {
    const p = plan(
      Object.fromEntries(ALL_TEN.map((api, i) => [`svc-${i}`, provider(api, [{ id: 'm' }])]))
    );
    expect(Object.values(p.routes).map((route) => route.api)).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ]);
    const unsupported = p.dropped.filter((drop) => drop.kind === 'model');
    expect(unsupported).toHaveLength(7);
    expect(unsupported.every((drop) => drop.reason === 'unsupported_api')).toBe(true);
    expect(unsupported.map((drop) => (drop.kind === 'model' ? drop.detail : ''))).toEqual(
      ALL_TEN.filter((api) => !p.routes[`svc-${ALL_TEN.indexOf(api)}`])
    );
  });

  it('gives a user model with reasoning:true the three levels and the native size defaults', () => {
    const p = plan({ mine: provider('openai-completions', [{ id: 'r1', reasoning: true }]) });
    const route = p.routes.mine;
    expect(route?.defaultContextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(route?.defaultMaxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(route?.models).toEqual([
      { id: 'r1', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } },
    ]);
    expect(p.index['mine/r1']).toEqual({
      route: 'mine',
      model: 'r1',
      efforts: ['low', 'medium', 'high'],
      image: false,
    });
  });

  it('copies the sizing and modality fields a row states, and records samplingParams', () => {
    const p = plan({
      m: provider('openai-responses', [
        {
          id: 'x',
          name: 'X',
          contextWindow: 400000,
          maxTokens: 64000,
          input: ['text', 'image', 'audio'],
          samplingParams: { temperature: 0.2 },
          tags: ['T'],
        },
        { id: 'y', contextWindow: 0, maxTokens: 1.5, input: [] },
      ]),
    });
    expect(p.routes.m?.models).toEqual([
      {
        id: 'x',
        name: 'X',
        contextWindow: 400000,
        maxTokens: 64000,
        input: ['text', 'image'],
        reasoningEfforts: false,
      },
      { id: 'y', reasoningEfforts: false },
    ]);
    expect(p.index['m/x']?.image).toBe(true);
    expect(p.dropped).toContainEqual({
      kind: 'field',
      providerId: 'm',
      modelId: 'x',
      field: 'samplingParams',
      reason: 'sampling_params',
    });
  });

  it('drops rows without an address or a key (R3, R4)', () => {
    const p = plan(
      {
        nourl: { api: 'openai-completions', baseUrl: '', models: [{ id: 'a' }] },
        nokey: provider('openai-completions', [{ id: 'b' }]),
      },
      { keyed: { nourl: true, nokey: false } }
    );
    expect(p.routes).toEqual({});
    expect(p.refs).toEqual({});
    expect(p.dropped).toEqual([
      { kind: 'model', providerId: 'nourl', modelId: 'a', reason: 'no_base_url' },
      { kind: 'model', providerId: 'nokey', modelId: 'b', reason: 'no_api_key' },
    ]);
  });
});

describe('MP-06 per-model address or protocol splits routes (R1)', () => {
  const p = plan({
    p: provider('openai-completions', [
      { id: 'm1' },
      { id: 'm2', baseUrl: 'https://other.example.test/v1' },
      { id: 'm3', api: 'openai-responses' },
      { id: 'm4' },
      { id: 'm5', api: 'google-generative-ai' },
    ]),
    q: provider('google-generative-ai', [{ id: 'n1' }, { id: 'n2', api: 'anthropic-messages' }]),
  });

  it('names the first group after the provider and the rest ~2, ~3 in order', () => {
    expect(Object.keys(p.routes)).toEqual(['p', 'p~2', 'p~3', 'q']);
    expect(p.routes.p).toMatchObject({ api: 'openai-completions', baseURL: `${GW}/v1` });
    expect(p.routes.p?.models.map((m) => m.id)).toEqual(['m1', 'm4']);
    expect(p.routes['p~2']).toMatchObject({
      api: 'openai-completions',
      baseURL: 'https://other.example.test/v1',
    });
    expect(p.routes['p~3']).toMatchObject({ api: 'openai-responses', baseURL: `${GW}/v1` });
    expect(p.routes.q).toMatchObject({ api: 'anthropic-messages' });
  });

  it('points every index entry at its route, keeps catalog order, and shares one key ref', () => {
    expect(Object.entries(p.index).map(([id, entry]) => [id, entry.route])).toEqual([
      ['p/m1', 'p'],
      ['p/m2', 'p~2'],
      ['p/m3', 'p~3'],
      ['p/m4', 'p'],
      ['q/n2', 'q'],
    ]);
    expect(p.routes['p~2']?.apiKeyEnv).toBe(p.routes.p?.apiKeyEnv);
    expect(p.refs).toEqual({ [keyRefFor('p')]: 'p', [keyRefFor('q')]: 'q' });
    expect(p.dropped.filter((drop) => drop.kind === 'model').map((d) => d.modelId)).toEqual([
      'm5',
      'n1',
    ]);
  });

  it('keeps the first of two rows with the same id', () => {
    const dup = plan({
      d: provider('openai-completions', [{ id: 'x', name: 'first' }, { id: 'x' }]),
    });
    expect(dup.routes.d?.models).toEqual([{ id: 'x', name: 'first', reasoningEfforts: false }]);
  });
});

describe('MP-07 headers and keys (R4, R5)', () => {
  it('expands $NAME from the given env, drops User-Agent and dead references', () => {
    const p = plan(
      {
        h: provider('openai-completions', [{ id: 'a' }], {
          headers: {
            'User-Agent': '$AICLIENT_PI_USER_AGENT',
            'X-Client': '$CLIENT_TAG',
            'X-Gone': '$NOT_SET',
            'X-Literal': 'fixed',
            'Bad Name': 'v',
          },
        }),
      },
      { env: { AICLIENT_PI_USER_AGENT: 'claude-cli-pilab/1.0.3', CLIENT_TAG: ' ai-client ' } }
    );
    expect(p.routes.h?.headers).toEqual({ 'X-Client': 'ai-client', 'X-Literal': 'fixed' });
    expect(p.dropped).toEqual([
      { kind: 'field', providerId: 'h', field: 'headers.User-Agent', reason: 'reserved_header' },
      { kind: 'field', providerId: 'h', field: 'headers.X-Gone', reason: 'unresolved_header' },
      { kind: 'field', providerId: 'h', field: 'headers.Bad Name', reason: 'invalid_header' },
    ]);
    expect(JSON.stringify(p)).not.toContain('claude-cli-pilab');
  });

  it.each([
    'Authorization',
    'x-api-key',
    'X-Auth-Token',
    'Cookie',
  ])('refuses the whole provider for a credential-like header %s', (name) => {
    const p = plan({
      c: provider('anthropic-messages', [{ id: 'a' }, { id: 'b' }], {
        headers: { [name]: '$SOME_SECRET' },
      }),
    });
    expect(p.routes).toEqual({});
    expect(p.dropped).toEqual([
      { kind: 'model', providerId: 'c', modelId: 'a', reason: 'credential_header', detail: name },
      { kind: 'model', providerId: 'c', modelId: 'b', reason: 'credential_header', detail: name },
    ]);
  });

  it('derives a stable, env-safe reference name from the provider id alone', () => {
    expect(keyRefFor('claude')).toMatch(/^AICLIENT_KEY_CLAUDE_[0-9A-F]{4}$/);
    expect(keyRefFor('claude')).toBe(keyRefFor('claude'));
    expect(keyRefFor('my.svc')).not.toBe(keyRefFor('my-svc'));
    expect(keyRefFor('my.svc')).toMatch(/^AICLIENT_KEY_MY_SVC_[0-9A-F]{4}$/);
  });

  it('copies no credential a document carries by mistake', () => {
    const canary = 'sk-canary-mp07';
    const p = plan({
      k: provider('openai-completions', [{ id: 'a', apiKey: canary, key: canary }], {
        apiKey: canary,
        token: canary,
      }),
    });
    expect(p.index['k/a']).toBeDefined();
    expect(JSON.stringify(p)).not.toContain(canary);
  });
});

describe('MP-08 revision (R11)', () => {
  const input = () => ({
    a: provider('openai-completions', [{ id: 'm', contextWindow: 1000 }]),
  });

  it('is identical for identical input and changes with the routes', () => {
    const first = plan(input());
    expect(plan(input()).revision).toBe(first.revision);
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
    const resized = input();
    (resized.a.models as Array<Record<string, unknown>>)[0] = { id: 'm', contextWindow: 2000 };
    expect(plan(resized).revision).not.toBe(first.revision);
    expect(plan(input(), { keyed: { a: false } }).revision).not.toBe(first.revision);
    expect(plan(input(), { settings: { promptCacheTtl: '5m' } }).revision).not.toBe(first.revision);
  });

  it('ignores what never reaches a route', () => {
    const first = plan(input());
    const sampled = input();
    (sampled.a.models as Array<Record<string, unknown>>)[0] = {
      id: 'm',
      contextWindow: 1000,
      samplingParams: { temperature: 1 },
      tags: ['x'],
    };
    expect(plan(sampled).revision).toBe(first.revision);
  });
});

describe('MP-09 settings mapping (decision 040 rule 3)', () => {
  it('maps the defaults: 1 h cache, 120 s idle, three retries 3 s to 30 s', () => {
    expect(dshRouteSettings()).toEqual({
      cacheRetention: 'long',
      streamIdleTimeoutMs: 120_000,
      retryPolicy: {
        mode: 'normal',
        maxRetries: 3,
        backoff: { initialDelayMs: 3_000, maxDelayMs: 30_000 },
      },
    });
  });

  it('maps 5 m to short and a stated timeout through', () => {
    expect(dshRouteSettings({ promptCacheTtl: '5m' }).cacheRetention).toBe('short');
    expect(dshRouteSettings({ providerIdleTimeoutMs: 30_000 }).streamIdleTimeoutMs).toBe(30_000);
  });

  it('maps 0 ("never") to the timer ceiling, never to 0 or the default', () => {
    expect(dshRouteSettings({ providerIdleTimeoutMs: 0 }).streamIdleTimeoutMs).toBe(2_147_483_647);
  });

  it('falls back on a value outside the setting range', () => {
    expect(dshRouteSettings({ providerIdleTimeoutMs: -1 }).streamIdleTimeoutMs).toBe(120_000);
    expect(dshRouteSettings({ providerIdleTimeoutMs: 1.5 }).streamIdleTimeoutMs).toBe(120_000);
  });

  it('lands on every route', () => {
    const p = plan(
      { a: provider('openai-completions', [{ id: 'm' }]) },
      { settings: { promptCacheTtl: '5m', providerIdleTimeoutMs: 0 } }
    );
    expect(p.routes.a).toMatchObject({
      cacheRetention: 'short',
      streamIdleTimeoutMs: 2_147_483_647,
      retryPolicy: { maxRetries: 3 },
    });
  });
});

describe('default model (R9)', () => {
  it('is the first routed model in catalog order', () => {
    const p = plan(
      {
        off: provider('google-generative-ai', [{ id: 'g' }]),
        b: provider('openai-completions', [{ id: 'm', baseUrl: 'https://b.example.test/v1' }]),
      },
      {}
    );
    expect(p.defaultModel).toEqual({ provider: 'b', model: 'm' });
  });

  it('is the placeholder when nothing is routable', () => {
    const p = plan({});
    expect(p.defaultModel).toEqual({ provider: 'aiclient-none', model: 'none' });
    expect(p.index).toEqual({});
  });
});

describe('resolveRoute (RR-01..06, decision 040 rule 2)', () => {
  const p = plan({
    gpt: provider('openai-responses', [
      { id: 'luna', reasoning: true, thinkingLevelMap: { off: 'none', xhigh: 'xhigh' } },
    ]),
    china: provider('openai-completions', [
      { id: 'deep', reasoning: true, thinkingLevelMap: { low: null, medium: null, high: 'high' } },
      { id: 'plain' },
      { id: 'eye', input: ['text', 'image'] },
    ]),
  });

  it('RR-01 resolves a missing model to the default model', () => {
    for (const missing of [undefined, null, '', '  ']) {
      const r = resolveRoute(p, missing, undefined, 'completion');
      expect(r).toEqual({
        ok: true,
        modelId: 'gpt/luna',
        selection: { provider: 'gpt', model: 'luna' },
        image: false,
      });
    }
  });

  it('RR-02 reports a model the plan does not route, and an empty plan', () => {
    expect(resolveRoute(p, 'gpt/retired', undefined, 'session')).toEqual({
      ok: false,
      code: 'MODEL_NOT_IN_PLAN',
      modelId: 'gpt/retired',
    });
    expect(resolveRoute(p, 'constructor', undefined, 'session')).toMatchObject({
      ok: false,
      code: 'MODEL_NOT_IN_PLAN',
    });
    expect(resolveRoute(plan({}), undefined, 'high', 'session')).toEqual({
      ok: false,
      code: 'MODEL_CATALOG_EMPTY',
    });
  });

  it('RR-03 sends medium for a session that chose no level', () => {
    for (const none of [undefined, null, 'default', 'bogus']) {
      expect(resolveRoute(p, 'gpt/luna', none, 'session')).toMatchObject({
        ok: true,
        selection: { provider: 'gpt', model: 'luna', reasoningEffort: 'medium' },
      });
    }
  });

  it('RR-04 sends no level when the model does not offer medium', () => {
    const deep = resolveRoute(p, 'china/deep', undefined, 'session');
    expect(deep.ok && deep.selection).toEqual({ provider: 'china', model: 'deep' });
    const plain = resolveRoute(p, 'china/plain', undefined, 'session');
    expect(plain.ok && plain.selection).toEqual({ provider: 'china', model: 'plain' });
  });

  it('RR-05 sends nothing for a completion with off or no level', () => {
    for (const none of [undefined, 'off', 'default']) {
      const r = resolveRoute(p, 'gpt/luna', none, 'completion');
      expect(r.ok && r.selection).toEqual({ provider: 'gpt', model: 'luna' });
      expect(r.ok && r.droppedEffort).toBeFalsy();
    }
    const high = resolveRoute(p, 'gpt/luna', 'high', 'completion');
    expect(high.ok && high.selection.reasoningEffort).toBe('high');
  });

  it('RR-06 removes an explicit level the model does not offer instead of failing', () => {
    const r = resolveRoute(p, 'gpt/luna', 'max', 'session');
    expect(r).toEqual({
      ok: true,
      modelId: 'gpt/luna',
      selection: { provider: 'gpt', model: 'luna' },
      image: false,
      droppedEffort: 'max',
    });
    const plain = resolveRoute(p, 'china/plain', 'off', 'session');
    expect(plain.ok && plain.droppedEffort).toBe('off');
    const off = resolveRoute(p, 'gpt/luna', 'off', 'session');
    expect(off.ok && off.selection.reasoningEffort).toBe('off');
    const xhigh = resolveRoute(p, 'gpt/luna', 'xhigh', 'session');
    expect(xhigh.ok && xhigh.selection.reasoningEffort).toBe('xhigh');
  });

  it('carries the image capability of the resolved model', () => {
    const eye = resolveRoute(p, 'china/eye', undefined, 'session');
    expect(eye.ok && eye.image).toBe(true);
  });
});

describe('MN-01 the menu keeps what the plan routes (decision 033 rule 3)', () => {
  const p = plan(
    {
      a: provider('openai-completions', [
        { id: 'r', reasoning: true },
        { id: 'plain', reasoning: false },
      ]),
      g: provider('google-generative-ai', [{ id: 'gem' }]),
      n: provider('openai-completions', [{ id: 'nokey' }]),
    },
    { keyed: { a: true, g: true, n: false } }
  );
  const catalog: AgentModelCatalog = {
    models: [
      { id: 'g/gem', label: 'Gemini' },
      { id: 'a/r', label: 'R', reasoning: true },
      { id: 'n/nokey', label: 'No Key' },
      { id: 'a/plain', label: 'Plain', reasoning: false },
      { id: 'file/only', label: 'File Only' },
    ],
    source: 'managed',
    stale: false,
    fetchedAt: 1,
    unavailable: [{ label: 'stale entry', reason: 'not_in_plan' }],
  };

  it('keeps routed models in menu order, with the efforts the host accepts', () => {
    const menu = applyDshPlanToCatalog(catalog, p);
    expect(menu.models).toEqual([
      { id: 'a/r', label: 'R', reasoning: true, efforts: ['low', 'medium', 'high'] },
      { id: 'a/plain', label: 'Plain', reasoning: false, efforts: [] },
    ]);
    expect(menu).toMatchObject({ source: 'managed', stale: false, fetchedAt: 1 });
  });

  it('counts the rest in unavailable, with the plan reason', () => {
    expect(applyDshPlanToCatalog(catalog, p).unavailable).toEqual([
      { label: 'Gemini', reason: 'unsupported_api' },
      { label: 'No Key', reason: 'no_api_key' },
      { label: 'File Only', reason: 'not_in_plan' },
    ]);
  });

  it('leaves unavailable out when every model is routed', () => {
    const routed = applyDshPlanToCatalog(
      { ...catalog, models: catalog.models.filter((m) => m.id.startsWith('a/')) },
      p
    );
    expect(routed).not.toHaveProperty('unavailable');
  });

  it('empties the menu against an empty plan rather than listing unroutable models', () => {
    const menu = applyDshPlanToCatalog(catalog, plan({}));
    expect(menu.models).toEqual([]);
    expect(menu.unavailable).toHaveLength(5);
  });
});
