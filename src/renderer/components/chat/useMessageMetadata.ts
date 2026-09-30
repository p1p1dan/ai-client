import { useCallback, useEffect, useRef } from 'react';
import { useMessageMetadataStore } from '@/stores/messageMetadataRegistry';
import type { MessageMetadata } from './messageMetadata';
import { useResolvedSessionModel } from './useResolvedSessionModel';

/**
 * Team-side metadata registry surface (T-06): a per-message metadata lookup
 * folded from Runtime Events, without touching the red-line store. Each new
 * assistant entry is stamped with the session-bound model (the event's own
 * model wins) so the timeline can show "Sonnet · 1.2s · 10:30".
 *
 * dsh-rebase P1-7e (problem 16, decision 139): the registry itself lives in
 * `stores/messageMetadataRegistry.ts` for the whole run, fed for every chat by
 * one listener. This hook only holds that listener while it is mounted and
 * reads its chat's registry, so a timeline that remounts (the start screen in
 * between, a chat the pool reclaimed) finds the stamps it had.
 */

export interface UseMessageMetadataResult {
  get: (messageId: string) => MessageMetadata | undefined;
}

export function useMessageMetadata(sessionId: string | null): UseMessageMetadataResult {
  const resolveSessionModel = useResolvedSessionModel();
  // Held through a ref so the listener is retained once per mount, not once
  // per render of a caller whose resolver is not memoized.
  const resolveRef = useRef(resolveSessionModel);
  resolveRef.current = resolveSessionModel;
  useEffect(() => useMessageMetadataStore.getState().retain((id) => resolveRef.current(id)), []);
  const registry = useMessageMetadataStore((state) =>
    sessionId ? state.bySession[sessionId] : undefined
  );

  // Stable across renders that did not change this chat's registry (review
  // batch F7): this lookup is a prop of the memoized `ChatTurn`, so a fresh
  // closure per render would defeat the memo and put every turn in the session
  // back on the one-second re-render path the clock ticks.
  const get = useCallback((messageId: string) => registry?.byMessage[messageId], [registry]);

  return { get };
}
