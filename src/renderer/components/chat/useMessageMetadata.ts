import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { useEffect, useState } from 'react';
import {
  initialMetadataRegistry,
  type MessageMetadata,
  type MetadataRegistry,
  reduceMessageMetadata,
} from './messageMetadata';
import { defaultModelId } from './models';
import { useSessionModel } from './useSessionModel';

/**
 * Team-side metadata registry surface (T-06): subscribe to Runtime Events and
 * return a per-message metadata lookup. Stamps each new assistant metadata
 * entry with the session-bound model id from `useSessionModel` so the timeline
 * can show "Sonnet · 1.2s · 10:30" without touching the red-line store.
 *
 * Subscribes once per mount; ChatWorkspace drives a single instance per
 * active session. Returning a stable `get` keeps timeline rows cheap.
 */

export interface UseMessageMetadataResult {
  get: (messageId: string) => MessageMetadata | undefined;
}

export function useMessageMetadata(sessionId: string | null): UseMessageMetadataResult {
  const { getSessionModel } = useSessionModel();
  const [registry, setRegistry] = useState<MetadataRegistry>(initialMetadataRegistry);

  useEffect(() => {
    if (!sessionId) {
      setRegistry(initialMetadataRegistry);
      return () => undefined;
    }
    let cancelled = false;
    const unsubscribe = window.electronAPI.chat.onRuntimeEvent((event: RuntimeEvent) => {
      if (cancelled) return;
      if (event.sessionId && event.sessionId !== sessionId) return;
      // T-30 P-14: ComposerModelTrigger's (formerly ModelSelect) initial value
      // never gets persisted until the user actually changes the dropdown (it
      // only calls `setSessionModel` from `onValueChange`), so an untouched
      // session's `getSessionModel` stays null forever and the meta line
      // silently drops the model segment. Fall back to the same catalog
      // default ComposerModelTrigger itself renders, mirroring ChatComposer's
      // own `?? defaultModelId(null)` guard.
      const sessionModel = getSessionModel(sessionId) ?? defaultModelId(null);
      setRegistry((prev) => reduceMessageMetadata(prev, event, sessionModel));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId, getSessionModel]);

  return {
    get: (messageId: string) => registry.byMessage[messageId],
  };
}
