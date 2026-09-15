/**
 * T026 — read the active session's capability inventory from Main.
 *
 * A pull, not a subscription: the inventory is fixed for the life of a
 * bootstrap, so the only moments it can change are a session switch and a fresh
 * `session.created` / `session.resumed` (a first send, a resume, a crash
 * restart). Both are covered here; anything else would be re-fetching a
 * constant.
 *
 * Replaces `useSessionExtensions`, which read a pi extension list that has had
 * no producer since P6-5.
 *
 * Never throws and never surfaces an error: this panel is informational, and a
 * failed read must not put an error state in the sidebar. It reports `null`
 * ("nobody has told us") which the model already renders honestly.
 */

import type { WorkerCapabilityInventory } from '@shared/types/workerRpc';
import { useCallback, useEffect, useState } from 'react';
import { subscribeRuntimeEvent } from '@/stores/runtimeEventBus';

export function useSessionCapabilities(sessionId: string | null): {
  capabilities: WorkerCapabilityInventory | null;
  refresh: () => void;
} {
  const [capabilities, setCapabilities] = useState<WorkerCapabilityInventory | null>(null);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the refetch TRIGGER, not a value the body reads
  useEffect(() => {
    if (!sessionId) {
      setCapabilities(null);
      return () => undefined;
    }
    let cancelled = false;
    void window.electronAPI.chat
      .listSessionCapabilities({ sessionId })
      .then((result) => {
        if (!cancelled) setCapabilities(result ?? null);
      })
      .catch(() => {
        if (!cancelled) setCapabilities(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  useEffect(() => {
    if (!sessionId) return () => undefined;
    return subscribeRuntimeEvent((event) => {
      // Both events mean "a worker just finished bootstrapping", which is
      // exactly when this inventory comes into existence. `session.resumed` was
      // missing until U23 and it is the one a session opened from the sidebar
      // actually emits, so the fetch above — fired the moment `sessionId`
      // changed, before any worker existed — stayed the only attempt and the
      // panel was stuck on "send a message first" for an already-live chat.
      // `permissionGate.ts` reads the same pair for the same reason.
      if (
        (event.type === 'session.created' || event.type === 'session.resumed') &&
        event.sessionId === sessionId
      ) {
        refresh();
      }
    });
  }, [sessionId, refresh]);

  return { capabilities, refresh };
}
