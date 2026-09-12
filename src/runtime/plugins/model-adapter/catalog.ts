/**
 * The model catalog — `models.json` + `auth.json` in shape, wherever they came
 * from.
 *
 * `src/main/services/piModelConfig/PiModelConfigService.ts` builds both, and
 * `configValidation.ts#toPiModelsJson` is the exact shape. This module is
 * deliberately a READER only: nothing here writes, so a runtime bug can never
 * corrupt the files the legacy backend also depends on while both backends
 * coexist (ARD §5.1).
 *
 * ## P5-5: on disk is now the fallback, not the source
 *
 * Those files exist because pi can only be configured through files, which
 * forces the app to decrypt the user's keys and write them out at 0600 — a
 * coexistence-period measure due for removal with the rest of pi-coding-agent
 * in P6-2. In the app, Main now assembles the same two documents in memory and
 * hands them to the native worker in its bootstrap payload; `readPiCatalog`
 * below is what the smoke runner and the fixed probe suite still use, because
 * they point at a fixture directory and have no Main to ask.
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

import { join } from 'node:path';
import { RuntimeConfigError, type RuntimeHostIoService } from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';

export const MODELS_FILE_NAME = 'models.json';
export const AUTH_FILE_NAME = 'auth.json';

/**
 * Every wire protocol this runtime can bind, which is every one pi-ai ships an
 * adapter for.
 *
 * P5-5. This list used to be the four entries of `PI_MODEL_APIS` — the
 * whitelist that validates what the COMPANY GATEWAY is allowed to send us. The
 * catalog also carries the services a user added themselves (H/17), and that
 * form offers all ten (`USER_PROVIDER_APIS` in `src/shared/userProviders.ts`).
 * Mirroring the managed whitelist here meant six of those ten were dropped by
 * `asApi` below with no error anywhere: the service was saved, the key was
 * stored, and the provider simply never appeared in the model picker.
 */
export const CATALOG_APIS = [
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
] as const;
export type CatalogApi = (typeof CATALOG_APIS)[number];

export interface CatalogModel {
  id: string;
  name: string;
  api: CatalogApi;
  /**
   * ARD D15's escape hatch: an address for THIS model, overriding the
   * provider's. Present only when the row states one, so a catalog that says
   * nothing keeps inheriting the provider's address as before.
   */
  baseUrl?: string;
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

/**
 * A provider the reader could not bind, and why.
 *
 * P5-5. Dropping is still the right outcome — a provider whose protocol this
 * client cannot speak would only fail at request time — but doing it silently
 * is not: "I saved the service and it is not in the list" has no other symptom
 * to go on. The reason travels up to `ModelCatalogSource` so it lands in the
 * run's version stamp.
 */
export interface CatalogDrop {
  id: string;
  reason: 'unknown_api' | 'no_usable_model';
  detail?: string;
}

export interface PiCatalog {
  /** The directory read, or `null` when the host handed the documents over. */
  dir: string | null;
  providers: CatalogProvider[];
  dropped: CatalogDrop[];
}

/**
 * PI-Desktop's defaults for a model the catalog does not size
 * (`provider-binding.ts` `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS`).
 * Reused rather than re-picked so the two runtimes fail the same way on the
 * same under-specified model row.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

export async function readPiCatalog(
  dir: string,
  env: NodeJS.ProcessEnv,
  io: RuntimeHostIoService
): Promise<PiCatalog> {
  const models = await readJsonFile(join(dir, MODELS_FILE_NAME), 'models_json', io);
  const auth = await readOptionalJsonFile(join(dir, AUTH_FILE_NAME), io);
  return parsePiCatalog({ models, auth }, env, { dir, label: join(dir, MODELS_FILE_NAME) });
}

/**
 * P5-5 — the one parser, whether the documents came off disk or over the wire.
 *
 * Shared rather than reimplemented on the host side: the two sources must
 * produce the same catalog from the same bytes, and a second implementation
 * would be a second set of rules about which providers survive.
 */
export function parsePiCatalog(
  documents: { models: Record<string, unknown>; auth?: Record<string, unknown> | null },
  env: NodeJS.ProcessEnv,
  origin: { dir: string | null; label: string }
): PiCatalog {
  const { models, auth = null } = documents;
  const providersRaw = asRecord(models.providers);
  if (!providersRaw) {
    throw new RuntimeConfigError('models_json_shape', `${origin.label} has no "providers" object`);
  }
  const providers: CatalogProvider[] = [];
  const dropped: CatalogDrop[] = [];
  for (const [id, value] of Object.entries(providersRaw)) {
    const provider = asRecord(value);
    if (!provider) {
      dropped.push({ id, reason: 'unknown_api', detail: 'not an object' });
      continue;
    }
    const api = asApi(provider.api);
    if (!api) {
      dropped.push({ id, reason: 'unknown_api', detail: String(provider.api) });
      continue;
    }
    const modelList = Array.isArray(provider.models) ? provider.models : [];
    const parsedModels = modelList
      .map((entry) => parseModel(entry, api))
      .filter((entry): entry is CatalogModel => entry !== null);
    // A provider with no usable model row is dropped rather than kept empty:
    // `resolve()` can only fail on it, and an empty provider in `list()` would
    // offer the operator a choice that cannot work.
    if (parsedModels.length === 0) {
      dropped.push({ id, reason: 'no_usable_model' });
      continue;
    }
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
  return { dir: origin.dir, providers, dropped };
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
    ...(typeof model.baseUrl === 'string' && model.baseUrl ? { baseUrl: model.baseUrl } : {}),
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

async function readJsonFile(
  path: string,
  code: string,
  io: RuntimeHostIoService
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = Buffer.from(
      (await io.readFile(path, { maxBytes: 8 * 1024 * 1024, overflow: 'error' })).bytes
    ).toString('utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
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

async function readOptionalJsonFile(
  path: string,
  io: RuntimeHostIoService
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = Buffer.from(
      (await io.readFile(path, { maxBytes: 8 * 1024 * 1024, overflow: 'error' })).bytes
    ).toString('utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  try {
    return asRecord(JSON.parse(text));
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
