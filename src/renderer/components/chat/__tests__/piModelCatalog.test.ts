import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_CATALOG_NOTICE,
  CATALOG_REFRESH_TTL_MS,
  catalogModels,
  catalogStatusRow,
  EMPTY_CATALOG_NOTICE,
  HOST_NOT_READY_CATALOG_NOTICE,
  hostNotReadyCatalog,
  isCatalogAuthoritative,
  isCatalogLoaded,
  MANAGED_EMPTY_CATALOG_NOTICE,
  REFRESHING_CATALOG_NOTICE,
  STALE_CATALOG_NOTICE,
  shouldRequestCatalog,
  UNAVAILABLE_CATALOG_NOTICE,
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

  it('labels unavailable and stale fallbacks honestly', () => {
    expect(
      catalogStatusRow({
        catalog: catalog({ source: 'unavailable', stale: true, fetchedAt: null, error: 'http' }),
        loading: false,
      }).message
    ).toBe(UNAVAILABLE_CATALOG_NOTICE);
    expect(
      catalogStatusRow({
        catalog: catalog({ source: 'stale-cache', stale: true, error: 'http' }),
        loading: false,
      }).message
    ).toBe(STALE_CATALOG_NOTICE);
  });

  it('says a shipped baseline is a shipped baseline, not a cache (A3)', () => {
    // The two sentences answer different questions. A user whose model is
    // missing needs to know whether an administrator removed it or the network
    // is down, and "the last known list" would claim this machine had it once.
    const row = catalogStatusRow({
      catalog: catalog({ source: 'bundled', stale: true, fetchedAt: null, error: 'http' }),
      loading: false,
    });
    expect(row).toEqual({
      message: BUNDLED_CATALOG_NOTICE,
      retryable: true,
      reason: 'bundled',
    });
    expect(row.message).not.toBe(STALE_CATALOG_NOTICE);
  });

  it('keeps asking for a live catalog while showing the shipped baseline', () => {
    // A populated menu must not pin the process to the baseline: `bundled` is a
    // failure rung like `unavailable`, not an authoritative answer.
    const bundled = catalog({ source: 'bundled', stale: true, fetchedAt: null });
    expect(isCatalogAuthoritative(bundled)).toBe(false);
    expect(
      shouldRequestCatalog({
        hostState: 'ready',
        cached: bundled,
        inFlight: false,
        force: false,
        now: NOW,
      })
    ).toBe(true);
  });

  it('distinguishes empty, not-ready, and refreshing states', () => {
    expect(catalogStatusRow({ catalog: catalog({ models: [] }), loading: false }).message).toBe(
      EMPTY_CATALOG_NOTICE
    );
    // D03: an answered managed catalog with nothing in it has a cause the user
    // can act on, and must not be worded like an unreachable one.
    const managedEmpty = catalogStatusRow({
      catalog: catalog({ source: 'managed', models: [] }),
      loading: false,
    });
    expect(managedEmpty.message).toBe(MANAGED_EMPTY_CATALOG_NOTICE);
    expect(managedEmpty.reason).toBe('empty');
    expect(managedEmpty.retryable).toBe(true);
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

  it('asks a degraded manager anyway, and holds off while the state is unknown', () => {
    // `degraded` is one crashed pooled worker, not a manager that stopped
    // answering — see `isHostUsable`. `unknown` is the pre-prime value: no
    // answer yet is not the same as an answer of "ready".
    expect(shouldRequestCatalog({ ...base, hostState: 'degraded' })).toBe(true);
    expect(shouldRequestCatalog({ ...base, hostState: 'unknown' })).toBe(false);
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
        cached: catalog({ source: 'unavailable', stale: true }),
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

describe('F07 authoritative catalog', () => {
  it('counts only the three sources that actually answered', () => {
    expect(isCatalogAuthoritative(catalog({ source: 'proxy' }))).toBe(true);
    expect(isCatalogAuthoritative(catalog({ source: 'managed' }))).toBe(true);
    expect(isCatalogAuthoritative(catalog({ source: 'local' }))).toBe(true);
  });

  it('treats an answered-but-empty catalog as an answer', () => {
    expect(isCatalogAuthoritative(catalog({ source: 'managed', models: [] }))).toBe(true);
  });

  it('refuses to read a failure as evidence about a model', () => {
    // Nothing asked yet.
    expect(isCatalogAuthoritative(null)).toBe(false);
    expect(isCatalogAuthoritative(hostNotReadyCatalog())).toBe(false);
    // Asked and failed. Both are `isCatalogLoaded`, and that is the whole gap:
    // settled is not the same as answered.
    const unavailable = catalog({ source: 'unavailable', models: [], stale: true, error: 'http' });
    const stale = catalog({ source: 'stale-cache', stale: true, error: 'http' });
    expect(isCatalogLoaded(unavailable)).toBe(true);
    expect(isCatalogLoaded(stale)).toBe(true);
    expect(isCatalogAuthoritative(unavailable)).toBe(false);
    expect(isCatalogAuthoritative(stale)).toBe(false);
  });
});
