/**
 * D48 S2 §4.1 — the shape the model catalog crosses the Main → Renderer border in.
 *
 * ## Why the result is a discriminated record and not a bare array
 *
 * A boolean "the catalog loaded" cannot tell "the proxy says these are the only
 * models" apart from "the network was down so this is the table we shipped with".
 * The first is authoritative and must be trusted; the second MUST be labelled
 * unreachable in the UI, because pretending a seed table is a live catalog is how
 * a user ends up selecting a model the gateway no longer serves. `source` is
 * therefore load-bearing product state, not a diagnostic garnish (§4.1).
 *
 * ## What never crosses this border
 *
 * No key, no token, no base URL, no raw response body. The catalog service runs
 * in Main against the D47 credential vault and hands the renderer nothing but
 * ids, labels and provenance (§0.1-2). Every field below is safe to log.
 */

import type { SessionEffortLevel } from './agentHost';

/** One selectable model. `label` is UI copy only and is never compared against. */
export interface AgentModelOption {
  id: string;
  label: string;
  /** Ordered cloud/config labels. The first is the sole primary menu group. */
  tags?: string[];
  /** Pi model capability metadata; absent on legacy/non-Pi catalogs. */
  reasoning?: boolean;
  /**
   * T38-b: the model's context window in tokens, as the Pi model configuration
   * declares it. Absent when the configuration does not say — which is why the
   * occupancy surfaces treat it as unknown rather than defaulting to a common
   * window size and printing a share of a number nobody stated.
   */
  contextWindow?: number;
  /**
   * Reused directly for model-level effort availability; never duplicated into
   * another table. The `| 'off' | 'minimal'` widening this used to carry is
   * gone: those two are members of `SessionEffortLevel` since U08-2.
   */
  thinkingLevelMap?: Partial<Record<SessionEffortLevel, string | null>>;
}

/**
 * Where the models in a result came from.
 *
 * - `proxy` — a live `/v1/models` answer from the gateway, family-filtered (§4.2).
 * - `stale-cache` — the last successful proxy answer for this key; the refresh
 *   that was just attempted failed. Still real data, just not current.
 * - `unavailable` — no catalog could be obtained and nothing is cached. The UI
 *   must say so; it must NOT render an empty menu as if it were an answer
 *   (arbitration §2.2 ∧ B "不得伪装可用目录"). This replaced the old `seed`
 *   rung, whose built-in table was deleted with plan D03 — a fabricated list
 *   made a failed fetch look like a successful one.
 *
 * A `managed` result with zero models is NOT this: the endpoint answered and the
 * administrator has enabled nothing, which the UI states in its own words.
 */
export type AgentModelCatalogSource = 'proxy' | 'managed' | 'local' | 'stale-cache' | 'unavailable';

/**
 * Why a result is not `proxy`.
 *
 * `host-not-ready` is produced by the RENDERER hook, which refuses to ask before
 * the Host reports ready; Main never emits it (Main has no view of Host state).
 * It lives here so both halves speak one vocabulary.
 */
export type AgentModelCatalogError =
  | 'host-not-ready'
  | 'credentials-unavailable'
  | 'http'
  | 'invalid-response';

export interface AgentModelCatalog {
  /** Ordered exactly as Pi's managed/local configuration. */
  models: AgentModelOption[];
  source: AgentModelCatalogSource;
  /** `true` for anything that is not a live proxy answer. */
  stale: boolean;
  /** When the underlying answer was fetched; `null` when there never was one. */
  fetchedAt: number | null;
  error?: AgentModelCatalogError;
}

/** Pi-only catalog request. `force` skips the TTL, never the single-flight. */
export interface ListPiModelsRequest {
  force?: boolean;
}
