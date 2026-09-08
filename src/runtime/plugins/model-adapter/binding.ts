/**
 * Turning a catalog entry into pi-ai objects.
 *
 * Shaped after PI-Desktop's `provider-binding.ts`, which is the reference
 * implementation for this exact step, with two deliberate differences:
 *
 *  - PI-Desktop binds ONE provider and ONE model per registry, because a
 *    sidecar there serves a single pinned model. Our catalog is a menu the user
 *    picks from at any turn, so a registry is built per provider and cached,
 *    and `resolve()` hands the loop the registry that owns the chosen model.
 *  - PI-Desktop resolves auth through an Electron-main round trip because its
 *    vendor accounts hold OAuth tokens that expire hourly. Our keys come from
 *    `auth.json`, which Main rewrites on every sync, so a plain `apiKey` is the
 *    whole of the auth (ARD D7). The `resolve` callback is still per request,
 *    so a key rotated on disk between runs is picked up by the next bootstrap
 *    without any caching to invalidate.
 */

import {
  type Api,
  createModels,
  createProvider,
  type Model,
  type Models,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type { CatalogApi, CatalogModel, CatalogProvider } from './catalog.ts';

/**
 * Zero prices, stated once.
 *
 * The management catalog carries no pricing, so `calculateCost` would be
 * guessing. Reporting 0 is the honest answer for a gateway that does not
 * publish rates, and it keeps `Usage.cost` present (pi-ai requires the field)
 * without inventing a number a user might act on. Token counts — the ones ARD
 * D9's cache-hit gate actually reads — are unaffected: they are the provider's
 * own report.
 */
const NO_PUBLISHED_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const API_ADAPTERS: Record<CatalogApi, () => ProviderStreams> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
};

export function buildModel(provider: CatalogProvider, model: CatalogModel): Model<Api> {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: model.reasoning,
    input: model.input,
    cost: { ...NO_PUBLISHED_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
    // Provider-level `compat` is the baseline and the model's own row wins,
    // matching how `toPiModelsJson` lets a model override its provider.
    ...(provider.compat || model.compat
      ? { compat: { ...(provider.compat ?? {}), ...(model.compat ?? {}) } }
      : {}),
  } as Model<Api>;
}

/** A pi-ai registry holding one catalog provider and all of its models. */
export function buildProviderModels(provider: CatalogProvider): Models {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider.id,
      name: provider.id,
      baseUrl: provider.baseUrl,
      // Provider headers ride on the provider, not on each model: they are the
      // same for every row and duplicating them per model would make a header
      // change a per-model edit.
      ...(Object.keys(provider.headers).length > 0 ? { headers: provider.headers } : {}),
      auth: {
        apiKey: {
          name: `${provider.id} API key`,
          // Plain `apiKey` semantics: each adapter emits its own auth header
          // (Bearer for OpenAI-style, x-api-key for Anthropic). Returning the
          // key from a callback rather than baking it in means nothing here
          // holds a decrypted secret for longer than a request.
          resolve: async () => ({ auth: { apiKey: provider.apiKey } }),
        },
      },
      models: provider.models.map((model) => buildModel(provider, model)),
      api: API_ADAPTERS[provider.api](),
    })
  );
  return models;
}
