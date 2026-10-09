import { describe, expect, it } from 'vitest';
import { DSH_OFFERED_COMPAT, DSH_PROTOCOLS } from '../dshModelPlan/tables';
import {
  applyModelMetaPatch,
  availableModelEfforts,
  compatForPreset,
  compatPresetSendsEfforts,
  hasModelMeta,
  isModelMetaCustomized,
  isSupportedUserProviderApi,
  isUserCompatPreset,
  isUserProviderApi,
  modelMetaDraft,
  modelMetaForApi,
  normalizeModelEfforts,
  PROVIDER_PRESETS,
  parseModelTokenCount,
  prefillModelMeta,
  providerModelListAttempts,
  SUPPORTED_USER_PROVIDER_APIS,
  suggestsAdaptiveThinking,
  USER_COMPAT_PRESETS,
  USER_MODEL_EFFORTS,
  USER_PROVIDER_APIS,
} from '../userProviders';

/**
 * P1-5d (decision 036 rule 2, decision 148) — the settings page must narrow
 * to the same three protocols the model menu's "N models unavailable" footer
 * already filters by (`dshModelPlan/build.ts`'s `isProtocol`, checked against
 * this same `DSH_PROTOCOLS` table). A copy of "three" living in two places
 * would drift the moment DSH's own route table changes; a shared reference
 * cannot.
 */
describe('SUPPORTED_USER_PROVIDER_APIS', () => {
  it('is the exact same table dshModelPlan/build.ts checks, not a copy of it', () => {
    expect(SUPPORTED_USER_PROVIDER_APIS).toBe(DSH_PROTOCOLS);
  });

  it('is openai-completions, openai-responses and anthropic-messages, in that order', () => {
    expect(SUPPORTED_USER_PROVIDER_APIS).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ]);
  });

  it('is a subset of USER_PROVIDER_APIS — storage keeps accepting all ten', () => {
    for (const api of SUPPORTED_USER_PROVIDER_APIS) {
      expect(USER_PROVIDER_APIS).toContain(api);
    }
    // The other seven round-trip through storage unharmed; narrowing is a UI
    // concern, not a change to what `isUserProviderApi` accepts.
    for (const api of USER_PROVIDER_APIS) {
      expect(isUserProviderApi(api)).toBe(true);
    }
  });
});

describe('isSupportedUserProviderApi', () => {
  it('accepts the three the DSH route speaks', () => {
    expect(isSupportedUserProviderApi('openai-completions')).toBe(true);
    expect(isSupportedUserProviderApi('openai-responses')).toBe(true);
    expect(isSupportedUserProviderApi('anthropic-messages')).toBe(true);
  });

  it('rejects the seven DSH cannot route (decision 036)', () => {
    const unsupported = USER_PROVIDER_APIS.filter((api) => !isSupportedUserProviderApi(api));
    expect(unsupported).toEqual([
      'openai-codex-responses',
      'azure-openai-responses',
      'google-generative-ai',
      'google-vertex',
      'bedrock-converse-stream',
      'mistral-conversations',
      'pi-messages',
    ]);
  });
});

/**
 * The preset list a new service's "Service" picker offers is filtered by the
 * dialog, not by this module — see `ProviderSetupDialog.tsx`'s
 * `SELECTABLE_PRESETS`. What belongs here is the fact the filter relies on:
 * exactly the Google and Mistral entries use an API style DSH cannot route.
 */
describe('PROVIDER_PRESETS vs the DSH-supported protocols', () => {
  it('has exactly two presets (google, mistral) outside the three DSH speaks', () => {
    const unsupported = PROVIDER_PRESETS.filter(
      (preset) => !isSupportedUserProviderApi(preset.api)
    );
    expect(unsupported.map((preset) => preset.id)).toEqual(['google', 'mistral']);
  });
});

/** Decision 165 — where a service lists its models, per API style. */
describe('providerModelListAttempts', () => {
  const anthropicOrder = (base: string) => [
    { url: `${base}/v1/models?limit=1000`, path: '/v1/models', auth: 'anthropic' },
    {
      url: `${base}/v1/models?limit=1000`,
      path: '/v1/models',
      auth: 'bearer',
      onlyAfterRefusal: true,
    },
    { url: `${base}/models`, path: '/models', auth: 'anthropic' },
  ];

  it('asks an anthropic-messages root /v1/models, then a bearer retry, then the old /models', () => {
    expect(providerModelListAttempts('https://api.anthropic.com', 'anthropic-messages')).toEqual(
      anthropicOrder('https://api.anthropic.com')
    );
  });

  it('keeps a subpath, and reduces a pasted /v1 or /v1/messages to the root first', () => {
    expect(
      providerModelListAttempts('https://proxy.example/anthropic', 'anthropic-messages')
    ).toEqual(anthropicOrder('https://proxy.example/anthropic'));
    for (const pasted of [
      'https://proxy.example/v1',
      'https://proxy.example/v1/',
      'https://proxy.example/v1/messages',
      ' https://proxy.example/V1/messages/ ',
    ]) {
      expect(providerModelListAttempts(pasted, 'anthropic-messages'), pasted).toEqual(
        anthropicOrder('https://proxy.example')
      );
    }
  });

  it('leaves every other style on one /models request under its own base', () => {
    expect(providerModelListAttempts('https://api.example.com/v1', 'openai-completions')).toEqual([
      { url: 'https://api.example.com/v1/models', path: '/models', auth: 'bearer' },
    ]);
    expect(providerModelListAttempts('https://api.openai.com/v1', 'openai-responses')).toEqual([
      { url: 'https://api.openai.com/v1/models', path: '/models', auth: 'bearer' },
    ]);
    expect(
      providerModelListAttempts(
        'https://generativelanguage.googleapis.com/v1beta',
        'google-generative-ai'
      )
    ).toEqual([
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        path: '/models',
        auth: 'google',
      },
    ]);
    expect(providerModelListAttempts('https://pi.example/v1', 'pi-messages')).toEqual([
      { url: 'https://pi.example/v1/models', path: '/models', auth: 'anthropic' },
    ]);
  });
});

/** Decision 165 (user ruling 2026-10-09): the form's prefill, aligned with pi-ai's catalog. */
describe('suggestsAdaptiveThinking', () => {
  it.each([
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-4.6',
    'claude-sonnet-4.6',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-fable-5.1',
    'claude-mythos-5',
    'anthropic/claude-opus-4.6',
    'anthropic/claude-opus-5',
    'us.anthropic.claude-opus-4-6-v1',
    'claude-opus-4-6-20260101',
    'claude-opus-5-5[1m]',
    'Claude-Opus-5-5',
    ' claude-sonnet-5 ',
  ])('suggests it for %s', (id) => {
    expect(suggestsAdaptiveThinking(id)).toBe(true);
  });

  it.each([
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-haiku-5',
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-1',
    'claude-opus-4',
    'claude-sonnet-4',
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-20250219',
    'anthropic/claude-haiku-4.5',
    'claude-opus-4-60',
    'not-claude-opus-5',
    'gpt-5',
    '',
  ])('does not suggest it for %s', (id) => {
    expect(suggestsAdaptiveThinking(id)).toBe(false);
  });
});

/** Decision 165 — the per-model metadata rules the form applies, kept pure for reuse. */
describe('per-model metadata helpers', () => {
  it('applyModelMetaPatch: adaptive thinking implies reasoning; no reasoning clears it', () => {
    expect(applyModelMetaPatch(undefined, { adaptiveThinking: true })).toEqual({
      adaptiveThinking: true,
      reasoning: true,
    });
    const on = { reasoning: true, adaptiveThinking: true, contextWindow: 200000 };
    expect(applyModelMetaPatch(on, { adaptiveThinking: undefined })).toEqual({
      reasoning: true,
      adaptiveThinking: undefined,
      contextWindow: 200000,
    });
    expect(applyModelMetaPatch(on, { reasoning: undefined })).toEqual({
      reasoning: undefined,
      adaptiveThinking: undefined,
      contextWindow: 200000,
    });
    expect(applyModelMetaPatch(on, { maxTokens: 32000 })).toEqual({ ...on, maxTokens: 32000 });
  });

  it('modelMetaForApi keeps adaptive thinking only for anthropic-messages, and only set fields', () => {
    const meta = { reasoning: true, adaptiveThinking: true, maxTokens: undefined };
    expect(modelMetaForApi(meta, 'anthropic-messages')).toEqual({
      reasoning: true,
      adaptiveThinking: true,
    });
    expect(modelMetaForApi(meta, 'openai-completions')).toEqual({ reasoning: true });
    expect(Object.keys(modelMetaForApi(meta, 'openai-completions'))).toEqual(['reasoning']);
  });

  it('hasModelMeta treats a row of cleared fields as no metadata', () => {
    expect(hasModelMeta(undefined)).toBe(false);
    expect(hasModelMeta({})).toBe(false);
    expect(hasModelMeta({ reasoning: undefined, adaptiveThinking: undefined })).toBe(false);
    expect(hasModelMeta({ reasoning: false })).toBe(true);
  });

  it('prefillModelMeta: only anthropic-messages, only a matching id, only with no metadata yet', () => {
    // Decision 168 (user ruling 2026-10-09): Low / Medium / High / Max, not X-High.
    const prefill = {
      reasoning: true,
      adaptiveThinking: true,
      efforts: ['low', 'medium', 'high', 'max'],
    };
    expect(prefillModelMeta('claude-opus-5-5', 'anthropic-messages', undefined)).toEqual(prefill);
    expect(prefillModelMeta('claude-opus-5-5', 'anthropic-messages', {})).toEqual(prefill);
    expect(prefillModelMeta('claude-haiku-4-5', 'anthropic-messages', undefined)).toBeUndefined();
    expect(prefillModelMeta('claude-opus-5-5', 'openai-completions', undefined)).toBeUndefined();
    expect(
      prefillModelMeta('claude-opus-5-5', 'anthropic-messages', { contextWindow: 200000 })
    ).toBeUndefined();
    expect(
      prefillModelMeta('claude-opus-5-5', 'anthropic-messages', { reasoning: false })
    ).toBeUndefined();
  });

  it('modelMetaDraft: selected models, set fields, fields the style takes', () => {
    expect(
      modelMetaDraft({
        selected: ['a', 'b'],
        meta: {
          a: { reasoning: true, adaptiveThinking: true },
          b: { reasoning: undefined },
          c: { contextWindow: 1000 },
        },
        api: 'openai-completions',
      })
    ).toEqual({ a: { reasoning: true } });
    expect(
      modelMetaDraft({
        selected: ['a'],
        meta: { a: { reasoning: true, adaptiveThinking: true } },
        api: 'anthropic-messages',
      })
    ).toEqual({ a: { reasoning: true, adaptiveThinking: true } });
  });

  it('modelMetaDraft: leaves the map out when nothing is set and nothing is stored', () => {
    expect(
      modelMetaDraft({ selected: ['a'], meta: { a: {} }, api: 'anthropic-messages' })
    ).toBeUndefined();
    expect(
      modelMetaDraft({ selected: ['a'], meta: {}, api: 'anthropic-messages', stored: {} })
    ).toBeUndefined();
  });

  it('modelMetaDraft: sends an empty map when an edit cleared what is stored', () => {
    const stored = { a: { reasoning: true, adaptiveThinking: true } };
    expect(
      modelMetaDraft({
        selected: ['a'],
        meta: { a: { reasoning: undefined, adaptiveThinking: undefined } },
        api: 'anthropic-messages',
        stored,
      })
    ).toEqual({});
    // Deselecting the only model with metadata clears it too.
    expect(
      modelMetaDraft({ selected: [], meta: stored, api: 'anthropic-messages', stored })
    ).toEqual({});
  });
});

/** Decision 168 — the settings panel's rules, kept pure for the form, the IPC and Main. */
describe('model settings helpers (decision 168)', () => {
  it('offers every level but off, in escalation order', () => {
    expect(USER_MODEL_EFFORTS).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('availableModelEfforts follows the matrix', () => {
    expect(availableModelEfforts('anthropic-messages', true)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(availableModelEfforts('anthropic-messages', false)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    for (const api of ['openai-completions', 'openai-responses']) {
      expect(availableModelEfforts(api, false)).toEqual(USER_MODEL_EFFORTS);
      // Adaptive thinking means nothing outside anthropic-messages.
      expect(availableModelEfforts(api, true)).toEqual(USER_MODEL_EFFORTS);
    }
  });

  it('normalizeModelEfforts filters, dedupes, orders, and collapses to absent', () => {
    expect(
      normalizeModelEfforts(['max', 'low', 'max', 'off', 'bogus', 7], 'openai-completions', false)
    ).toEqual(['low', 'max']);
    // Adaptive: no minimal. Budget: no xhigh / max.
    expect(normalizeModelEfforts(['minimal', 'max'], 'anthropic-messages', true)).toEqual(['max']);
    expect(normalizeModelEfforts(['high', 'xhigh', 'max'], 'anthropic-messages', false)).toEqual([
      'high',
    ]);
    // Nothing left, or exactly the implied three: no field.
    expect(normalizeModelEfforts(['max'], 'anthropic-messages', false)).toBeUndefined();
    expect(normalizeModelEfforts(['off'], 'openai-completions', false)).toBeUndefined();
    expect(normalizeModelEfforts([], 'openai-completions', false)).toBeUndefined();
    expect(
      normalizeModelEfforts(['high', 'low', 'medium'], 'openai-responses', false)
    ).toBeUndefined();
    expect(normalizeModelEfforts('low', 'openai-completions', false)).toBeUndefined();
    expect(normalizeModelEfforts(undefined, 'openai-completions', false)).toBeUndefined();
  });

  it('applyModelMetaPatch normalizes efforts when adaptive thinking flips', () => {
    const adaptiveMax = { reasoning: true, adaptiveThinking: true, efforts: ['max' as const] };
    // Off: budget thinking has no Max, nothing is left, so the field goes.
    expect(
      applyModelMetaPatch(adaptiveMax, { adaptiveThinking: undefined }, 'anthropic-messages')
    ).toEqual({ reasoning: true, adaptiveThinking: undefined, efforts: undefined });
    const budget = { reasoning: true, efforts: ['minimal' as const, 'low' as const] };
    expect(
      applyModelMetaPatch(budget, { adaptiveThinking: true }, 'anthropic-messages').efforts
    ).toEqual(['low']);
    // An edit of the levels is normalized too; one that touches neither is not.
    expect(
      applyModelMetaPatch({ reasoning: true }, { efforts: ['max', 'low'] }, 'openai-completions')
        .efforts
    ).toEqual(['low', 'max']);
    const openaiMeta = { reasoning: true, efforts: ['minimal' as const] };
    expect(
      applyModelMetaPatch(openaiMeta, { maxTokens: 32000 }, 'anthropic-messages').efforts
    ).toEqual(['minimal']);
    // Without an api the decision 165 behavior is unchanged.
    expect(applyModelMetaPatch(adaptiveMax, { adaptiveThinking: undefined }).efforts).toEqual([
      'max',
    ]);
  });

  it('modelMetaForApi keeps efforts and the preset only while reasoning is on', () => {
    const meta = {
      name: '  Opus  ',
      reasoning: true,
      efforts: ['minimal' as const, 'max' as const],
      compatPreset: 'deepseek' as const,
    };
    expect(modelMetaForApi(meta, 'openai-completions')).toEqual({
      name: 'Opus',
      reasoning: true,
      efforts: ['minimal', 'max'],
      compatPreset: 'deepseek',
    });
    // The preset only exists for openai-completions; levels follow the matrix.
    expect(modelMetaForApi(meta, 'openai-responses')).toEqual({
      name: 'Opus',
      reasoning: true,
      efforts: ['minimal', 'max'],
    });
    expect(modelMetaForApi(meta, 'anthropic-messages')).toEqual({
      name: 'Opus',
      reasoning: true,
      efforts: ['minimal'],
    });
    expect(modelMetaForApi({ ...meta, reasoning: undefined }, 'openai-completions')).toEqual({
      name: 'Opus',
    });
    expect(modelMetaForApi({ name: '   ' }, 'openai-completions')).toEqual({});
  });

  it('modelMetaForApi drops the levels of a preset that sends none', () => {
    expect(compatPresetSendsEfforts('qwen-chat-template')).toBe(false);
    expect(compatPresetSendsEfforts('qwen')).toBe(true);
    expect(compatPresetSendsEfforts(undefined)).toBe(true);
    expect(
      modelMetaForApi(
        { reasoning: true, efforts: ['max'], compatPreset: 'qwen-chat-template' },
        'openai-completions'
      )
    ).toEqual({ reasoning: true, compatPreset: 'qwen-chat-template' });
  });

  it('every preset writes only compat keys DSH offers on openai-completions', () => {
    const offered = DSH_OFFERED_COMPAT['openai-completions'];
    for (const preset of USER_COMPAT_PRESETS) {
      const compat = compatForPreset(preset);
      expect(compat.thinkingFormat).toBe(preset);
      expect(Object.keys(compat).every((key) => offered.includes(key))).toBe(true);
      expect(Object.keys(compat).sort()).toEqual([
        'maxTokensField',
        'requiresReasoningContentOnAssistantMessages',
        'supportsDeveloperRole',
        'supportsReasoningEffort',
        'supportsStore',
        'thinkingFormat',
      ]);
    }
    // The vendor groups pi-ai's catalog gives the native endpoints.
    expect(compatForPreset('deepseek')).toMatchObject({
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(compatForPreset('zai')).toMatchObject({ maxTokensField: 'max_tokens' });
    expect(compatForPreset('openai')).toMatchObject({
      supportsDeveloperRole: true,
      maxTokensField: 'max_completion_tokens',
    });
    expect(isUserCompatPreset('qwen')).toBe(true);
    expect(isUserCompatPreset('chat-template')).toBe(false);
    expect(isUserCompatPreset(undefined)).toBe(false);
  });

  it('isModelMetaCustomized compares with what a fresh selection would get', () => {
    const prefill = prefillModelMeta('claude-opus-5-5', 'anthropic-messages', undefined);
    expect(isModelMetaCustomized('claude-opus-5-5', 'anthropic-messages', prefill)).toBe(false);
    expect(isModelMetaCustomized('claude-opus-5-5', 'anthropic-messages', undefined)).toBe(true);
    expect(isModelMetaCustomized('gpt-5', 'openai-completions', undefined)).toBe(false);
    expect(isModelMetaCustomized('gpt-5', 'openai-completions', { name: ' ' })).toBe(false);
    expect(isModelMetaCustomized('gpt-5', 'openai-completions', { maxTokens: 1 })).toBe(true);
    // A field the style hides is not a customization.
    expect(isModelMetaCustomized('gpt-5', 'openai-completions', { adaptiveThinking: true })).toBe(
      false
    );
  });

  it('parseModelTokenCount reads digits only, as a positive whole number', () => {
    expect(parseModelTokenCount('')).toEqual({ invalid: false });
    expect(parseModelTokenCount('  ')).toEqual({ invalid: false });
    expect(parseModelTokenCount('200000')).toEqual({ value: 200000, invalid: false });
    expect(parseModelTokenCount(' 128,000 ')).toEqual({ value: 128000, invalid: false });
    for (const raw of ['0', '-1', '1.5', '1e999', '32k', 'abc', '99999999999999999999']) {
      expect(parseModelTokenCount(raw)).toEqual({ invalid: true });
    }
  });
});
