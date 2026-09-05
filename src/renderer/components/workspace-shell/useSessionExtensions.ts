/**
 * U04 — read the active session's loaded-extension list from Main.
 *
 * A pull, not a subscription: the list is fixed for the life of a bootstrap, so
 * the only moments it can change are a session switch and a fresh
 * `session.created` (a first send, a resume, a crash restart). Both are
 * covered here; anything else would be re-fetching a constant.
 *
 * Never throws and never surfaces an error: a plugin list is informational, and
 * a failed read must not put an error state in the sidebar. It reports `null`
 * ("nobody has told us") which the model already renders honestly.
 */

import type { WorkerExtensionInfo } from '@shared/types/workerRpc';
import { useCallback, useEffect, useState } from 'react';
import { subscribeRuntimeEvent } from '@/stores/runtimeEventBus';

export function useSessionExtensions(sessionId: string | null): {
  extensions: WorkerExtensionInfo[] | null;
  refresh: () => void;
} {
  const [extensions, setExtensions] = useState<WorkerExtensionInfo[] | null>(null);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the refetch TRIGGER, not a value the body reads
  useEffect(() => {
    if (!sessionId) {
      setExtensions(null);
      return () => undefined;
    }
    let cancelled = false;
    void window.electronAPI.chat
      .listSessionExtensions({ sessionId })
      .then((result) => {
        if (!cancelled) setExtensions(result ?? null);
      })
      .catch(() => {
        if (!cancelled) setExtensions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  useEffect(() => {
    if (!sessionId) return () => undefined;
    return subscribeRuntimeEvent((event) => {
      // `session.created` is the one event that means "a worker just finished
      // bootstrapping", which is exactly when this list comes into existence.
      if (event.type === 'session.created' && event.sessionId === sessionId) refresh();
    });
  }, [sessionId, refresh]);

  return { extensions, refresh };
}
