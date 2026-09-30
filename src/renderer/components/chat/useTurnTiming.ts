import { useCallback, useEffect } from 'react';
import { useTurnTimingStore } from '@/stores/turnTimingRegistry';
import type { ThinkingTiming } from './turnTiming';

/**
 * Team-side thinking-timing registry surface (T-05, mirrors `useMessageMetadata.ts`):
 * per-block duration lookups folded from `thinking.started`/`thinking.completed`
 * — and, since 2026-09-23, `tool.started`/`tool.completed` for the running
 * rows' live elapsed tail — without touching the red-line `chatSessions` store.
 *
 * dsh-rebase P1-7e (decision 140): the registry lives in
 * `stores/turnTimingRegistry.ts` for the whole run, fed for every chat by one
 * listener. This hook only holds that listener while it is mounted and reads
 * its chat's registry, so a timeline that remounts still says 「思考 N 秒」.
 */

export interface UseTurnTimingResult {
  getThinking: (blockId: string) => ThinkingTiming | undefined;
  /** `tool.started` stamp, keyed by `toolCallId`. Only a running row reads it. */
  getToolStartedAtMs: (toolCallId: string) => number | null | undefined;
}

export function useTurnTiming(sessionId: string | null): UseTurnTimingResult {
  useEffect(() => useTurnTimingStore.getState().retain(), []);
  const registry = useTurnTimingStore((state) =>
    sessionId ? state.bySession[sessionId] : undefined
  );

  // Stable across renders that did not change THEIR map — same reason as
  // `useMessageMetadata`'s `get` (review batch F7): both feed props of the
  // memoized `ChatTurn`. Keyed on the map, not the registry, so a tool event
  // leaves `getThinking` (read by every turn) untouched.
  const byBlock = registry?.byBlock;
  const byToolCall = registry?.byToolCall;
  const getThinking = useCallback((blockId: string) => byBlock?.[blockId], [byBlock]);
  const getToolStartedAtMs = useCallback(
    (toolCallId: string) => byToolCall?.[toolCallId]?.startedAt,
    [byToolCall]
  );

  return { getThinking, getToolStartedAtMs };
}
