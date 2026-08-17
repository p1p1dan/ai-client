import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import type { AgentWireName } from '@shared/types/agentWire';
import { useCallback, useEffect, useState } from 'react';
import {
  type CatalogStatusRow,
  catalogStatusRow,
  hostNotReadyCatalog,
  isCatalogLoaded,
  shouldRequestCatalog,
} from './agentModelCatalog';
import type { HostStatus } from './hostStatus';

/**
 * D48 S2 §4.1/§4.3-2 — `chat:listAgentModels`'s only renderer consumer.
 *
 * Deliberately NOT in `chatSessions.ts` (§4.1 says so): the catalog is a
 * transient view concern with network IO behind it, and the red-line store is
 * append-only session state. Nothing here is persisted.
 *
 * ## The module-level cache is the "show the last value" mechanism
 *
 * Switching a zero-turn draft between agents must not blank the model trigger
 * while the other axis's catalog is fetched (§4.3-6). A `useState` cache cannot
 * do that — every remount starts empty — so the last answer per agent is held
 * for the life of the renderer process, next to a set of in-flight agents that
 * collapses the double render an agent switch produces into one IPC call. Main
 * single-flights on its own side too (B2); this is not a substitute for that, it
 * just avoids asking twice for the same paint.
 *
 * ## Credentials never appear here
 *
 * The IPC answer carries ids, labels and provenance — no key, no token, no base
 * URL, no raw body (§0.1-2). That is a property of the Main service, asserted
 * there (B4); this file simply has nothing to leak.
 */

const catalogByAgent = new Map<AgentWireName, AgentModelCatalog>();
const inFlightAgents = new Set<AgentWireName>();
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

export interface UseAgentModelCatalogResult {
  /** The last answer for this agent, or null before the first one arrives. */
  catalog: AgentModelCatalog | null;
  /** `false` until an answer exists — gates the reconcile rewrite arm (B17). */
  loaded: boolean;
  loading: boolean;
  status: CatalogStatusRow;
  /**
   * Re-ask IF the cached answer is past its TTL (§4.1 刷新). Opening the menu
   * calls this: nothing else in the lifetime of the renderer would, since the
   * request effect only re-runs when the agent or the Host state changes and
   * the trigger is never remounted.
   */
  refresh: () => void;
  /** Force a refresh past the TTL; Retry/Refresh only. */
  retry: () => void;
}

export function useAgentModelCatalog(
  agent: AgentWireName,
  hostState: HostStatus['state']
): UseAgentModelCatalogResult {
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
      const cached = catalogByAgent.get(agent) ?? null;
      if (
        !shouldRequestCatalog({
          hostState,
          cached,
          inFlight: inFlightAgents.has(agent),
          force,
          now: Date.now(),
        })
      ) {
        return;
      }
      inFlightAgents.add(agent);
      publish();
      void window.electronAPI.chat
        .listAgentModels({ agent, ...(force ? { force: true } : {}) })
        .then((result) => {
          // Guard the shape rather than trusting it: this crosses a process
          // boundary, and a menu that renders `undefined.length` is a blank
          // Composer rather than a caught error.
          if (result && Array.isArray(result.models)) {
            catalogByAgent.set(agent, result);
          }
        })
        .catch(() => {
          // An IPC-level rejection is not a reason to drop a good earlier
          // answer — Main's own four-level fallback already resolves every
          // catalog failure into a record, so reaching here means the channel
          // itself failed and the last known list is the best thing on hand.
        })
        .finally(() => {
          inFlightAgents.delete(agent);
          publish();
        });
    },
    [agent, hostState]
  );

  useEffect(() => {
    request(false);
  }, [request]);

  const cached = catalogByAgent.get(agent) ?? null;
  const catalog = cached ?? (hostState === 'ready' ? null : hostNotReadyCatalog(agent));
  const loading = inFlightAgents.has(agent);

  return {
    catalog,
    loaded: isCatalogLoaded(catalog),
    loading,
    status: catalogStatusRow({ catalog, loading }),
    refresh: useCallback(() => request(false), [request]),
    retry: useCallback(() => request(true), [request]),
  };
}
