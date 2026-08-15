import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { useCallback, useEffect, useState } from 'react';
import { subscribeRuntimeEvent } from '@/stores/runtimeEventBus';
import {
  initialTurnTimingRegistry,
  reduceTurnTiming,
  type ThinkingTiming,
  type TurnTimingRegistry,
} from './turnTiming';

/**
 * Team-side thinking-timing registry surface (T-05, mirrors `useMessageMetadata.ts`):
 * subscribes to Runtime Events for the active session and folds
 * `thinking.started`/`thinking.completed` into a per-block duration lookup,
 * without touching the red-line `chatSessions` store.
 */

export interface UseTurnTimingResult {
  getThinking: (blockId: string) => ThinkingTiming | undefined;
}

export function useTurnTiming(sessionId: string | null): UseTurnTimingResult {
  const [registry, setRegistry] = useState<TurnTimingRegistry>(initialTurnTimingRegistry);

  useEffect(() => {
    if (!sessionId) {
      setRegistry(initialTurnTimingRegistry);
      return () => undefined;
    }
    let cancelled = false;
    const unsubscribe = subscribeRuntimeEvent((event: RuntimeEvent) => {
      if (cancelled) return;
      if (event.sessionId && event.sessionId !== sessionId) return;
      setRegistry((prev) => reduceTurnTiming(prev, event));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  // Stable across renders that did not change the registry — same reason as
  // `useMessageMetadata`'s `get` (review batch F7): it feeds a prop of the
  // memoized `ChatTurn`.
  const getThinking = useCallback((blockId: string) => registry.byBlock[blockId], [registry]);

  return { getThinking };
}
