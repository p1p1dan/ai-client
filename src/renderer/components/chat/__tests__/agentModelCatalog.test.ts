import { CLAUDE_SEED_MODELS, seedModelsFor } from '@shared/models/seedCatalog';
import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_REFRESH_TTL_MS,
  catalogModels,
  catalogStatusRow,
  EMPTY_CATALOG_NOTICE,
  HOST_NOT_READY_CATALOG_NOTICE,
  hostNotReadyCatalog,
  isCatalogLoaded,
  REFRESHING_CATALOG_NOTICE,
  SEED_CATALOG_NOTICE,
  STALE_CATALOG_NOTICE,
  shouldRequestCatalog,
} from '../agentModelCatalog';

/**
 * D48 S2 §4.1/§4.3-5 — the renderer's reading of `source`, and its request gate.
 *
 * The load-bearing assertion of the file is the seed row: `source:'seed'` MUST reach the
 * user as words. A build that renders the built-in table as an ordinary catalog
 * passes every other test here and still ships the failure the whole
 * discriminant exists to prevent (仲裁 §2.2 ∧ B「不得伪装可用目录」).
 */

const NOW = 1_700_000_000_000;

function proxyCatalog(overrides: Partial<AgentModelCatalog> = {}): AgentModelCatalog {
  return {
    agent: CLAUDE_CODE_AGENT,
    models: seedModelsFor(CLAUDE_CODE_AGENT),
    source: 'proxy',
    stale: false,
    fetchedAt: NOW,
    ...overrides,
  };
}

describe('catalogStatusRow (§4.3-5: catalog provenance is a status row)', () => {
  it('a live proxy answer needs no explanation at all', () => {
    expect(catalogStatusRow({ catalog: proxyCatalog(), loading: false })).toEqual({
      message: null,
      retryable: false,
      reason: null,
    });
  });

  it('load-bearing: a seed result says the catalog is unreachable, and offers a retry', () => {
    const row = catalogStatusRow({
      catalog: proxyCatalog({ source: 'seed', stale: true, fetchedAt: null, error: 'http' }),
      loading: false,
    });
    expect(row.message).toBe(SEED_CATALOG_NOTICE);
    expect(row.retryable).toBe(true);
    expect(row.reason).toBe('seed');
  });

  it('load-bearing: credentials-unavailable is a seed result too, and says the same thing', () => {
    const row = catalogStatusRow({
      catalog: proxyCatalog({
        source: 'seed',
        stale: true,
        fetchedAt: null,
        error: 'credentials-unavailable',
      }),
      loading: false,
    });
    expect(row.message).toBe(SEED_CATALOG_NOTICE);
    expect(row.retryable).toBe(true);
  });

  it('a stale cache says so separately — it is real data, just not current', () => {
    const row = catalogStatusRow({
      catalog: proxyCatalog({ source: 'stale-cache', stale: true, error: 'http' }),
      loading: false,
    });
    expect(row.message).toBe(STALE_CATALOG_NOTICE);
    expect(row.message).not.toBe(SEED_CATALOG_NOTICE);
    expect(row.retryable).toBe(true);
  });

  // §4.1's fourth rung, and the one that must NOT read as a failure: the gateway
  // answered, and after family filtering nothing is on the product surface.
  it('an empty PROXY answer is the fourth rung, not an error', () => {
    const row = catalogStatusRow({ catalog: proxyCatalog({ models: [] }), loading: false });
    expect(row.message).toBe(EMPTY_CATALOG_NOTICE);
    expect(row.reason).toBe('empty');
    expect(row.retryable).toBe(true);
  });

  it('host-not-ready explains itself and offers no retry — there is nothing to retry yet', () => {
    const row = catalogStatusRow({ catalog: hostNotReadyCatalog(CODEX_AGENT), loading: false });
    expect(row.message).toBe(HOST_NOT_READY_CATALOG_NOTICE);
    expect(row.retryable).toBe(false);
    expect(row.reason).toBe('host-not-ready');
  });

  it('a refresh over a good list is the lowest-priority message', () => {
    expect(catalogStatusRow({ catalog: proxyCatalog(), loading: true }).message).toBe(
      REFRESHING_CATALOG_NOTICE
    );
    // …and never outranks "these models are fabricated".
    expect(
      catalogStatusRow({ catalog: proxyCatalog({ source: 'seed' }), loading: true }).message
    ).toBe(SEED_CATALOG_NOTICE);
  });

  it('the very first fetch shows a refresh line rather than nothing', () => {
    expect(catalogStatusRow({ catalog: null, loading: true }).message).toBe(
      REFRESHING_CATALOG_NOTICE
    );
    expect(catalogStatusRow({ catalog: null, loading: false }).message).toBeNull();
  });
});

describe('shouldRequestCatalog (§4.1: lazy, never at startup)', () => {
  const base = { cached: null, inFlight: false, force: false, now: NOW } as const;

  it('asks nothing before the Host is ready', () => {
    for (const hostState of ['stopped', 'starting', 'error'] as const) {
      expect(shouldRequestCatalog({ ...base, hostState })).toBe(false);
    }
    expect(shouldRequestCatalog({ ...base, hostState: 'ready' })).toBe(true);
  });

  it('never doubles up on an in-flight request', () => {
    expect(shouldRequestCatalog({ ...base, hostState: 'ready', inFlight: true })).toBe(false);
    expect(shouldRequestCatalog({ ...base, hostState: 'ready', inFlight: true, force: true })).toBe(
      false
    );
  });

  it('holds a fresh proxy answer for the TTL and re-asks after it', () => {
    const cached = proxyCatalog({ fetchedAt: NOW });
    expect(shouldRequestCatalog({ ...base, hostState: 'ready', cached })).toBe(false);
    expect(
      shouldRequestCatalog({
        ...base,
        hostState: 'ready',
        cached,
        now: NOW + CATALOG_REFRESH_TTL_MS,
      })
    ).toBe(true);
  });

  it('force skips the TTL', () => {
    expect(
      shouldRequestCatalog({ ...base, hostState: 'ready', cached: proxyCatalog(), force: true })
    ).toBe(true);
  });

  // A seed/stale record is a record of a FAILURE. Holding it for the full TTL
  // would keep an unreachable-catalog banner on screen long after the cause has
  // gone away.
  it('re-asks immediately when what it holds is a fallback rather than an answer', () => {
    for (const source of ['seed', 'stale-cache'] as const) {
      expect(
        shouldRequestCatalog({
          ...base,
          hostState: 'ready',
          cached: proxyCatalog({ source, stale: true }),
        })
      ).toBe(true);
    }
  });
});

describe('hostNotReadyCatalog / isCatalogLoaded', () => {
  // Main has no view of Host state, so this arm can only be produced here —
  // asserted so the value cannot quietly migrate across the border.
  it('is the renderer-produced arm, and it is stable per agent', () => {
    const first = hostNotReadyCatalog(CLAUDE_CODE_AGENT);
    expect(first.error).toBe('host-not-ready');
    expect(first.models).toEqual([]);
    expect(hostNotReadyCatalog(CLAUDE_CODE_AGENT)).toBe(first);
    expect(hostNotReadyCatalog(CODEX_AGENT)).not.toBe(first);
  });

  // B17's gate: "we have not asked yet" must never be read as "the catalog does
  // not contain it", or the reconcile would wipe a stored selection on boot.
  it('does not count as loaded, so nothing reconciles against it', () => {
    expect(isCatalogLoaded(null)).toBe(false);
    expect(isCatalogLoaded(hostNotReadyCatalog(CLAUDE_CODE_AGENT))).toBe(false);
    expect(isCatalogLoaded(proxyCatalog())).toBe(true);
    expect(isCatalogLoaded(proxyCatalog({ source: 'seed', models: [] }))).toBe(true);
  });

  it('catalogModels is total, and referentially stable when empty', () => {
    expect(catalogModels(proxyCatalog())).toEqual(CLAUDE_SEED_MODELS);
    expect(catalogModels(null)).toEqual([]);
    // Same instance every time: a fresh `[]` per call would re-run the model
    // trigger's reconciliation effect on every render of the pre-catalog window.
    expect(catalogModels(null)).toBe(catalogModels(null));
  });
});
