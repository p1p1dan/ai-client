import {
  PI_MODEL_APIS,
  type PiManagedModelDefinition,
  type PiManagedModelsConfig,
  type PiManagedProviderDefinition,
  type PiModelApi,
} from '@shared/piModelConfig';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

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

function validateModel(value: unknown, field: string): PiManagedModelDefinition {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
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
  field: string
): PiManagedProviderDefinition {
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(`${field} has an invalid provider id`);
  }
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if ('apiKey' in value || 'key' in value || 'token' in value || 'oauth' in value) {
    throw new Error(`${field} must not contain credentials`);
  }
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  if (!baseUrl) throw new Error(`${field}.baseUrl is required`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error(`${field}.baseUrl must be an absolute URL`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`${field}.baseUrl must use http or https`);
  }
  const api = validateApi(value.api, `${field}.api`);
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new Error(`${field}.models must be a non-empty array`);
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
    baseUrl,
    api,
    ...(value.authHeader !== undefined ? { authHeader: Boolean(value.authHeader) } : {}),
    ...(headers ? { headers } : {}),
    ...(value.compat !== undefined
      ? { compat: optionalRecord(value.compat, `${field}.compat`) }
      : {}),
    models,
  };
}

export function validatePiManagedModelsConfig(value: unknown): PiManagedModelsConfig {
  if (!isRecord(value)) throw new Error('model config must be an object');
  if (value.version !== 1) throw new Error('model config version must be 1');
  if (!isRecord(value.providers)) throw new Error('model config providers must be an object');
  const providers: Record<string, PiManagedProviderDefinition> = {};
  for (const [providerId, provider] of Object.entries(value.providers)) {
    providers[providerId] = validateProvider(providerId, provider, `providers.${providerId}`);
  }
  if (Object.keys(providers).length === 0) {
    throw new Error('model config must contain at least one provider');
  }
  return {
    version: 1,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    providers,
  };
}

export function toPiModelsJson(config: PiManagedModelsConfig): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const [providerId, provider] of Object.entries(config.providers)) {
    const { name: _name, ...rest } = provider;
    providers[providerId] = rest;
  }
  return { providers };
}
