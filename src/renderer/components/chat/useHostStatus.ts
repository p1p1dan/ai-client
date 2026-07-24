import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { useEffect, useState } from 'react';
import { type HostStatus, initialHostStatus, reduceHostStatus } from './hostStatus';

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
    void window.electronAPI.chat
      .getHostStatus()
      .then((initial) => {
        if (cancelled) return;
        setStatus((prev) => ({
          ...prev,
          state: (initial?.state as HostStatus['state']) ?? prev.state,
          pid: typeof initial?.pid === 'number' ? initial.pid : undefined,
          driver: (initial?.driver as string | undefined) ?? prev.driver,
          cometixVersion: initial?.cometixVersion ?? prev.cometixVersion,
        }));
      })
      .catch(() => undefined);

    const unsubscribe = window.electronAPI.chat.onRuntimeEvent((event: RuntimeEvent) => {
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
            if (typeof snapshot?.pid === 'number') next.pid = snapshot.pid;
            else if (prev.state !== 'error' && next.state !== 'ready') next.pid = undefined;
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
      await window.electronAPI.chat.ensureHost();
    } catch {
      // ensureHost rejection (e.g. Node 24 missing) is surfaced via state=error
      // through getHostStatus polling; nothing more to do here.
    }
  };

  return { status, retry };
}
