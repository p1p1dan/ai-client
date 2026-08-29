/**
 * D48 S2 §4.1/§4.2 — the built-in fallback catalog: the third rung of the
 * four-level fallback (fresh → stale cache → SEED → `Automatic` + Retry).
 *
 * ## Provenance
 *
 * Collected 2026-08-16 by running the family whitelist (`familyWhitelist.ts`)
 * over a live `GET /v1/models` from the cch gateway on both axes — 15 Claude ids
 * and 10 Codex ids in, six out [实测 `docs/plans/2026-08-16-agent-picker-
 * investigation/04-cch-live-probe.md` §1]. The filter is not re-run at build
 * time: this is a snapshot of what it produced on that date, pinned so that a
 * regression in the filter cannot silently rewrite the fallback too.
 *
 * ## This is a floor, not a source of truth
 *
 * These six ids are what the app offers when it cannot reach the gateway AT ALL.
 * They are NOT a claim about what the gateway serves today, and a result built
 * from them is always tagged `source:'seed'` so the UI can say the catalog is
 * unreachable. Rendering a seed result as an ordinary catalog is the exact
 * failure mode the `source` discriminant exists to prevent (§4.1), because a
 * stale menu that looks live is how a user picks a model that no longer routes.
 *
 * The order matches `filterAgentModelCatalog`'s deterministic order, and a test
 * asserts the round trip (filtering the seed ids returns the seed list unchanged)
 * — which is what keeps this table honest as the rules evolve.
 */

import type { AgentModelOption } from '../types/agentCatalog';
import { type AgentWireName, CODEX_AGENT, PI_AGENT } from '../types/agentWire';

/** The date the ids below were read off the gateway. Part of the provenance, not decoration. */
export const SEED_CATALOG_CAPTURED_AT = '2026-08-16';

/**
 * Two named arrays and a selector, rather than one `Record<AgentWireName, …>`.
 *
 * A record literal has to spell its keys, and `agentWireStatic.test.ts` bans a
 * second spelling of the binding literal anywhere outside `agentWire.ts` — the
 * binding is persisted, so a second copy is a value that can drift on disk. A
 * computed key (`[CLAUDE_CODE_AGENT]:`) does not compile into a `Record` either,
 * because the constant is typed as the whole union rather than as its own
 * literal. Two arrays cost nothing and keep both properties.
 *
 * Adding a third agent lands here as a missing branch below, and the
 * `AGENT_WIRE_NAMES is exactly the persisted list` pin goes red at the same time,
 * which is the review moment.
 */
export const CLAUDE_SEED_MODELS: readonly AgentModelOption[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

export const CODEX_SEED_MODELS: readonly AgentModelOption[] = [
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
];

export const PI_SEED_MODELS: readonly AgentModelOption[] = [
  { id: 'pilab/gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'pilab/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'pilab/gpt-5.6-terra', label: 'GPT-5.6 Terra' },
];

export function seedCatalogFor(agent: AgentWireName): readonly AgentModelOption[] {
  if (agent === PI_AGENT) return PI_SEED_MODELS;
  return agent === CODEX_AGENT ? CODEX_SEED_MODELS : CLAUDE_SEED_MODELS;
}

/** A fresh mutable copy — callers hand these straight to the IPC payload. */
export function seedModelsFor(agent: AgentWireName): AgentModelOption[] {
  return seedCatalogFor(agent).map((option) => ({ ...option }));
}
