/**
 * D48 S2 §4.1/§4.3-5 — the renderer half of the model catalog: when to ask, and
 * what to SAY about the answer.
 *
 * Main owns the four-level fallback (fresh → stale cache → seed table →
 * `Automatic` + Retry) and hands back a record tagged with where its contents
 * came from. This module turns that tag into product copy, and decides whether a
 * request should be made at all. Both are decisions, so both live here rather
 * than inline in the hook — the vitest config is `environment: 'node'` with
 * `include: *.test.ts`, so a decision made inside a React hook has no automated
 * coverage of any kind.
 *
 * ## `source` is not a diagnostic
 *
 * `source:'seed'` means the gateway could not be reached AT ALL and the six ids
 * on screen are the ones this build shipped with. Rendering that as an ordinary
 * menu is how a user picks a model the gateway no longer routes and gets a
 * failure with no explanation — so it MUST carry visible copy (仲裁 §2.2 ∧ B
 * 「不得伪装可用目录」). `source:'proxy'` with an EMPTY list is the opposite
 * case and must NOT be dressed up as an error: the gateway answered, and after
 * family filtering nothing is on the product surface. The honest UI for that is
 * `Automatic` plus a Retry, which is exactly the fourth fallback rung.
 *
 * ## Why `host-not-ready` is produced here and never by Main
 *
 * Main has no view of Host state, and the Host has no credentials — asking for a
 * catalog before the Host is up is a question the renderer can answer by itself.
 * The value is in `AgentModelCatalogError` so both halves speak one vocabulary
 * (`shared/types/agentCatalog.ts` says the same thing from the other side).
 */

import type {
  AgentModelCatalog,
  AgentModelCatalogError,
  AgentModelOption,
} from '@shared/types/agentCatalog';
import type { AgentWireName } from '@shared/types/agentWire';
import type { HostStatus } from './hostStatus';

/** Shown whenever the models on screen are the built-in table (§4.1). */
export const SEED_CATALOG_NOTICE = 'Model catalog unreachable — showing built-in models';

/** Shown when the last refresh failed but a real earlier answer is still on screen. */
export const STALE_CATALOG_NOTICE = 'Model catalog is out of date — showing the last known list';

/** Shown while the Host is not up yet; no request has been made. */
export const HOST_NOT_READY_CATALOG_NOTICE = 'Waiting for Agent Host to become ready';

/** Shown for the fourth fallback rung: the gateway answered, and nothing qualified. */
export const EMPTY_CATALOG_NOTICE = 'No models offered for this agent — Automatic will be used';

/** Shown while a refresh is in flight over an existing list. */
export const REFRESHING_CATALOG_NOTICE = 'Refreshing…';

/** The catalog cache TTL the renderer refreshes against; Main enforces its own (§4.1). */
export const CATALOG_REFRESH_TTL_MS = 10 * 60 * 1000;

/**
 * The renderer-produced arm of the error union.
 *
 * A real record rather than `null` so every consumer has one shape to read: the
 * menu still renders (`Automatic` + whatever it was already showing), and the
 * status row can explain itself, without a second "catalog is missing" branch.
 */
const hostNotReadyByAgent = new Map<AgentWireName, AgentModelCatalog>();

export function hostNotReadyCatalog(agent: AgentWireName): AgentModelCatalog {
  // One instance per agent, for the same referential-stability reason as
  // `NO_MODELS` below: this value is produced on every render of the pre-ready
  // window, and a fresh object each time churns every downstream memo.
  const cached = hostNotReadyByAgent.get(agent);
  if (cached) return cached;
  const created: AgentModelCatalog = Object.freeze({
    agent,
    models: [],
    source: 'seed',
    stale: true,
    fetchedAt: null,
    error: 'host-not-ready',
  });
  hostNotReadyByAgent.set(agent, created);
  return created;
}

/**
 * Whether to ask Main for this agent's catalog right now.
 *
 * Lazy, per §4.1's "何时查": only once the Host is ready and only when there is
 * nothing fresh in hand. Requesting during startup turns "not signed in yet" into
 * "this agent has no models", which then has to be un-cached.
 */
export function shouldRequestCatalog(input: {
  hostState: HostStatus['state'];
  cached: AgentModelCatalog | null;
  inFlight: boolean;
  force: boolean;
  now: number;
  ttlMs?: number;
}): boolean {
  if (input.hostState !== 'ready') return false;
  if (input.inFlight) return false;
  if (input.force) return true;
  const cached = input.cached;
  if (!cached) return true;
  // Proxy, managed and local are authoritative answers. Seed/stale records are
  // failures and should be retried immediately once the Host is available.
  if (!['proxy', 'managed', 'local'].includes(cached.source)) return true;
  if (cached.fetchedAt === null) return true;
  return input.now - cached.fetchedAt >= (input.ttlMs ?? CATALOG_REFRESH_TTL_MS);
}

export interface CatalogStatusRow {
  /** The sentence to render, or null when the catalog needs no explanation. */
  message: string | null;
  /** Whether a Retry/Refresh control belongs next to it. */
  retryable: boolean;
  /** Machine-readable reason, for assertions and for `title` copy. */
  reason: AgentModelCatalogError | 'seed' | 'stale-cache' | 'empty' | 'refreshing' | null;
}

/**
 * The non-radio status row under the two menu sections (§4.3-5).
 *
 * Ordered by how much the user needs to know, not by how the record is shaped:
 * an unreachable catalog outranks a refresh in flight, because the models on
 * screen being fabricated matters more than them being a minute old.
 */
export function catalogStatusRow(input: {
  catalog: AgentModelCatalog | null;
  loading: boolean;
}): CatalogStatusRow {
  const { catalog, loading } = input;
  if (!catalog) {
    return loading
      ? { message: REFRESHING_CATALOG_NOTICE, retryable: false, reason: 'refreshing' }
      : { message: null, retryable: false, reason: null };
  }
  if (catalog.error === 'host-not-ready') {
    return { message: HOST_NOT_READY_CATALOG_NOTICE, retryable: false, reason: 'host-not-ready' };
  }
  if (catalog.source === 'seed') {
    return { message: SEED_CATALOG_NOTICE, retryable: true, reason: 'seed' };
  }
  if (catalog.source === 'stale-cache') {
    return { message: STALE_CATALOG_NOTICE, retryable: true, reason: 'stale-cache' };
  }
  if (catalog.models.length === 0) {
    // `source:'proxy'` and empty: the honest fourth rung. NOT an error row —
    // the gateway answered, so a red "failed" message would be a lie, and the
    // Retry is offered because the answer can change.
    return { message: EMPTY_CATALOG_NOTICE, retryable: true, reason: 'empty' };
  }
  if (loading) {
    return { message: REFRESHING_CATALOG_NOTICE, retryable: false, reason: 'refreshing' };
  }
  return { message: null, retryable: false, reason: null };
}

/**
 * One frozen empty list, so "no catalog yet" is REFERENTIALLY stable.
 *
 * A fresh `[]` per call would make the trigger's reconciliation effect re-run on
 * every render for the entire pre-catalog window — harmless in output (the
 * reconcile keeps the current value and React bails on an identical setState)
 * and wasteful on every keystroke.
 */
const NO_MODELS: readonly AgentModelOption[] = Object.freeze([]);

/** The models to offer. `null` (nothing fetched yet) is an empty catalog, never a throw. */
export function catalogModels(catalog: AgentModelCatalog | null): readonly AgentModelOption[] {
  return catalog?.models ?? NO_MODELS;
}

/**
 * Whether a catalog answer has arrived for this agent.
 *
 * Gates `reconcileModelSelection`'s rewrite arm (B17): before this is true the
 * displayed selection is kept exactly as-is, because "we have not asked yet" and
 * "the catalog does not contain it" are not the same fact.
 */
export function isCatalogLoaded(catalog: AgentModelCatalog | null): boolean {
  return catalog !== null && catalog.error !== 'host-not-ready';
}
