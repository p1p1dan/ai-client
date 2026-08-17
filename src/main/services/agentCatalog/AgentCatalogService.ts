/**
 * D48 S2 §4.1 — the model catalog service. Main-side, credential-bearing, pure
 * module with every capability injected (the `electron` half lives in
 * `./index.ts`, the same split `CredentialVault` / `AuthProbeScheduler` use).
 *
 * ## Why the catalog is queried HERE and not in the Agent Host
 *
 * Credentials live in exactly one process. The vault is Main's
 * (`CredentialVault.ts`), and the agent-host child gets ONE key
 * (`AICLIENT_CODEX_API_KEY`) and NO base URL at all [实测 `hostEnv.ts` — all
 * eight keys enumerated]. Moving the query into the Host would mean widening
 * that env surface with a second credential and two gateway URLs, which is the
 * opposite direction from D47's "credential authority converges on app". So the
 * shape is copied from `UsageService.getStats()`: resolve the vault in Main,
 * `net.fetch` from Main, hand the renderer a payload that carries neither key nor
 * URL (§0.1-2).
 *
 * ## The four-level fallback, and why `source` is product state
 *
 *   fresh proxy answer → process-memory stale cache → built-in seed table →
 *   (caller) `Automatic` + Retry
 *
 * Each rung is reported, never smoothed over. A seed result is tagged
 * `source:'seed'` so the UI says the catalog is unreachable; a stale result says
 * `stale:true`. The failure this prevents is a menu that looks live while listing
 * yesterday's models — the user picks one, and the gateway refuses a model we
 * told them was available (arbitration §2.2 ∧ B-track U2).
 *
 * ## Vault locked is a narrow exit, not an error
 *
 * `safeStorage` is not unlocked until after the first window exists (E6), so an
 * early call can find the vault `locked`. That is NOT an exception and NOT a
 * spinner: it returns the seed table with `error:'credentials-unavailable'` and
 * makes ZERO network calls. Throwing here would take the whole model selector
 * down for the length of the keyring prompt.
 *
 * ## What is deliberately NOT here
 *
 * No vault generation counter and no invalidation channel. The vault has neither
 * an event nor a generation today, and `UsageService` likewise re-resolves on
 * every call — the cache key carries a NON-REVERSIBLE DIGEST of the resolved
 * secret instead, so a rotated credential simply fails to match its old entry
 * (§4.1). The digest exists only as a map key inside this process: it is never
 * logged and never leaves Main.
 */

import { createHash } from 'node:crypto';
import { filterAgentModelCatalog } from '@shared/models/familyWhitelist';
import { seedModelsFor } from '@shared/models/seedCatalog';
import type {
  AgentModelCatalog,
  AgentModelCatalogError,
  AgentModelOption,
} from '@shared/types/agentCatalog';
import { type AgentWireName, CODEX_AGENT } from '@shared/types/agentWire';

/** Default freshness window for a proxy answer (§4.1). */
export const AGENT_CATALOG_TTL_MS = 10 * 60 * 1000;

/** Request deadline. A model menu that hangs is worse than one that falls back. */
export const AGENT_CATALOG_TIMEOUT_MS = 8000;

export interface AgentCatalogFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type AgentCatalogFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<AgentCatalogFetchResponse>;

/** The two vault rows this service reads, and nothing else from the payload. */
export interface AgentCatalogVaultSnapshot {
  claude: { baseUrl: string; authToken: string };
  codex: { baseUrl: string; apiKey: string };
}

export type AgentCatalogCredentials =
  | { status: 'ok'; vault: AgentCatalogVaultSnapshot }
  | { status: 'unavailable' };

export interface AgentCatalogServiceOptions {
  fetchFn: AgentCatalogFetch;
  /** Re-resolved on EVERY call, exactly like `UsageService` — never cached. */
  readCredentials: () => AgentCatalogCredentials;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  /** Non-reversible; defaults to the first 8 bytes of a sha256, hex. */
  digest?: (secret: string) => string;
  log?: (...args: unknown[]) => void;
}

/**
 * Which vault field becomes which auth header — the one mapping that must be
 * copied rather than guessed.
 *
 * `claude.authToken` is a D47 name from the `ANTHROPIC_AUTH_TOKEN` lineage and
 * does NOT mean "bearer": the Claude axis authenticates with `x-api-key`
 * [实测 04-cch-live-probe §1]. The Codex axis is the Bearer one. Reading the
 * field name as a protocol hint gets both axes exactly wrong, which is why the
 * table is explicit and why B4 pins field → header rather than header alone.
 */
interface AgentRequestRule {
  baseUrlOf: (vault: AgentCatalogVaultSnapshot) => string;
  secretOf: (vault: AgentCatalogVaultSnapshot) => string;
  authHeader: (secret: string) => Record<string, string>;
}

const CLAUDE_REQUEST_RULE: AgentRequestRule = {
  baseUrlOf: (vault) => vault.claude.baseUrl,
  secretOf: (vault) => vault.claude.authToken,
  authHeader: (secret) => ({ 'x-api-key': secret }),
};

const CODEX_REQUEST_RULE: AgentRequestRule = {
  baseUrlOf: (vault) => vault.codex.baseUrl,
  secretOf: (vault) => vault.codex.apiKey,
  authHeader: (secret) => ({ Authorization: `Bearer ${secret}` }),
};

/**
 * Two named rules and a selector rather than one keyed record: a record literal
 * would have to respell the binding literal, which `agentWireStatic.test.ts`
 * bans outside `agentWire.ts` (see `shared/models/seedCatalog.ts` for the same
 * shape and the same reason).
 */
function requestRuleFor(agent: AgentWireName): AgentRequestRule {
  return agent === CODEX_AGENT ? CODEX_REQUEST_RULE : CLAUDE_REQUEST_RULE;
}

/**
 * `<base>` → `<base>/v1/models`, without ever producing `/v1/v1/models`.
 *
 * The vault stores an ALREADY `/v1`-suffixed base on both axes
 * (`OnboardingService.buildApiBaseUrl` falls back to `${server}/v1`), but the
 * gateway is free to hand back a base without it, so both are accepted.
 */
export function resolveModelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

/** Host only — never the path, never any userinfo the URL might carry. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'invalid-base-url';
  }
}

/**
 * `{data:[{id}]}` on both axes [实测 04 §1: Anthropic list and OpenAI list agree
 * on this much]. Anything else is `null`, i.e. `invalid-response` — never a
 * partial read, because half a catalog is indistinguishable from a gateway that
 * dropped our models.
 */
export function parseModelListResponse(body: string): string[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id === 'string' && id.trim().length > 0) ids.push(id.trim());
  }
  return ids;
}

interface CacheEntry {
  models: AgentModelOption[];
  fetchedAt: number;
}

interface FetchOutcome {
  ok: boolean;
  models?: AgentModelOption[];
  error?: AgentModelCatalogError;
}

function defaultDigest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

export class AgentCatalogService {
  private readonly fetchFn: AgentCatalogFetch;
  private readonly readCredentials: () => AgentCatalogCredentials;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly digest: (secret: string) => string;
  private readonly log: (...args: unknown[]) => void;

  private readonly cache = new Map<string, CacheEntry>();
  /** One in-flight request per cache key — three concurrent menus are ONE fetch. */
  private readonly inflight = new Map<string, Promise<FetchOutcome>>();

  constructor(options: AgentCatalogServiceOptions) {
    this.fetchFn = options.fetchFn;
    this.readCredentials = options.readCredentials;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? AGENT_CATALOG_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? AGENT_CATALOG_TIMEOUT_MS;
    this.digest = options.digest ?? defaultDigest;
    this.log = options.log ?? (() => {});
  }

  async list(input: { agent: AgentWireName; force?: boolean }): Promise<AgentModelCatalog> {
    const { agent } = input;
    const credentials = this.readCredentials();
    if (credentials.status !== 'ok') {
      // A narrow exit, not an error: no network call, no throw, no spinner.
      return this.seedResult(agent, 'credentials-unavailable');
    }

    const rule = requestRuleFor(agent);
    const baseUrl = rule.baseUrlOf(credentials.vault).trim();
    const secret = rule.secretOf(credentials.vault).trim();
    if (baseUrl.length === 0 || secret.length === 0) {
      return this.seedResult(agent, 'credentials-unavailable');
    }

    const host = hostOf(baseUrl);
    const key = `${agent}|${host}|${this.digest(secret)}`;
    // A rotated credential does not just miss its old entry — it retires it, so
    // a pre-rotation catalog can never come back as a "stale" answer later.
    this.pruneSupersededKeys(agent, host, key);

    const cached = this.cache.get(key);
    if (cached && !input.force && this.now() - cached.fetchedAt < this.ttlMs) {
      return this.freshResult(agent, cached);
    }

    const outcome = await this.fetchOnce(key, agent, baseUrl, secret, host);
    if (outcome.ok && outcome.models) {
      const entry: CacheEntry = { models: outcome.models, fetchedAt: this.now() };
      this.cache.set(key, entry);
      return this.freshResult(agent, entry);
    }

    // Failure never touches the cache: not the models, not `fetchedAt`. An
    // update here would let a 500 renew the freshness of an answer it never got.
    const survivor = this.cache.get(key);
    if (survivor) {
      return {
        agent,
        models: survivor.models.map((option) => ({ ...option })),
        source: 'stale-cache',
        stale: true,
        fetchedAt: survivor.fetchedAt,
        error: outcome.error,
      };
    }
    return this.seedResult(agent, outcome.error);
  }

  private fetchOnce(
    key: string,
    agent: AgentWireName,
    baseUrl: string,
    secret: string,
    host: string
  ): Promise<FetchOutcome> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const started = this.now();
    const rule = requestRuleFor(agent);
    const url = resolveModelsUrl(baseUrl);
    const run = (async (): Promise<FetchOutcome> => {
      try {
        const response = await this.fetchFn(url, {
          method: 'GET',
          headers: { Accept: 'application/json', ...rule.authHeader(secret) },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = await response.text();
        if (!response.ok) {
          // Status and host only. The body of a failed auth call routinely
          // echoes the key back.
          this.log('[agent-catalog] request failed', {
            agent,
            host,
            status: response.status,
            durationMs: this.now() - started,
          });
          return { ok: false, error: 'http' };
        }
        const ids = parseModelListResponse(body);
        if (ids === null || ids.length === 0) {
          this.log('[agent-catalog] unusable response', {
            agent,
            host,
            status: response.status,
            durationMs: this.now() - started,
          });
          return { ok: false, error: 'invalid-response' };
        }
        const models = filterAgentModelCatalog(agent, ids);
        this.log('[agent-catalog] catalog fetched', {
          agent,
          host,
          status: response.status,
          received: ids.length,
          listed: models.length,
          durationMs: this.now() - started,
        });
        return { ok: true, models };
      } catch (error) {
        // The message can carry the URL; the URL can carry userinfo. Only the
        // error's constructor name is logged.
        this.log('[agent-catalog] request threw', {
          agent,
          host,
          error: error instanceof Error ? error.name : 'unknown',
          durationMs: this.now() - started,
        });
        return { ok: false, error: 'http' };
      }
    })();

    this.inflight.set(key, run);
    return run.finally(() => {
      this.inflight.delete(key);
    });
  }

  private pruneSupersededKeys(agent: AgentWireName, host: string, key: string): void {
    const prefix = `${agent}|${host}|`;
    for (const existing of this.cache.keys()) {
      if (existing !== key && existing.startsWith(prefix)) this.cache.delete(existing);
    }
  }

  private freshResult(agent: AgentWireName, entry: CacheEntry): AgentModelCatalog {
    return {
      agent,
      models: entry.models.map((option) => ({ ...option })),
      source: 'proxy',
      stale: false,
      fetchedAt: entry.fetchedAt,
    };
  }

  private seedResult(agent: AgentWireName, error?: AgentModelCatalogError): AgentModelCatalog {
    return {
      agent,
      models: seedModelsFor(agent),
      source: 'seed',
      stale: true,
      fetchedAt: null,
      ...(error ? { error } : {}),
    };
  }
}
