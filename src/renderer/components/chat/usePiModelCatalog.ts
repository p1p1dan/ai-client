import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { useCallback, useEffect, useState } from 'react';
import { type HostStatus, isHostUsable } from './hostStatus';
import {
  type CatalogStatusRow,
  catalogStatusRow,
  hostNotReadyCatalog,
  isCatalogAuthoritative,
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
  /**
   * F07: the request settled AND somebody answered what exists. Narrower than
   * `loaded`, which a failure also satisfies — see `isCatalogAuthoritative`.
   * Only this may be read as evidence about a model.
   */
  authoritative: boolean;
  loading: boolean;
  status: CatalogStatusRow;
  refresh: () => void;
  retry: () => void;
}

/**
 * Force a re-fetch from outside the hook, and publish it to every mounted
 * consumer.
 *
 * For callers that have just made the catalog change in Main — today that is
 * `PiModelSyncNotice`'s Retry, which re-runs the managed sync. Main
 * invalidates its own workers there, but this cache is the renderer's and
 * nothing invalidates it: the hook only re-requests when `hostState` moves, so
 * a successful retry would otherwise leave the menu showing the same empty
 * list it had a second earlier, and the user would read the retry as broken.
 *
 * No `hostState` gate, unlike the hook's own path: this is only ever reached
 * from an explicit user action, and by then Main has already answered — so the
 * lazy "do not ask before the Host is up" rule has nothing left to protect.
 */
export async function refreshPiModelCatalog(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  publish();
  try {
    const result = await window.electronAPI.chat.listPiModels({ force: true });
    if (result && Array.isArray(result.models)) cachedCatalog = result;
  } catch {
    // Same as the hook's own `.catch`: a failed refresh leaves the previous
    // list in place rather than replacing it with an emptier lie.
  } finally {
    inFlight = false;
    publish();
  }
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

  const catalog = cachedCatalog ?? (isHostUsable(hostState) ? null : hostNotReadyCatalog());
  return {
    catalog,
    loaded: isCatalogLoaded(catalog),
    authoritative: isCatalogAuthoritative(catalog),
    loading: inFlight,
    status: catalogStatusRow({ catalog, loading: inFlight }),
    refresh: useCallback(() => request(false), [request]),
    retry: useCallback(() => request(true), [request]),
  };
}
