/**
 * Reading the pi catalog the app already writes — `models.json` + `auth.json`
 * under the managed agent directory (ARD D7: the credential system does not
 * change, the runtime reads it).
 *
 * `src/main/services/piModelConfig/PiModelConfigService.ts` is the writer, and
 * `configValidation.ts#toPiModelsJson` is the exact shape landed on disk. This
 * module is deliberately a READER only: nothing here writes, so a runtime bug
 * can never corrupt the files the legacy backend also depends on while both
 * backends coexist (ARD §5.1).
 *
 * ## The `$NAME` header rule
 *
 * `configValidation.ts` refuses any provider header whose value is not
 * `$`-prefixed, so that a `models.json` can never come to hold a literal secret
 * or a build-specific value that outlives the build. That makes expansion
 * MANDATORY here: pi-coding-agent used to resolve these references at request
 * time, and dropping that package (ARD D2) moves the job to us. Without it the
 * gateway would receive the literal string `$AICLIENT_PI_USER_AGENT` as a
 * User-Agent, which is a header this client cannot be identified by — exactly
 * what F08 added the field to prevent.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeConfigError } from '../../contracts.ts';

export const MODELS_FILE_NAME = 'models.json';
export const AUTH_FILE_NAME = 'auth.json';

/** Wire APIs the management config may name; mirrors `PI_MODEL_APIS` in `src/shared/piModelConfig.ts`. */
export const CATALOG_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;
export type CatalogApi = (typeof CATALOG_APIS)[number];

export interface CatalogModel {
  id: string;
  name: string;
  api: CatalogApi;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  samplingParams?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

export interface CatalogProvider {
  id: string;
  baseUrl: string;
  /** Already expanded; `$NAME` references that resolved to nothing are dropped. */
  headers: Record<string, string>;
  api: CatalogApi;
  compat?: Record<string, unknown>;
  models: CatalogModel[];
  /** From `auth.json`. `''` when the provider has no stored key. */
  apiKey: string;
}

export interface PiCatalog {
  dir: string;
  providers: CatalogProvider[];
}

/**
 * PI-Desktop's defaults for a model the catalog does not size
 * (`provider-binding.ts` `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS`).
 * Reused rather than re-picked so the two runtimes fail the same way on the
 * same under-specified model row.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

export function readPiCatalog(dir: string, env: NodeJS.ProcessEnv = process.env): PiCatalog {
  const models = readJsonFile(join(dir, MODELS_FILE_NAME), 'models_json');
  const auth = readOptionalJsonFile(join(dir, AUTH_FILE_NAME));
  const providersRaw = asRecord(models.providers);
  if (!providersRaw) {
    throw new RuntimeConfigError(
      'models_json_shape',
      `${join(dir, MODELS_FILE_NAME)} has no "providers" object`
    );
  }
  const providers: CatalogProvider[] = [];
  for (const [id, value] of Object.entries(providersRaw)) {
    const provider = asRecord(value);
    if (!provider) continue;
    const api = asApi(provider.api);
    if (!api) continue;
    const modelList = Array.isArray(provider.models) ? provider.models : [];
    const parsedModels = modelList
      .map((entry) => parseModel(entry, api))
      .filter((entry): entry is CatalogModel => entry !== null);
    // A provider with no usable model row is dropped rather than kept empty:
    // `resolve()` can only fail on it, and an empty provider in `list()` would
    // offer the operator a choice that cannot work.
    if (parsedModels.length === 0) continue;
    providers.push({
      id,
      baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
      headers: expandHeaders(provider.headers, env),
      api,
      compat: asRecord(provider.compat) ?? undefined,
      models: parsedModels,
      apiKey: readProviderKey(auth, id),
    });
  }
  return { dir, providers };
}

/**
 * Resolve `$NAME` header references against the environment.
 *
 * A reference that resolves to nothing is DROPPED, not sent empty: an empty
 * `User-Agent` is a different (and worse) request than one that simply omits
 * the header, and an older Main build that does not export the variable should
 * degrade to pi-ai's own default rather than to a blank field.
 */
export function expandHeaders(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const source = asRecord(raw);
  if (!source) return {};
  const expanded: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (!value.startsWith('$')) {
      // `configValidation.ts` rejects these on the way in, so reaching one here
      // means the file was written by something else. Passed through verbatim
      // rather than dropped: refusing a hand-written config is not this
      // reader's call, and the value is not a secret we introduced.
      expanded[name] = value;
      continue;
    }
    const resolved = env[value.slice(1)]?.trim();
    if (resolved) expanded[name] = resolved;
  }
  return expanded;
}

function parseModel(entry: unknown, providerApi: CatalogApi): CatalogModel | null {
  const model = asRecord(entry);
  if (!model || typeof model.id !== 'string' || !model.id) return null;
  const api = asApi(model.api) ?? providerApi;
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name ? model.name : model.id,
    api,
    reasoning: model.reasoning === true,
    input: parseInputs(model.input),
    contextWindow:
      typeof model.contextWindow === 'number' && model.contextWindow > 0
        ? model.contextWindow
        : DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      typeof model.maxTokens === 'number' && model.maxTokens > 0
        ? model.maxTokens
        : DEFAULT_MAX_TOKENS,
    thinkingLevelMap: asRecord(model.thinkingLevelMap) as Record<string, string | null> | undefined,
    samplingParams: asRecord(model.samplingParams) ?? undefined,
    compat: asRecord(model.compat) ?? undefined,
  };
}

function parseInputs(value: unknown): ('text' | 'image')[] {
  if (!Array.isArray(value)) return ['text'];
  const inputs = value.filter(
    (item): item is 'text' | 'image' => item === 'text' || item === 'image'
  );
  return inputs.length > 0 ? inputs : ['text'];
}

/**
 * `auth.json` is one `{ type: 'api_key', key }` per provider id.
 *
 * A missing entry yields `''` rather than throwing: a provider may legitimately
 * need no key (a local server), and the failure for one that does need a key
 * belongs at request time, where the provider's own error message says which
 * credential was rejected.
 */
function readProviderKey(auth: Record<string, unknown> | null, providerId: string): string {
  const entry = asRecord(auth?.[providerId]);
  return typeof entry?.key === 'string' ? entry.key : '';
}

function readJsonFile(path: string, code: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new RuntimeConfigError(
      `${code}_missing`,
      `${path} is missing — the app writes it at login; run the model sync first`
    );
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const record = asRecord(parsed);
    if (!record) throw new Error('not an object');
    return record;
  } catch (error) {
    throw new RuntimeConfigError(
      `${code}_unparsable`,
      `${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readOptionalJsonFile(path: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asApi(value: unknown): CatalogApi | null {
  return typeof value === 'string' && (CATALOG_APIS as readonly string[]).includes(value)
    ? (value as CatalogApi)
    : null;
}
