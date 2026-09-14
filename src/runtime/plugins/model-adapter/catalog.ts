/**
 * The model catalog — `models.json` + `auth.json` in shape, wherever they came
 * from.
 *
 * `src/main/services/piModelConfig/PiModelConfigService.ts` builds both, and
 * `configValidation.ts#toPiModelsJson` is the exact shape. This module is
 * deliberately a READER only: nothing here writes, so a runtime bug can never
 * corrupt those files. That mattered while the legacy backend read them too
 * (ARD §5.1); it still matters after P6-5 retired that backend, because the
 * bundled `pi` CLI behind the embedded terminal reads the same two paths.
 *
 * ## P5-5: on disk is now the fallback, not the source
 *
 * Those files exist because pi can only be configured through files, which
 * forces the app to decrypt the user's keys and write them out at 0600. That
 * was booked as a coexistence-period measure due to die with the legacy
 * backend; P6-5 retired that backend and the files stayed, because what reads
 * them now is the bundled CLI the embedded terminal runs. Removing the
 * plaintext write is therefore its own question — "how does the terminal get
 * credentials" — not a leftover of the old engine.
 * In the app, Main now assembles the same two documents in memory and
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
 * Something the reader could not bind, and why.
 *
 * P5-5. Dropping is still the right outcome — a provider whose protocol this
 * client cannot speak would only fail at request time — but doing it silently
 * is not: "I saved the service and it is not in the list" has no other symptom
 * to go on. The reason travels up to `ModelCatalogSource` so it lands in the
 * run's version stamp, and into the `catalog_empty` error when dropping is why
 * there is nothing left to run against.
 *
 * `id` is the provider's. An entry does NOT always mean the whole provider is
 * gone: `no_base_url` and `no_api_key` are judged per row (ARD D15 lets a row
 * state its own address), so a provider that keeps some rows can still leave a
 * record naming the ones it lost in `detail`. A drop with no surviving row is
 * what removes a provider from `list()`.
 */
export interface CatalogDrop {
  id: string;
  reason: 'unknown_api' | 'no_usable_model' | 'no_base_url' | 'no_api_key';
  detail?: string;
}

/**
 * Protocols whose pi-ai adapter refuses to build a request without a key.
 *
 * The three left out are not an oversight: `bedrock-converse-stream` and
 * `google-vertex` authenticate from ambient AWS/ADC credentials, and
 * `pi-messages` carries no key check, so for those an empty `auth.json` entry
 * is a working configuration rather than a missing one. Everything else throws
 * `No API key for provider: <id>` at the top of `streamSimple`, which is a
 * local certainty — the request cannot be attempted, let alone retried.
 */
const APIS_REQUIRING_KEY: ReadonlySet<CatalogApi> = new Set<CatalogApi>([
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations',
]);

/**
 * Headers pi-ai accepts INSTEAD of an api key (`getClientApiKey` /
 * `assertRequestAuth`). A provider that presents one of these is configured,
 * even with no entry in `auth.json`.
 */
const AUTH_HEADER_NAMES: readonly string[] = ['authorization', 'x-api-key', 'cf-aig-authorization'];

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
  const auth = await readOptionalJsonFile(join(dir, AUTH_FILE_NAME), 'auth_json', io);
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
    const baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl : '';
    const headers = expandHeaders(provider.headers, env);
    const apiKey = readProviderKey(auth, id);
    // A key is a key wherever it comes from: an admin-configured `Authorization`
    // header is what pi-ai checks when `apiKey` is empty, so a provider that
    // carries one is configured.
    const credentialled =
      apiKey !== '' ||
      Object.keys(headers).some((name) => AUTH_HEADER_NAMES.includes(name.toLowerCase()));
    const usable: CatalogModel[] = [];
    const unaddressed: string[] = [];
    const unauthenticated: string[] = [];
    for (const model of parsedModels) {
      // Both checks are local certainties, which is the whole reason to make
      // them here. An empty address does NOT fail at request time — the OpenAI
      // and Anthropic SDKs fall back to their vendor's public endpoint, so this
      // row would quietly send an administrator's key to api.openai.com. A
      // missing key fails at the top of the adapter, before a request exists,
      // which the loop cannot tell from a transient fault and so retries for
      // 43 seconds.
      if ((model.baseUrl ?? baseUrl) === '') unaddressed.push(model.id);
      else if (!credentialled && APIS_REQUIRING_KEY.has(model.api)) unauthenticated.push(model.id);
      else usable.push(model);
    }
    if (unaddressed.length > 0) {
      dropped.push({ id, reason: 'no_base_url', detail: unaddressed.join(', ') });
    }
    if (unauthenticated.length > 0) {
      dropped.push({ id, reason: 'no_api_key', detail: unauthenticated.join(', ') });
    }
    if (usable.length === 0) continue;
    providers.push({
      id,
      baseUrl,
      headers,
      api,
      compat: asRecord(provider.compat) ?? undefined,
      models: usable,
      apiKey,
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
 * need no key, and only its protocol knows whether that is true — which is what
 * {@link APIS_REQUIRING_KEY} decides for it above. A key that is present and
 * REJECTED is still a request-time matter, where the provider's own message
 * says which credential it refused.
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
  return parseJsonRecord(text, path, code);
}

/**
 * Absent is a state; unreadable is a fault.
 *
 * `auth.json` legitimately does not exist before the first sync, so ENOENT
 * yields `null` and every provider reports an empty key. A file that IS there
 * and cannot be parsed is a different thing entirely, and swallowing it used to
 * produce the exact symptom of a key that never synced: every provider keyless,
 * with nothing anywhere naming the file. It now fails the way `models.json`
 * already did, naming the path and the parser's complaint.
 */
async function readOptionalJsonFile(
  path: string,
  code: string,
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
  return parseJsonRecord(text, path, code);
}

function parseJsonRecord(text: string, path: string, code: string): Record<string, unknown> {
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
