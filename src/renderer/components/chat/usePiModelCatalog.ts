import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { useCallback, useEffect, useState } from 'react';
import type { HostStatus } from './hostStatus';
import {
  type CatalogStatusRow,
  catalogStatusRow,
  hostNotReadyCatalog,
  isCatalogLoaded,
  shouldRequestCatalog,
} from './piModelCatalog';

let cachedCatalog: AgentModelCatalog | null = null;
let inFlight = false;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

export interface UsePiModelCatalogResult {
  catalog: AgentModelCatalog | null;
  loaded: boolean;
  loading: boolean;
  status: CatalogStatusRow;
  refresh: () => void;
  retry: () => void;
}

/** Renderer-local cache for the single Pi model catalog. */
export function usePiModelCatalog(hostState: HostStatus['state']): UsePiModelCatalogResult {
  const [, forceRender] = useState(0);

  useEffect(() => {
    const listener = () => forceRender((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const request = useCallback(
    (force: boolean) => {
      if (
        !shouldRequestCatalog({
          hostState,
          cached: cachedCatalog,
          inFlight,
          force,
          now: Date.now(),
        })
      ) {
        return;
      }
      inFlight = true;
      publish();
      void window.electronAPI.chat
        .listPiModels(force ? { force: true } : undefined)
        .then((result) => {
          if (result && Array.isArray(result.models)) cachedCatalog = result;
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
          publish();
        });
    },
    [hostState]
  );

  useEffect(() => {
    request(false);
  }, [request]);

  const catalog = cachedCatalog ?? (hostState === 'ready' ? null : hostNotReadyCatalog());
  return {
    catalog,
    loaded: isCatalogLoaded(catalog),
    loading: inFlight,
    status: catalogStatusRow({ catalog, loading: inFlight }),
    refresh: useCallback(() => request(false), [request]),
    retry: useCallback(() => request(true), [request]),
  };
}
