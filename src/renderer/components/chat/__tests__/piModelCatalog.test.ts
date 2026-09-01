import type { AgentModelCatalog } from '@shared/types/agentCatalog';
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
} from '../piModelCatalog';

const NOW = 1_700_000_000_000;

function catalog(overrides: Partial<AgentModelCatalog> = {}): AgentModelCatalog {
  return {
    models: [{ id: 'glm/glm-5', label: 'GLM 5' }],
    source: 'local',
    stale: false,
    fetchedAt: NOW,
    ...overrides,
  };
}

describe('Pi model catalog status', () => {
  it('needs no explanation for a live managed/local catalog', () => {
    expect(catalogStatusRow({ catalog: catalog(), loading: false })).toEqual({
      message: null,
      retryable: false,
      reason: null,
    });
  });

  it('labels seed and stale fallbacks honestly', () => {
    expect(
      catalogStatusRow({
        catalog: catalog({ source: 'seed', stale: true, fetchedAt: null, error: 'http' }),
        loading: false,
      }).message
    ).toBe(SEED_CATALOG_NOTICE);
    expect(
      catalogStatusRow({
        catalog: catalog({ source: 'stale-cache', stale: true, error: 'http' }),
        loading: false,
      }).message
    ).toBe(STALE_CATALOG_NOTICE);
  });

  it('distinguishes empty, not-ready, and refreshing states', () => {
    expect(catalogStatusRow({ catalog: catalog({ models: [] }), loading: false }).message).toBe(
      EMPTY_CATALOG_NOTICE
    );
    expect(catalogStatusRow({ catalog: hostNotReadyCatalog(), loading: false }).message).toBe(
      HOST_NOT_READY_CATALOG_NOTICE
    );
    expect(catalogStatusRow({ catalog: null, loading: true }).message).toBe(
      REFRESHING_CATALOG_NOTICE
    );
  });
});

describe('Pi catalog request gate', () => {
  const base = { cached: null, inFlight: false, force: false, now: NOW } as const;

  it('waits for worker readiness and deduplicates in-flight requests', () => {
    expect(shouldRequestCatalog({ ...base, hostState: 'stopped' })).toBe(false);
    expect(shouldRequestCatalog({ ...base, hostState: 'ready' })).toBe(true);
    expect(shouldRequestCatalog({ ...base, hostState: 'ready', inFlight: true })).toBe(false);
  });

  it('holds fresh local/managed data for the TTL and retries fallbacks immediately', () => {
    for (const source of ['local', 'managed'] as const) {
      const cached = catalog({ source });
      expect(shouldRequestCatalog({ ...base, hostState: 'ready', cached })).toBe(false);
      expect(
        shouldRequestCatalog({
          ...base,
          hostState: 'ready',
          cached,
          now: NOW + CATALOG_REFRESH_TTL_MS,
        })
      ).toBe(true);
    }
    expect(
      shouldRequestCatalog({
        ...base,
        hostState: 'ready',
        cached: catalog({ source: 'seed', stale: true }),
      })
    ).toBe(true);
  });
});

describe('Pi catalog helpers', () => {
  it('uses one stable pre-ready record and a stable empty model list', () => {
    expect(hostNotReadyCatalog()).toBe(hostNotReadyCatalog());
    expect(isCatalogLoaded(hostNotReadyCatalog())).toBe(false);
    expect(isCatalogLoaded(catalog())).toBe(true);
    expect(catalogModels(null)).toBe(catalogModels(null));
  });
});
