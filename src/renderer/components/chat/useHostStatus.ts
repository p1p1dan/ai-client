import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { useEffect, useState } from 'react';
import { subscribeRuntimeEvent } from '@/stores/runtimeEventBus';
import {
  type HostStatus,
  initialHostStatus,
  primeHostStatus,
  reduceHostStatus,
} from './hostStatus';

/**
 * Subscribe to Host Runtime Events + poll `getHostStatus` for a display-ready
 * snapshot (T-09). Host crash / Node 24 missing flip state to `error`.
 *
 * `retry` re-runs `ensureHost` so a user can recover after a Node 24 path fix
 * or after the Host process was killed (acceptance: "kill Host → reconnect").
 *
 * Renderer-only; does not touch the red-line store.
 */

interface HostStatusSnapshot {
  status: HostStatus;
  /** Re-attempt Host start (Main side `ensureHost`). */
  retry: () => Promise<void>;
}

export function useHostStatus(): HostStatusSnapshot {
  const [status, setStatus] = useState<HostStatus>(initialHostStatus);

  useEffect(() => {
    let cancelled = false;

    // Prime from the Main-side snapshot so the pill renders instantly.
    // S7 (round-2 iteration-3 review): `primeHostStatus` (hostStatus.ts) now
    // also copies `settings` — a consumer mounting after `host.ready` already
    // fired otherwise never learns the Host's reported default model.
    //
    // Field report 2026-09-07: this is `ensureHost`, not `getHostStatus`. The
    // two return the SAME snapshot shape, but `ensureHost` first flips a
    // never-started WorkerManager out of its initial `stopped` value. Reading
    // without ensuring raced the `ensureHost` that `chatSessions.initRuntime`
    // fires from this very same mount — the read reached Main first, came back
    // `stopped`, and nothing re-read the status until the 10s probe below. For
    // those ten seconds the user saw "Pi session service 已停止 · 点击 Retry"
    // over a service that answered the very next message, the model picker
    // held its "host not ready" fallback catalog, and the permission control
    // was greyed out. `ensureReady()` only assigns a field: no process is
    // spawned by this call, so a status hook may make it.
    void window.electronAPI.chat
      .ensureHost()
      .catch(() => window.electronAPI.chat.getHostStatus())
      .then((initial) => {
        if (cancelled) return;
        setStatus((prev) => primeHostStatus(prev, initial));
      })
      .catch(() => undefined);

    const unsubscribe = subscribeRuntimeEvent((event: RuntimeEvent) => {
      if (cancelled) return;
      setStatus((prev) => reduceHostStatus(prev, event));
    });

    // Lightweight reconnect probe: if state sits in `error`/`stopped` the Main
    // process clears pid; a recovered Host reappears via host.ready, but we
    // also poll every 10s to surface process death without a runtime event.
    const probe = setInterval(() => {
      void window.electronAPI.chat
        .getHostStatus()
        .then((snapshot) => {
          if (cancelled) return;
          setStatus((prev) => {
            const next = { ...prev };
            if (typeof snapshot?.state === 'string') {
              next.state = snapshot.state as HostStatus['state'];
            }
            if (snapshot) {
              next.capacity = snapshot.capacity;
              next.slots = snapshot.slots;
              next.active = snapshot.active;
              next.restarting = snapshot.restarting;
              next.errors = snapshot.errors;
              next.capabilities = snapshot.capabilities;
            }
            return next;
          });
        })
        .catch(() => undefined);
    }, 10_000);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(probe);
    };
  }, []);

  const retry = async () => {
    try {
      // Adopt the snapshot this call returns rather than waiting for the next
      // probe tick: a Retry that leaves the ribbon untouched for up to 10s
      // reads as a dead button, and the user presses it again.
      const snapshot = await window.electronAPI.chat.ensureHost();
      setStatus((prev) => primeHostStatus(prev, snapshot));
    } catch {
      // ensureHost rejection (e.g. Node 24 missing) is surfaced via state=error
      // through getHostStatus polling; nothing more to do here.
    }
  };

  return { status, retry };
}
