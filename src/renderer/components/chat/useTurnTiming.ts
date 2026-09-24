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
 * `thinking.started`/`thinking.completed` — and, since 2026-09-23,
 * `tool.started`/`tool.completed` for the running rows' live elapsed tail —
 * into per-block duration lookups, without touching the red-line
 * `chatSessions` store.
 */

export interface UseTurnTimingResult {
  getThinking: (blockId: string) => ThinkingTiming | undefined;
  /** `tool.started` stamp, keyed by `toolCallId`. Only a running row reads it. */
  getToolStartedAtMs: (toolCallId: string) => number | null | undefined;
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

  // Stable across renders that did not change THEIR map — same reason as
  // `useMessageMetadata`'s `get` (review batch F7): both feed props of the
  // memoized `ChatTurn`. Keyed on the map, not the registry, so a tool event
  // leaves `getThinking` (read by every turn) untouched.
  const { byBlock, byToolCall } = registry;
  const getThinking = useCallback((blockId: string) => byBlock[blockId], [byBlock]);
  const getToolStartedAtMs = useCallback(
    (toolCallId: string) => byToolCall[toolCallId]?.startedAt,
    [byToolCall]
  );

  return { getThinking, getToolStartedAtMs };
}
