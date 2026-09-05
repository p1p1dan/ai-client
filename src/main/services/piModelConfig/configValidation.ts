import {
  PI_MODEL_APIS,
  type PiCredentialSource,
  type PiManagedModelDefinition,
  type PiManagedModelsConfig,
  type PiManagedProviderCredentials,
  type PiManagedProviderDefinition,
  type PiModelApi,
} from '@shared/piModelConfig';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Whether this config came from a source allowed to carry provider credentials.
 *
 * Plan D01 loosened the old blanket "a provider must never contain a key" rule,
 * but did not remove it: a key is accepted ONLY from the authenticated fetch
 * that the management endpoint answers. A config read back off disk, or from
 * any unauthenticated source, is still rejected outright — the degraded
 * direction has to be the safe one.
 */
export interface PiConfigValidationOptions {
  credentialsAllowed?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return { ...value };
}

function validateApi(value: unknown, field: string): PiModelApi {
  if (typeof value !== 'string' || !(PI_MODEL_APIS as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${PI_MODEL_APIS.join(', ')}`);
  }
  return value as PiModelApi;
}

function validateAbsoluteUrl(value: string, field: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`${field} must use http or https`);
  }
  return value;
}

function validateCredentialSource(value: unknown, field: string): PiCredentialSource {
  if (value !== 'managed' && value !== 'onboarding') {
    throw new Error(`${field} must be managed or onboarding`);
  }
  return value;
}

function validateCredentials(value: unknown, field: string): PiManagedProviderCredentials {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return {
    baseUrl: validateCredentialSource(value.baseUrl, `${field}.baseUrl`),
    apiKey: validateCredentialSource(value.apiKey, `${field}.apiKey`),
  };
}

/**
 * How to read a provider from an endpoint that predates D01.
 *
 * An absent `credentials` block is its own case, not a third source value and
 * not a default: it identifies an older management site, where a provider's
 * `baseUrl` was always the value an administrator typed and no provider could
 * carry a key at all. Read that way, an old endpoint keeps working; treating
 * the absence as "inherit" would instead reject every provider it serves.
 */
function legacyCredentials(hasBaseUrl: boolean): PiManagedProviderCredentials {
  return { baseUrl: hasBaseUrl ? 'managed' : 'onboarding', apiKey: 'onboarding' };
}

function validateModel(value: unknown, field: string): PiManagedModelDefinition {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  // Models never carry credentials, from any source: pi authenticates per
  // provider, so a key here would have nothing to authenticate.
  if ('apiKey' in value || 'key' in value || 'token' in value) {
    throw new Error(`${field} must not contain credentials`);
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) throw new Error(`${field}.id is required`);
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : undefined;
  let tags: string[] | undefined;
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) throw new Error(`${field}.tags must be an array`);
    const normalized = value.tags.map((tag, index) => {
      if (typeof tag !== 'string' || !tag.trim()) {
        throw new Error(`${field}.tags[${index}] must be a non-empty string`);
      }
      return tag.trim();
    });
    tags = [...new Set(normalized)];
  }
  const api = value.api === undefined ? undefined : validateApi(value.api, `${field}.api`);
  const reasoning = value.reasoning === undefined ? undefined : Boolean(value.reasoning);

  let input: Array<'text' | 'image'> | undefined;
  if (value.input !== undefined) {
    if (!Array.isArray(value.input) || value.input.length === 0) {
      throw new Error(`${field}.input must be a non-empty array`);
    }
    const values = value.input.map((item) => String(item));
    if (values.some((item) => item !== 'text' && item !== 'image')) {
      throw new Error(`${field}.input supports only text and image`);
    }
    input = [...new Set(values)] as Array<'text' | 'image'>;
  }

  let thinkingLevelMap: PiManagedModelDefinition['thinkingLevelMap'];
  if (value.thinkingLevelMap !== undefined) {
    if (!isRecord(value.thinkingLevelMap)) {
      throw new Error(`${field}.thinkingLevelMap must be an object`);
    }
    thinkingLevelMap = {};
    for (const level of THINKING_LEVELS) {
      const mapped = value.thinkingLevelMap[level];
      if (mapped !== undefined && mapped !== null && typeof mapped !== 'string') {
        throw new Error(`${field}.thinkingLevelMap.${level} must be a string or null`);
      }
      if (mapped !== undefined) thinkingLevelMap[level] = mapped as string | null;
    }
  }

  return {
    id,
    ...(name ? { name } : {}),
    ...(tags ? { tags } : {}),
    ...(api ? { api } : {}),
    ...(value.reasoning !== undefined ? { reasoning } : {}),
    ...(input ? { input } : {}),
    ...(value.contextWindow !== undefined
      ? { contextWindow: optionalPositiveInteger(value.contextWindow, `${field}.contextWindow`) }
      : {}),
    ...(value.maxTokens !== undefined
      ? { maxTokens: optionalPositiveInteger(value.maxTokens, `${field}.maxTokens`) }
      : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(value.samplingParams !== undefined
      ? { samplingParams: optionalRecord(value.samplingParams, `${field}.samplingParams`) }
      : {}),
    ...(value.compat !== undefined
      ? { compat: optionalRecord(value.compat, `${field}.compat`) }
      : {}),
  };
}

function validateProvider(
  providerId: string,
  value: unknown,
  field: string,
  options: Required<PiConfigValidationOptions>
): PiManagedProviderDefinition {
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(`${field} has an invalid provider id`);
  }
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if ('key' in value || 'token' in value || 'oauth' in value) {
    throw new Error(`${field} must not contain credentials`);
  }

  const rawBaseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const stated = value.credentials !== undefined;
  const credentials = stated
    ? validateCredentials(value.credentials, `${field}.credentials`)
    : legacyCredentials(Boolean(rawBaseUrl));

  // With sources stated: a managed value must be present and an inherited one
  // absent. Accepting "managed but empty" would produce a provider pi cannot
  // call, and accepting "inherited but filled" would leave two answers to the
  // same question.
  if (credentials.baseUrl === 'managed') {
    if (!rawBaseUrl) throw new Error(`${field}.baseUrl is required when it is managed`);
    validateAbsoluteUrl(rawBaseUrl, `${field}.baseUrl`);
  } else if (stated && rawBaseUrl) {
    throw new Error(`${field}.baseUrl must be absent when it is inherited`);
  }

  const rawApiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  if (rawApiKey && !options.credentialsAllowed) {
    throw new Error(`${field} must not contain credentials`);
  }
  if (credentials.apiKey === 'managed') {
    // A config that says "managed" without carrying the key is only reachable
    // from an unauthenticated source; treat it as the credential violation it is.
    if (!rawApiKey) throw new Error(`${field}.apiKey is required when it is managed`);
  } else if (rawApiKey) {
    throw new Error(`${field}.apiKey must be absent when it is inherited`);
  }

  // Only stated sources are carried forward; a legacy provider keeps its shape
  // and gets its sources filled in from what it actually had.

  const api = validateApi(value.api, `${field}.api`);
  if (!Array.isArray(value.models)) {
    throw new Error(`${field}.models must be an array`);
  }
  const models = value.models.map((model, index) =>
    validateModel(model, `${field}.models[${index}]`)
  );
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`${field} contains duplicate model id ${model.id}`);
    ids.add(model.id);
  }

  let headers: Record<string, string> | undefined;
  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) throw new Error(`${field}.headers must be an object`);
    headers = {};
    for (const [name, raw] of Object.entries(value.headers)) {
      if (typeof raw !== 'string' || !raw.trim().startsWith('$')) {
        throw new Error(`${field}.headers.${name} must reference an environment variable`);
      }
      headers[name] = raw.trim();
    }
  }

  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : undefined;
  return {
    ...(name ? { name } : {}),
    ...(rawBaseUrl ? { baseUrl: rawBaseUrl } : {}),
    api,
    credentials,
    ...(rawApiKey ? { apiKey: rawApiKey } : {}),
    ...(value.authHeader !== undefined ? { authHeader: Boolean(value.authHeader) } : {}),
    ...(headers ? { headers } : {}),
    ...(value.compat !== undefined
      ? { compat: optionalRecord(value.compat, `${field}.compat`) }
      : {}),
    models,
  };
}

/**
 * Plan D03: zero providers and zero models are legal.
 *
 * "The administrator has enabled nothing" is a real state the endpoint can
 * report, and rejecting it as malformed is what used to send the client down
 * the stale-cache / built-in-table path and show models nobody enabled.
 */
export function validatePiManagedModelsConfig(
  value: unknown,
  options: PiConfigValidationOptions = {}
): PiManagedModelsConfig {
  const resolved = { credentialsAllowed: options.credentialsAllowed ?? false };
  if (!isRecord(value)) throw new Error('model config must be an object');
  if (value.version !== 1) throw new Error('model config version must be 1');
  if (!isRecord(value.providers)) throw new Error('model config providers must be an object');
  const providers: Record<string, PiManagedProviderDefinition> = {};
  for (const [providerId, provider] of Object.entries(value.providers)) {
    providers[providerId] = validateProvider(
      providerId,
      provider,
      `providers.${providerId}`,
      resolved
    );
  }
  return {
    version: 1,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    providers,
  };
}

/**
 * The `models.json` pi reads.
 *
 * Two fields never survive this step: `credentials` (our vocabulary, not pi's)
 * and `apiKey` (pi takes credentials from `auth.json`). The inherited base URL
 * is resolved to the concrete login URL here, because pi needs an address, not
 * a statement about where one comes from.
 */
export function toPiModelsJson(
  config: PiManagedModelsConfig,
  resolve: { inheritedBaseUrl: string }
): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const [providerId, provider] of Object.entries(config.providers)) {
    const { name: _name, credentials, apiKey: _apiKey, baseUrl, ...rest } = provider;
    const resolvedBaseUrl =
      credentials?.baseUrl === 'managed' && baseUrl ? baseUrl : resolve.inheritedBaseUrl;
    providers[providerId] = { ...rest, baseUrl: resolvedBaseUrl };
  }
  return { providers };
}

/** The key pi should present for each provider (plan D01, wire topic §一). */
export function resolveProviderApiKey(
  provider: PiManagedProviderDefinition,
  inheritedApiKey: string
): string {
  return provider.credentials?.apiKey === 'managed' && provider.apiKey
    ? provider.apiKey
    : inheritedApiKey;
}
