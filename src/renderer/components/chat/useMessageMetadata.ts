import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { useCallback, useEffect, useState } from 'react';
import { subscribeRuntimeEvent } from '@/stores/runtimeEventBus';
import {
  initialMetadataRegistry,
  type MessageMetadata,
  type MetadataRegistry,
  reduceMessageMetadata,
} from './messageMetadata';
import { useResolvedSessionModel } from './useResolvedSessionModel';

/**
 * Team-side metadata registry surface (T-06): subscribe to Runtime Events and
 * return a per-message metadata lookup. Stamps each new assistant metadata
 * entry with the session-bound model id resolved by `useResolvedSessionModel`
 * so the timeline can show "Sonnet · 1.2s · 10:30" without touching the
 * red-line store.
 *
 * Subscribes once per mount; ChatWorkspace drives a single instance per
 * active session. Returning a stable `get` keeps timeline rows cheap.
 */

export interface UseMessageMetadataResult {
  get: (messageId: string) => MessageMetadata | undefined;
}

export function useMessageMetadata(sessionId: string | null): UseMessageMetadataResult {
  const resolveSessionModel = useResolvedSessionModel();
  const [registry, setRegistry] = useState<MetadataRegistry>(initialMetadataRegistry);

  useEffect(() => {
    if (!sessionId) {
      setRegistry(initialMetadataRegistry);
      return () => undefined;
    }
    let cancelled = false;
    const unsubscribe = subscribeRuntimeEvent((event: RuntimeEvent) => {
      if (cancelled) return;
      if (event.sessionId && event.sessionId !== sessionId) return;
      // T-30 P-14 revisited for D48 S2: the trigger still only persists on an
      // explicit pick, so an untouched session resolves to `undefined` here —
      // and that is now the RIGHT answer rather than a gap to paper over. The
      // old code substituted the catalog default (`sonnet`), which stamped every
      // untouched session's meta line with a model nobody selected and the wire
      // never carried. `null` means "we did not pin one", and the reducer
      // already prefers the Host's own reported model over this value anyway.
      const sessionModel = resolveSessionModel(sessionId) ?? null;
      setRegistry((prev) => reduceMessageMetadata(prev, event, sessionModel));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId, resolveSessionModel]);

  // Stable across renders that did not change the registry (review batch F7):
  // this lookup is a prop of the memoized `ChatTurn`, so a fresh closure per
  // render would defeat the memo and put every turn in the session back on the
  // one-second re-render path the clock ticks.
  const get = useCallback((messageId: string) => registry.byMessage[messageId], [registry]);

  return { get };
}
