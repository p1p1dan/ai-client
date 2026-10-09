import { describe, expect, it } from 'vitest';
import { DSH_PROTOCOLS } from '../dshModelPlan/tables';
import {
  applyModelMetaPatch,
  hasModelMeta,
  isSupportedUserProviderApi,
  isUserProviderApi,
  modelMetaDraft,
  modelMetaForApi,
  PROVIDER_PRESETS,
  prefillModelMeta,
  providerModelListAttempts,
  SUPPORTED_USER_PROVIDER_APIS,
  suggestsAdaptiveThinking,
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
    expect(prefillModelMeta('claude-opus-5-5', 'anthropic-messages', undefined)).toEqual({
      reasoning: true,
      adaptiveThinking: true,
    });
    expect(prefillModelMeta('claude-opus-5-5', 'anthropic-messages', {})).toEqual({
      reasoning: true,
      adaptiveThinking: true,
    });
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
