import type { RuntimeEvent } from '@shared/types/runtimeEvents';

/**
 * Incident 2026-08-15 (`chat:runtimeEvent` MaxListenersExceededWarning, 11/10):
 * preload's `onRuntimeEvent` installs a BARE `ipcRenderer.on` per call, and the
 * renderer legitimately holds 11-13 concurrent subscriptions in a normal
 * session (7 app-lifetime ones plus the per-mount hooks: `useHostStatus`,
 * `useMessageMetadata`, `useTurnTiming`). That is static over-subscription, not
 * a leak — every site already unsubscribes symmetrically — so the fix is to
 * fan out from ONE upstream listener instead of trimming call sites.
 *
 * Refcounted: the upstream IPC listener is attached on the first subscribe and
 * detached on the last unsubscribe, so a fully idle renderer holds zero.
 *
 * Pure module by construction — `window` is read lazily inside the default
 * upstream, never at import time, so this file stays importable under the
 * node-env vitest suite.
 */

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/** Source of raw events; returns its own teardown (preload's `onRuntimeEvent`). */
export type RuntimeEventUpstream = (listener: RuntimeEventListener) => () => void;

export interface RuntimeEventBus {
  /** Register a listener; returns an idempotent unsubscribe. */
  subscribe: (listener: RuntimeEventListener) => () => void;
}

export function createRuntimeEventBus(upstream: RuntimeEventUpstream): RuntimeEventBus {
  const listeners = new Set<RuntimeEventListener>();
  let detachUpstream: (() => void) | null = null;

  const dispatch = (event: RuntimeEvent) => {
    // Snapshot: a listener may subscribe or unsubscribe while being notified
    // (a hook cleanup running inside a setState, for instance), and mutating
    // the live Set mid-iteration would skip or double-visit its neighbours.
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (err) {
        // One faulty consumer must not swallow the event for the rest — the
        // per-call-site behaviour before the fan-out, where each listener sat
        // on its own IPC handler.
        console.error('[runtimeEventBus] listener threw', err);
      }
    }
  };

  return {
    subscribe: (listener) => {
      // Attach before registering so a throwing upstream leaves no orphan
      // listener behind, and propagates to the caller as it did when every
      // site called `onRuntimeEvent` itself.
      if (listeners.size === 0) {
        detachUpstream = upstream(dispatch);
      }
      listeners.add(listener);

      let disposed = false;
      return () => {
        // Idempotent: React StrictMode and the composer's `finally` both make
        // a double-call reachable, and without this guard the second one would
        // tear the shared upstream down while other subscribers are still live.
        if (disposed) return;
        disposed = true;
        listeners.delete(listener);
        if (listeners.size === 0 && detachUpstream) {
          const detach = detachUpstream;
          detachUpstream = null;
          detach();
        }
      };
    },
  };
}

let bus: RuntimeEventBus | null = null;

function getBus(): RuntimeEventBus {
  if (!bus) {
    bus = createRuntimeEventBus((listener) => window.electronAPI.chat.onRuntimeEvent(listener));
  }
  return bus;
}

/** Drop-in replacement for `window.electronAPI.chat.onRuntimeEvent`. */
export function subscribeRuntimeEvent(listener: RuntimeEventListener): () => void {
  return getBus().subscribe(listener);
}

/**
 * Test seam: drops the singleton (listeners included) WITHOUT calling the
 * upstream teardown, so a suite's `onRuntimeEvent` spy counts only what the
 * test itself did. Never call this from app code.
 */
export function resetRuntimeEventBus(): void {
  bus = null;
}
