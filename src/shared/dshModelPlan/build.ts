// New in dsh-rebase P1-5a
/**
 * `buildDshModelPlan`: the in-memory catalog's `models.json` half, translated
 * into `llm-pi-ai` routes by the eleven rules of design shard 03 §2 (R1-R11).
 *
 * Pure and deterministic: same input, same plan, same revision. It never sees
 * a key — only whether each provider has one — so nothing it returns can leak
 * one.
 */

import { createHash } from 'node:crypto';
import { resolveCacheControlOnTools } from '../types/cacheControlOnTools.ts';
import { resolveRequestUserAgent, USER_AGENT_RELAY_HEADER } from '../types/requestUserAgent.ts';
import { dshRouteSettings } from './settings.ts';
import {
  CLIENT_IDENTITY_HEADER,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DSH_EFFORT_LEVELS,
  DSH_OFFERED_COMPAT,
  DSH_PROTOCOLS,
  EMPTY_PLAN_DEFAULT_MODEL,
  IMPLIED_EFFORT_LEVELS,
  KEY_REF_PREFIX,
  MAX_TOKENS_WINDOW_SHARE_FALLBACK,
  MAX_TOKENS_WINDOW_SHARE_LIMIT,
} from './tables.ts';
import type {
  DshEffortLevel,
  DshFieldDropReason,
  DshModelPlan,
  DshModelPlanInput,
  DshPlanDrop,
  DshPlanIndexEntry,
  DshPlanModel,
  DshPlanRoute,
  DshProtocol,
} from './types.ts';

/**
 * Header names a provider may not state. DSH owns User-Agent and deletes a
 * profile value anyway (D5); ours travels in the relay header (decision 171),
 * so a provider's own relay header would be taken for the app's choice.
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'user-agent',
  USER_AGENT_RELAY_HEADER.toLowerCase(),
]);

/**
 * Substrings that make a header name look like it carries a credential. Such
 * a header would sit in the host's config unredacted, so the provider is
 * refused outright rather than half-served (R5).
 */
const CREDENTIAL_HEADER_HINTS: readonly string[] = [
  'auth',
  'token',
  'secret',
  'password',
  'passwd',
  'cookie',
  'credential',
  'api-key',
  'api_key',
  'apikey',
];

/** RFC 9110 token; what `new Headers()` accepts as a name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A single-line ByteString; what `new Headers()` accepts as a value. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

type RawRecord = Record<string, unknown>;

interface AcceptedModel {
  id: string;
  raw: RawRecord;
  group: number;
}

interface RouteGroup {
  api: DshProtocol;
  baseURL: string;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isProtocol(value: unknown): value is DshProtocol {
  return typeof value === 'string' && (DSH_PROTOCOLS as readonly string[]).includes(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Keys sorted at every depth, `undefined` members left out. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * R4: the reference name a provider's routes carry. Derived from the provider
 * id alone, so it survives revisions; the hash keeps `a.b` and `a-b` apart.
 */
export function keyRefFor(providerId: string): string {
  const slug = providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `${KEY_REF_PREFIX}${slug}_${sha256Hex(providerId).slice(0, 4).toUpperCase()}`;
}

export function isCredentialHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return CREDENTIAL_HEADER_HINTS.some((hint) => lower.includes(hint));
}

/**
 * R8: our `thinkingLevelMap` in DSH's `reasoningEfforts` spelling.
 *
 * Ours: `null` = unsupported, unmentioned low/medium/high = supported.
 * DSH: unmentioned = unsupported, and `off` with no value = "supported, send
 * nothing". So `null` is never written (not even for `off`), the implied three
 * are written by name, and a map left with nothing beyond `off` is a
 * non-reasoning model.
 */
export function translateReasoningEfforts(
  reasoning: unknown,
  thinkingLevelMap: unknown
): DshPlanModel['reasoningEfforts'] {
  if (reasoning !== true) return false;
  const map = isRecord(thinkingLevelMap) ? thinkingLevelMap : {};
  const out: Partial<Record<DshEffortLevel, string>> = {};
  for (const level of DSH_EFFORT_LEVELS) {
    const wire = map[level];
    if (typeof wire === 'string') {
      // DSH refuses an empty wire value; ours never meant anything by one.
      if (wire.length > 0) out[level] = wire;
    } else if (wire !== null && IMPLIED_EFFORT_LEVELS.has(level)) {
      out[level] = level;
    }
  }
  return Object.keys(out).some((level) => level !== 'off') ? out : false;
}

/** R10: DSH's `getSupportedThinkingLevels` over the translated declaration. */
export function effortsOf(reasoningEfforts: DshPlanModel['reasoningEfforts']): DshEffortLevel[] {
  if (reasoningEfforts === false) return [];
  return DSH_EFFORT_LEVELS.filter((level) => reasoningEfforts[level] !== undefined);
}

export function buildDshModelPlan(input: DshModelPlanInput): DshModelPlan {
  const env = input.env ?? {};
  const settings = dshRouteSettings(input.settings);
  const cacheControlOnTools = resolveCacheControlOnTools(input.settings?.cacheControlOnTools);
  const drops: DshPlanDrop[] = [];
  // Decision 171: one User-Agent for every route, relayed past DSH's own.
  const userAgent = resolveRequestUserAgent(
    { mode: input.settings?.userAgentMode, custom: input.settings?.userAgentCustom },
    input.clientVersion ?? ''
  );
  if (userAgent.problem) {
    drops.push({
      kind: 'setting',
      setting: 'userAgent',
      reason: 'invalid_user_agent',
      detail: userAgent.problem,
    });
  }
  const fieldDropKeys = new Set<string>();
  const dropField = (
    providerId: string,
    modelId: string | undefined,
    field: string,
    reason: DshFieldDropReason,
    detail?: string
  ) => {
    const key = [providerId, modelId ?? '', field, reason].join('\0');
    if (fieldDropKeys.has(key)) return;
    fieldDropKeys.add(key);
    drops.push({
      kind: 'field',
      providerId,
      ...(modelId ? { modelId } : {}),
      field,
      reason,
      ...(detail ? { detail } : {}),
    });
  };

  /** R6: only the keys this protocol offers; the model stays either way. */
  const offeredCompat = (
    compat: unknown,
    api: DshProtocol,
    providerId: string,
    modelId?: string
  ): RawRecord | undefined => {
    if (!isRecord(compat)) return undefined;
    const offered = DSH_OFFERED_COMPAT[api];
    const out: RawRecord = {};
    for (const [field, value] of Object.entries(compat)) {
      if (!offered.includes(field)) {
        dropField(providerId, modelId, `compat.${field}`, 'compat_not_offered');
      } else if (value === null || value === undefined) {
        dropField(providerId, modelId, `compat.${field}`, 'compat_unset');
      } else {
        out[field] = value;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  /**
   * GW-16 temporary switch (decisions 149 rule 19, 159). Off (the default):
   * every anthropic-messages route says `supportsCacheControlOnTools: false`,
   * so pi-ai leaves the last tool unmarked and a request carries two
   * breakpoints at most. A row that declares the field itself is set to
   * `false` too, because DSH's compat merge lets the row win over the route.
   * On: models.json is followed as it stands (three breakpoints).
   */
  const cacheControlCompat = (
    compat: RawRecord | undefined,
    api: DshProtocol,
    level: 'route' | 'row'
  ): RawRecord | undefined => {
    if (cacheControlOnTools || api !== 'anthropic-messages') return compat;
    if (level === 'row' && compat?.supportsCacheControlOnTools === undefined) return compat;
    return { ...compat, supportsCacheControlOnTools: false };
  };

  /** R5: expanded like the native runtime; the reserved names and dead references go. */
  const routeHeaders = (raw: RawRecord, providerId: string): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value !== 'string') {
        dropField(providerId, undefined, `headers.${name}`, 'invalid_header');
        continue;
      }
      if (RESERVED_HEADERS.has(name.toLowerCase())) {
        dropField(providerId, undefined, `headers.${name}`, 'reserved_header');
        continue;
      }
      // A `$NAME` that resolves to nothing is dropped, not sent empty (native rule).
      const resolved = value.startsWith('$') ? (env[value.slice(1)]?.trim() ?? '') : value;
      if (value.startsWith('$') && resolved === '') {
        dropField(providerId, undefined, `headers.${name}`, 'unresolved_header');
        continue;
      }
      if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(resolved)) {
        dropField(providerId, undefined, `headers.${name}`, 'invalid_header');
        continue;
      }
      out[name] = resolved;
    }
    // Decision 037: our own identity header, over any provider header of that name.
    const version = input.clientVersion?.trim();
    if (version && HEADER_VALUE.test(version)) {
      for (const name of Object.keys(out)) {
        if (name.toLowerCase() === CLIENT_IDENTITY_HEADER.toLowerCase()) delete out[name];
      }
      out[CLIENT_IDENTITY_HEADER] = version;
    }
    // Decision 171: what the host's fetch wrapper sends as User-Agent in place
    // of DSH's own. None in `engine` mode: DSH's own goes out.
    if (userAgent.userAgent !== undefined) out[USER_AGENT_RELAY_HEADER] = userAgent.userAgent;
    return Object.keys(out).length > 0 ? out : undefined;
  };

  /**
   * Decision 141: this row's effective `compat.forceAdaptiveThinking`, if any
   * layer set it.
   *
   * A row's own switch wins field by field over the provider's, mirroring
   * `dsh-llm-pi-ai`'s own route/model compat merge (`resolveModelCompat`) — a
   * route declaring it once for every model under it (the shipped `claude`
   * provider) must still take effect per model. `declared` is true whenever
   * either layer named the field at all, even as `false`: a row that opted out
   * on purpose is not the undeclared case the advisory below warns about.
   */
  const adaptiveThinkingCompat = (
    api: DshProtocol,
    rowCompat: unknown,
    providerCompat: unknown
  ): { declared: boolean; forced: boolean } => {
    if (api !== 'anthropic-messages') return { declared: false, forced: false };
    const rowValue = isRecord(rowCompat) ? rowCompat.forceAdaptiveThinking : undefined;
    if (rowValue !== undefined) return { declared: true, forced: rowValue === true };
    const providerValue = isRecord(providerCompat)
      ? providerCompat.forceAdaptiveThinking
      : undefined;
    if (providerValue !== undefined) return { declared: true, forced: providerValue === true };
    return { declared: false, forced: false };
  };

  /**
   * Decision 146 (GW-4): the reply reservation the plan hands DSH for a row.
   *
   * DSH's automatic compaction budgets a conversation as the row's
   * `contextWindow` minus its `maxTokens` minus a fixed headroom
   * (`dsh-compaction-basic` `resolveCompactSpec`); a catalog that wrote the
   * window into `maxTokens` too (Grok 4.7: 500000 / 500000, and many rows of
   * pi-ai's own catalog) leaves it nothing, so compaction refuses to run and
   * a long chat eventually overflows. A reservation over half the window is
   * read as that mistake, not as a real output cap, and replaced by a quarter
   * of the window — the share DSH reserves on its own reference route
   * (DeepSeek: 256k of 1M). Only rows that declare both numbers are judged;
   * the user's models.json is not touched.
   */
  const plannedMaxTokens = (
    providerId: string,
    id: string,
    contextWindow: number | undefined,
    maxTokens: number | undefined
  ): number | undefined => {
    if (maxTokens === undefined || contextWindow === undefined) return maxTokens;
    if (maxTokens <= Math.floor(contextWindow * MAX_TOKENS_WINDOW_SHARE_LIMIT)) return maxTokens;
    const clamped = Math.max(1, Math.floor(contextWindow * MAX_TOKENS_WINDOW_SHARE_FALLBACK));
    dropField(providerId, id, 'maxTokens', 'max_tokens_clamped', `${maxTokens} -> ${clamped}`);
    return clamped;
  };

  /** R7 / R8 for one row. */
  const planModel = (
    model: AcceptedModel,
    api: DshProtocol,
    providerId: string,
    providerCompat: unknown
  ): DshPlanModel => {
    const { raw, id } = model;
    const name = nonEmptyString(raw.name);
    const contextWindow = positiveInteger(raw.contextWindow);
    const maxTokens = plannedMaxTokens(
      providerId,
      id,
      contextWindow,
      positiveInteger(raw.maxTokens)
    );
    const input = Array.isArray(raw.input)
      ? [
          ...new Set(
            raw.input.filter(
              (kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image'
            )
          ),
        ]
      : [];
    const compat = cacheControlCompat(offeredCompat(raw.compat, api, providerId, id), api, 'row');
    if (raw.samplingParams !== undefined) {
      dropField(providerId, id, 'samplingParams', 'sampling_params');
    }
    let reasoningEfforts = translateReasoningEfforts(raw.reasoning, raw.thinkingLevelMap);
    const adaptive = adaptiveThinkingCompat(api, raw.compat, providerCompat);
    if (adaptive.forced) {
      // Decision 141: pi-ai's anthropic-messages path sends `thinking:{type:
      // "disabled"}` for any non-null `off`, which an adaptive-only model's API
      // refuses with a 400 (user report: Opus 5.5 on 1.0.4's manual compaction).
      // Adaptive thinking has no "disabled" state, so `off` is withheld no
      // matter what models.json declares for it — the row loses `off` from its
      // effort menu, never the other levels.
      if (reasoningEfforts !== false && reasoningEfforts.off !== undefined) {
        const { off: _off, ...rest } = reasoningEfforts;
        reasoningEfforts = rest;
        dropField(providerId, id, 'reasoningEfforts.off', 'adaptive_thinking_forced');
      }
    } else if (api === 'anthropic-messages' && raw.reasoning === true && !adaptive.declared) {
      // Decision 141: advisory only. A model id alone cannot tell us whether it
      // is adaptive-only, so this is a hint for whoever edits models.json next,
      // not a behavior change. A row (or its provider) that already declared
      // the switch, even as `false`, made that call on purpose.
      dropField(providerId, id, 'compat.forceAdaptiveThinking', 'adaptive_thinking_undeclared');
    }
    return {
      id,
      ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(input.length > 0 ? { input } : {}),
      reasoningEfforts,
      ...(compat ? { compat } : {}),
    };
  };

  const routes: Record<string, DshPlanRoute> = {};
  const index: Record<string, DshPlanIndexEntry> = {};
  const refs: Record<string, string> = {};
  const providers = isRecord(input.models.providers) ? input.models.providers : {};

  for (const [providerId, provider] of Object.entries(providers)) {
    // A route named `__proto__` would be assigned to the prototype, not stored.
    if (!isRecord(provider) || providerId === '__proto__') continue;
    const rows = (Array.isArray(provider.models) ? provider.models : []).flatMap((raw) => {
      const id = isRecord(raw) ? nonEmptyString(raw.id) : undefined;
      return id && isRecord(raw) ? [{ id, raw }] : [];
    });
    if (rows.length === 0) continue;

    const rawHeaders = isRecord(provider.headers) ? provider.headers : {};
    const credentialHeader = Object.keys(rawHeaders).find(isCredentialHeaderName);
    if (credentialHeader) {
      for (const row of rows) {
        drops.push({
          kind: 'model',
          providerId,
          modelId: row.id,
          reason: 'credential_header',
          detail: credentialHeader,
        });
      }
      continue;
    }

    // R1-R4, row by row, in catalog order.
    const groups: RouteGroup[] = [];
    const accepted: AcceptedModel[] = [];
    const providerBaseUrl = nonEmptyString(provider.baseUrl) ?? '';
    for (const row of rows) {
      const api = row.raw.api ?? provider.api;
      if (!isProtocol(api)) {
        drops.push({
          kind: 'model',
          providerId,
          modelId: row.id,
          reason: 'unsupported_api',
          detail: String(api),
        });
        continue;
      }
      const baseURL = nonEmptyString(row.raw.baseUrl) ?? providerBaseUrl;
      if (!baseURL) {
        drops.push({ kind: 'model', providerId, modelId: row.id, reason: 'no_base_url' });
        continue;
      }
      if (input.keyed[providerId] !== true) {
        drops.push({ kind: 'model', providerId, modelId: row.id, reason: 'no_api_key' });
        continue;
      }
      // A repeated id would make DSH reject the whole route; the first wins.
      if (accepted.some((model) => model.id === row.id)) continue;
      let group = groups.findIndex((g) => g.api === api && g.baseURL === baseURL);
      if (group < 0) group = groups.push({ api, baseURL }) - 1;
      accepted.push({ ...row, group });
    }
    if (accepted.length === 0) continue;

    const apiKeyEnv = keyRefFor(providerId);
    refs[apiKeyEnv] = providerId;
    const headers = routeHeaders(rawHeaders, providerId);
    const routeKeys = groups.map((_, i) => (i === 0 ? providerId : `${providerId}~${i + 1}`));
    groups.forEach((group, i) => {
      const compat = cacheControlCompat(
        offeredCompat(provider.compat, group.api, providerId),
        group.api,
        'route'
      );
      // Every route gets its own objects, so no two routes alias one another.
      routes[routeKeys[i] as string] = {
        api: group.api,
        baseURL: group.baseURL,
        apiKeyEnv,
        ...(headers ? { headers: { ...headers } } : {}),
        ...(compat ? { compat } : {}),
        defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
        cacheRetention: settings.cacheRetention,
        streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
        retryPolicy: {
          ...settings.retryPolicy,
          backoff: { ...settings.retryPolicy.backoff },
        },
        models: [],
      };
    });
    for (const model of accepted) {
      const group = groups[model.group] as RouteGroup;
      const route = routeKeys[model.group] as string;
      const planned = planModel(model, group.api, providerId, provider.compat);
      (routes[route] as DshPlanRoute).models.push(planned);
      index[`${providerId}/${model.id}`] = {
        route,
        model: model.id,
        efforts: effortsOf(planned.reasoningEfforts),
        image: planned.input?.includes('image') ?? false,
      };
    }
  }

  // R9: the first usable model in catalog order, or a placeholder the bridge refuses.
  const first = Object.values(index)[0];
  const defaultModel = first
    ? { provider: first.route, model: first.model }
    : { ...EMPTY_PLAN_DEFAULT_MODEL };
  return {
    revision: sha256Hex(canonicalJson({ routes, defaultModel, index })),
    routes,
    defaultModel,
    index,
    refs,
    dropped: drops,
  };
}
