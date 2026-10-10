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
    // Decision 159: an anthropic-messages route also says no to the tools
    // breakpoint by default (the GW-16 switch, tested below).
    expect(p.routes.claude?.compat).toEqual({
      forceAdaptiveThinking: true,
      supportsCacheControlOnTools: false,
    });
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

describe('adaptive-only thinking hardening (decision 141)', () => {
  it('withholds off from a row whose own compat forces adaptive thinking, and records why', () => {
    const p = plan({
      claude: provider('anthropic-messages', [
        {
          id: 'opus',
          reasoning: true,
          thinkingLevelMap: { off: 'none', high: 'high' },
          compat: { forceAdaptiveThinking: true },
        },
      ]),
    });
    expect(p.routes.claude?.models[0]?.reasoningEfforts).toStrictEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
    });
    expect(p.index['claude/opus']?.efforts).toEqual(['low', 'medium', 'high']);
    expect(p.dropped).toContainEqual({
      kind: 'field',
      providerId: 'claude',
      modelId: 'opus',
      field: 'reasoningEfforts.off',
      reason: 'adaptive_thinking_forced',
    });
    expect(p.dropped).not.toContainEqual(
      expect.objectContaining({ reason: 'adaptive_thinking_undeclared' })
    );
  });

  it('plans the row a user service writes for its adaptive thinking switch (decision 165)', () => {
    // `toPiUserModel`'s output: off already null, so nothing is withheld or advised.
    const p = plan({
      mine: provider('anthropic-messages', [
        {
          id: 'claude-opus-5-5',
          reasoning: true,
          compat: { forceAdaptiveThinking: true },
          thinkingLevelMap: { off: null },
        },
      ]),
    });
    expect(p.routes.mine?.models[0]?.reasoningEfforts).toStrictEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
    });
    expect(p.routes.mine?.models[0]?.compat).toMatchObject({ forceAdaptiveThinking: true });
    expect(p.index['mine/claude-opus-5-5']?.efforts).toEqual(['low', 'medium', 'high']);
    expect(p.dropped).not.toContainEqual(
      expect.objectContaining({ reason: 'adaptive_thinking_undeclared' })
    );
    expect(p.dropped).not.toContainEqual(
      expect.objectContaining({ reason: 'adaptive_thinking_forced' })
    );
  });

  it("inherits the provider-level switch, matching dsh-llm-pi-ai's own route/model compat merge", () => {
    const p = plan({
      claude: provider(
        'anthropic-messages',
        [{ id: 'opus', reasoning: true, thinkingLevelMap: { off: 'none', high: 'high' } }],
        { compat: { forceAdaptiveThinking: true } }
      ),
    });
    expect(p.routes.claude?.models[0]?.reasoningEfforts).toStrictEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
    });
    expect(p.dropped).toEqual([
      {
        kind: 'field',
        providerId: 'claude',
        modelId: 'opus',
        field: 'reasoningEfforts.off',
        reason: 'adaptive_thinking_forced',
      },
    ]);
  });

  it('lets a row opt back out of the provider-level switch (model wins field by field)', () => {
    const p = plan({
      claude: provider(
        'anthropic-messages',
        [
          {
            id: 'legacy',
            reasoning: true,
            thinkingLevelMap: { off: 'none', high: 'high' },
            compat: { forceAdaptiveThinking: false },
          },
        ],
        { compat: { forceAdaptiveThinking: true } }
      ),
    });
    expect(p.routes.claude?.models[0]?.reasoningEfforts).toStrictEqual({
      off: 'none',
      low: 'low',
      medium: 'medium',
      high: 'high',
    });
    expect(p.dropped).toEqual([]);
  });

  it('leaves a legacy anthropic-messages row with no forceAdaptiveThinking unchanged, but hints at declaring it', () => {
    const p = plan({
      claude: provider('anthropic-messages', [
        { id: 'legacy', reasoning: true, thinkingLevelMap: { off: 'none', high: 'high' } },
      ]),
    });
    expect(p.routes.claude?.models[0]?.reasoningEfforts).toStrictEqual({
      off: 'none',
      low: 'low',
      medium: 'medium',
      high: 'high',
    });
    expect(p.index['claude/legacy']?.efforts).toEqual(['off', 'low', 'medium', 'high']);
    expect(p.dropped).toEqual([
      {
        kind: 'field',
        providerId: 'claude',
        modelId: 'legacy',
        field: 'compat.forceAdaptiveThinking',
        reason: 'adaptive_thinking_undeclared',
      },
    ]);
  });

  it('gives neither diagnostic to a non-reasoning row, or to any row on another protocol', () => {
    const p = plan({
      claude: provider('anthropic-messages', [{ id: 'plain', reasoning: false }]),
      china: provider('openai-completions', [
        { id: 'glm', reasoning: true, thinkingLevelMap: { off: 'none', high: 'high' } },
      ]),
    });
    expect(p.routes.claude?.models[0]?.reasoningEfforts).toBe(false);
    expect(p.routes.china?.models[0]?.reasoningEfforts).toStrictEqual({
      off: 'none',
      low: 'low',
      medium: 'medium',
      high: 'high',
    });
    expect(p.dropped).toEqual([]);
  });

  it('leaves the zai thinking-disabled path untouched (openai-completions is never adaptive-only here)', () => {
    const p = plan({
      z: provider(
        'openai-completions',
        [{ id: 'glm', reasoning: true, thinkingLevelMap: { off: 'none', high: 'high' } }],
        { compat: { thinkingFormat: 'zai' } }
      ),
    });
    expect(p.routes.z?.models[0]?.reasoningEfforts).toStrictEqual({
      off: 'none',
      low: 'low',
      medium: 'medium',
      high: 'high',
    });
    expect(p.dropped).toEqual([]);
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

  /**
   * Decision 146 (GW-4): DSH's automatic compaction budgets a chat as window
   * minus `maxTokens` minus 65536 of headroom (`dsh-compaction-basic`
   * `resolveCompactSpec`), so a row whose `maxTokens` equals its window can
   * never be compacted. Such a reservation is planned as a quarter of the window.
   */
  it('[GW4-CLAMP-1] plans a maxTokens over half the window as a quarter of it, and says so', () => {
    const p = plan({
      grok: provider('openai-completions', [
        { id: 'grok-4.7', contextWindow: 500000, maxTokens: 500000 },
        { id: 'odd', contextWindow: 204800, maxTokens: 131072 },
      ]),
    });
    expect(p.routes.grok?.models.map((m) => [m.id, m.contextWindow, m.maxTokens])).toEqual([
      ['grok-4.7', 500000, 125000],
      ['odd', 204800, 51200],
    ]);
    expect(p.dropped).toContainEqual({
      kind: 'field',
      providerId: 'grok',
      modelId: 'grok-4.7',
      field: 'maxTokens',
      reason: 'max_tokens_clamped',
      detail: '500000 -> 125000',
    });
    // What DSH's compaction then has left: a positive budget, and a threshold above the tail it keeps.
    const window = 500000;
    const reserved = p.routes.grok?.models[0]?.maxTokens ?? window;
    const messageBudget = window - reserved;
    const threshold = Math.min(window * 0.8, messageBudget - 65536);
    expect(threshold).toBeGreaterThan(Math.floor(messageBudget * 0.16));
  });

  it('[GW4-CLAMP-2] leaves a real output cap alone, and a row that does not state its window', () => {
    const p = plan({
      m: provider('openai-responses', [
        { id: 'half', contextWindow: 200000, maxTokens: 100000 },
        { id: 'gpt', contextWindow: 272000, maxTokens: 128000 },
        { id: 'unsized', maxTokens: 500000 },
      ]),
    });
    expect(p.routes.m?.models.map((m) => [m.id, m.maxTokens])).toEqual([
      ['half', 100000],
      ['gpt', 128000],
      ['unsized', 500000],
    ]);
    expect(p.dropped.filter((drop) => drop.reason === 'max_tokens_clamped')).toEqual([]);
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
  it('expands $NAME from the given env, drops User-Agent, the relay header and dead references', () => {
    const p = plan(
      {
        h: provider('openai-completions', [{ id: 'a' }], {
          headers: {
            'User-Agent': '$STATED_AGENT',
            'x-aiclient-user-agent': 'spoofed/1',
            'X-Client': '$CLIENT_TAG',
            'X-Gone': '$NOT_SET',
            'X-Literal': 'fixed',
            'Bad Name': 'v',
          },
        }),
      },
      { env: { STATED_AGENT: 'stated-agent/1.0.3', CLIENT_TAG: ' ai-client ' } }
    );
    // Decision 171: the app's own choice (here the default, no version given)
    // travels in the relay header; a provider's User-Agent or relay never does.
    expect(p.routes.h?.headers).toEqual({
      'X-Client': 'ai-client',
      'X-Literal': 'fixed',
      'X-Aiclient-User-Agent': 'claude-cli-pilab',
    });
    expect(p.dropped).toEqual([
      { kind: 'field', providerId: 'h', field: 'headers.User-Agent', reason: 'reserved_header' },
      {
        kind: 'field',
        providerId: 'h',
        field: 'headers.x-aiclient-user-agent',
        reason: 'reserved_header',
      },
      { kind: 'field', providerId: 'h', field: 'headers.X-Gone', reason: 'unresolved_header' },
      { kind: 'field', providerId: 'h', field: 'headers.Bad Name', reason: 'invalid_header' },
    ]);
    expect(JSON.stringify(p)).not.toContain('stated-agent');
    expect(JSON.stringify(p)).not.toContain('spoofed');
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

  it('sends the app version as X-Pilab-Client on every route, over a provider header of that name (decision 037)', () => {
    const p = plan(
      {
        h: provider('openai-completions', [{ id: 'a' }, { id: 'b', baseUrl: `${GW}/v2` }], {
          headers: { 'x-pilab-client': 'spoofed', 'X-Literal': 'fixed' },
        }),
        bare: provider('anthropic-messages', [{ id: 'c' }]),
      },
      { clientVersion: '1.0.3' }
    );
    const sent = {
      'X-Pilab-Client': '1.0.3',
      // Decision 171: the same version names the default User-Agent.
      'X-Aiclient-User-Agent': 'claude-cli-pilab/1.0.3',
    };
    expect(p.routes.h?.headers).toEqual({ 'X-Literal': 'fixed', ...sent });
    expect(p.routes['h~2']?.headers).toEqual({ 'X-Literal': 'fixed', ...sent });
    expect(p.routes.bare?.headers).toEqual(sent);
    // No version, no identity header: a blank version plans as no version at all.
    const without = plan({ bare: provider('anthropic-messages', [{ id: 'c' }]) });
    expect(without.routes.bare?.headers).toEqual({ 'X-Aiclient-User-Agent': 'claude-cli-pilab' });
    expect(
      plan({ bare: provider('anthropic-messages', [{ id: 'c' }]) }, { clientVersion: ' ' }).revision
    ).toBe(without.revision);
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

describe('GW-16 cache_control on tools, the temporary switch (decisions 149 rule 19, 159)', () => {
  const mixed = () => ({
    claude: provider('anthropic-messages', [{ id: 'sonnet' }], {
      compat: { forceAdaptiveThinking: true },
    }),
    own: provider('anthropic-messages', [{ id: 'u1' }]),
    gpt: provider('openai-responses', [{ id: 'g' }], { compat: { supportsDeveloperRole: true } }),
    china: provider('openai-completions', [{ id: 'glm' }]),
  });

  it('off by default: every anthropic-messages route says false, the other protocols say nothing', () => {
    const p = plan(mixed());
    expect(p.routes.claude?.compat).toEqual({
      forceAdaptiveThinking: true,
      supportsCacheControlOnTools: false,
    });
    // A user service with no compat of its own gets the switch alone: judged
    // by protocol, never by name.
    expect(p.routes.own?.compat).toEqual({ supportsCacheControlOnTools: false });
    expect(p.routes.gpt?.compat).toEqual({ supportsDeveloperRole: true });
    expect(p.routes.china?.compat).toBeUndefined();
    // Rows that never named the field are left alone; the route speaks for them.
    expect(p.routes.claude?.models[0]?.compat).toBeUndefined();
    expect(p.dropped).not.toContainEqual(
      expect.objectContaining({ field: 'compat.supportsCacheControlOnTools' })
    );
  });

  it('an explicit false plans the same as the default', () => {
    expect(plan(mixed(), { settings: { cacheControlOnTools: false } })).toEqual(plan(mixed()));
  });

  it('on: the plan says nothing about it, as before the switch', () => {
    const p = plan(mixed(), { settings: { cacheControlOnTools: true } });
    expect(p.routes.claude?.compat).toEqual({ forceAdaptiveThinking: true });
    expect(p.routes.own?.compat).toBeUndefined();
    expect(p.routes.gpt?.compat).toEqual({ supportsDeveloperRole: true });
    expect(p.routes.china?.compat).toBeUndefined();
  });

  it("off overrides a row's own true, because DSH lets the row win; on keeps what the row says", () => {
    const rows = () => ({
      claude: provider('anthropic-messages', [
        { id: 'yes', compat: { supportsCacheControlOnTools: true, supportsStrictTools: true } },
        { id: 'no', compat: { supportsCacheControlOnTools: false } },
      ]),
    });
    const off = plan(rows());
    expect(off.routes.claude?.models.map((model) => model.compat)).toEqual([
      { supportsCacheControlOnTools: false, supportsStrictTools: true },
      { supportsCacheControlOnTools: false },
    ]);
    const on = plan(rows(), { settings: { cacheControlOnTools: true } });
    expect(on.routes.claude?.compat).toBeUndefined();
    expect(on.routes.claude?.models.map((model) => model.compat)).toEqual([
      { supportsCacheControlOnTools: true, supportsStrictTools: true },
      { supportsCacheControlOnTools: false },
    ]);
  });

  it('a per-model protocol split is judged per route', () => {
    const p = plan({
      split: provider('openai-completions', [
        { id: 'a' },
        { id: 'b', api: 'anthropic-messages', baseUrl: GW },
      ]),
    });
    expect(p.routes.split?.compat).toBeUndefined();
    expect(p.routes['split~2']?.compat).toEqual({ supportsCacheControlOnTools: false });
  });

  it('changes the revision only for a plan with an anthropic-messages route', () => {
    const off = plan(mixed());
    const on = plan(mixed(), { settings: { cacheControlOnTools: true } });
    expect(on.revision).not.toBe(off.revision);
    const openaiOnly = () => ({ china: provider('openai-completions', [{ id: 'glm' }]) });
    expect(plan(openaiOnly(), { settings: { cacheControlOnTools: true } }).revision).toBe(
      plan(openaiOnly()).revision
    );
  });

  it('leaves the route-level knobs of decision 040 as they were', () => {
    expect(dshRouteSettings({ cacheControlOnTools: true })).toEqual(dshRouteSettings());
  });
});

describe('User-Agent relay (decision 171, GitHub issue #7)', () => {
  const mixed = () => ({
    claude: provider('anthropic-messages', [{ id: 'sonnet' }]),
    gpt: provider('openai-responses', [{ id: 'g' }], { headers: { 'X-Literal': 'fixed' } }),
    china: provider('openai-completions', [{ id: 'glm' }, { id: 'v2', baseUrl: `${GW}/v2` }]),
  });
  const relayed = (p: DshModelPlan) =>
    Object.fromEntries(
      Object.entries(p.routes).map(([route, r]) => [route, r.headers?.['X-Aiclient-User-Agent']])
    );

  it('default: every route, of every protocol, relays claude-cli-pilab/<app version>', () => {
    const p = plan(mixed(), { clientVersion: '1.1.0-dsh.8' });
    expect(relayed(p)).toEqual({
      claude: 'claude-cli-pilab/1.1.0-dsh.8',
      gpt: 'claude-cli-pilab/1.1.0-dsh.8',
      china: 'claude-cli-pilab/1.1.0-dsh.8',
      'china~2': 'claude-cli-pilab/1.1.0-dsh.8',
    });
    // An explicit default plans the same, and nothing is reported.
    expect(
      plan(mixed(), { clientVersion: '1.1.0-dsh.8', settings: { userAgentMode: 'default' } })
    ).toEqual(p);
    expect(p.dropped.filter((drop) => drop.kind === 'setting')).toEqual([]);
    // Every other header stays as it was.
    expect(p.routes.gpt?.headers).toEqual({
      'X-Literal': 'fixed',
      'X-Pilab-Client': '1.1.0-dsh.8',
      'X-Aiclient-User-Agent': 'claude-cli-pilab/1.1.0-dsh.8',
    });
  });

  it("engine: no route carries the relay header, so DSH's own User-Agent goes out", () => {
    const p = plan(mixed(), { clientVersion: '1.1.0', settings: { userAgentMode: 'engine' } });
    expect(relayed(p)).toEqual({
      claude: undefined,
      gpt: undefined,
      china: undefined,
      'china~2': undefined,
    });
    expect(p.routes.claude?.headers).toEqual({ 'X-Pilab-Client': '1.1.0' });
    expect(p.dropped.filter((drop) => drop.kind === 'setting')).toEqual([]);
  });

  it('custom: the trimmed value on every route', () => {
    const p = plan(mixed(), {
      clientVersion: '1.1.0',
      settings: { userAgentMode: 'custom', userAgentCustom: '  pilab-gw/2 (custom)  ' },
    });
    expect(new Set(Object.values(relayed(p)))).toEqual(new Set(['pilab-gw/2 (custom)']));
    expect(p.dropped.filter((drop) => drop.kind === 'setting')).toEqual([]);
  });

  it.each([
    ['', 'empty'],
    [undefined, 'empty'],
    ['a'.repeat(257), 'too_long'],
    ['foo/1\r\nX-Injected: 1', 'invalid_character'],
    ['tab\tbed/1', 'invalid_character'],
    ['claude-cli-pilab/1 (测试)', 'invalid_character'],
  ])('custom %j falls back to the default and says why (%s)', (custom, problem) => {
    const p = plan(mixed(), {
      clientVersion: '1.1.0',
      settings: {
        userAgentMode: 'custom',
        ...(custom === undefined ? {} : { userAgentCustom: custom }),
      },
    });
    expect(new Set(Object.values(relayed(p)))).toEqual(new Set(['claude-cli-pilab/1.1.0']));
    expect(p.dropped.filter((drop) => drop.kind === 'setting')).toEqual([
      { kind: 'setting', setting: 'userAgent', reason: 'invalid_user_agent', detail: problem },
    ]);
    // Same routes as the default: the host is not restarted for a bad value.
    expect(p.revision).toBe(plan(mixed(), { clientVersion: '1.1.0' }).revision);
  });

  it("a version that makes the default unusable plans DSH's own, and says why", () => {
    const p = plan(mixed(), { clientVersion: '1.1.0 (测试)' });
    expect(new Set(Object.values(relayed(p)))).toEqual(new Set([undefined]));
    expect(p.dropped.filter((drop) => drop.kind === 'setting')).toEqual([
      {
        kind: 'setting',
        setting: 'userAgent',
        reason: 'invalid_user_agent',
        detail: 'invalid_character',
      },
    ]);
  });

  it('changes the revision with the value, so the host restarts for a new one', () => {
    const revision = (settings: DshModelPlanInput['settings']) =>
      plan(mixed(), { clientVersion: '1.1.0', ...(settings ? { settings } : {}) }).revision;
    const all = new Set([
      revision(undefined),
      revision({ userAgentMode: 'engine' }),
      revision({ userAgentMode: 'custom', userAgentCustom: 'a/1' }),
      revision({ userAgentMode: 'custom', userAgentCustom: 'b/1' }),
    ]);
    expect(all.size).toBe(4);
    // A custom value kept while another mode is chosen does not reach the plan.
    expect(revision({ userAgentMode: 'engine', userAgentCustom: 'a/1' })).toBe(
      revision({ userAgentMode: 'engine' })
    );
  });

  it('leaves the route-level knobs of decision 040 and the GW-16 compat as they were', () => {
    const withoutHeaders = (p: DshModelPlan) =>
      Object.fromEntries(
        Object.entries(p.routes).map(([key, { headers: _h, ...rest }]) => [key, rest])
      );
    expect(withoutHeaders(plan(mixed(), { settings: { userAgentMode: 'engine' } }))).toEqual(
      withoutHeaders(plan(mixed()))
    );
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
