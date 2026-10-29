/**
 * Chat search (stage 4): the timeline's side of a jump request — clear it when
 * the chat changes, and on every new `seq` for this chat load and reveal the
 * message it points at (`chatJumpReveal.ts`). When the key is not in the
 * timeline (live ids), it falls back to the rendered text, and failing that
 * leaves the chat open with the find bar closed.
 */
import { type RefObject, useEffect } from 'react';
import { chatJumpTargetKey, useChatJumpStore } from '@/stores/chatJump';
import {
  ensureChatMessageLoaded,
  findMessageAnchorByText,
  revealAnchor,
  revealChatMessage,
} from './chatJumpReveal';

/** The anchor may render a few frames after its page lands. */
const ANCHOR_POLL_MS = 50;
const ANCHOR_POLL_TRIES = 40;
/** The text fallback looks at what is already rendered; a short wait suffices. */
const FALLBACK_POLL_TRIES = 10;

export function useChatJumpReveal(
  sessionId: string | null,
  scrollRootRef: RefObject<HTMLElement | null>,
  onBeforeScroll: () => void
): void {
  // Switching to another chat ends the find (the find bar closes with it).
  useEffect(() => {
    const { request, clear } = useChatJumpStore.getState();
    if (request && request.sessionId !== sessionId) clear();
  }, [sessionId]);

  const seq = useChatJumpStore((state) =>
    state.request && state.request.sessionId === sessionId ? state.request.seq : null
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `seq` is the trigger; the request is read fresh
  useEffect(() => {
    if (seq === null || !sessionId) return undefined;
    const request = useChatJumpStore.getState().request;
    const key = request ? chatJumpTargetKey(request) : null;
    if (!request || !key) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const wait = () => new Promise((resolve) => setTimeout(resolve, ANCHOR_POLL_MS));
    void (async () => {
      if (await ensureChatMessageLoaded(sessionId, key, { signal })) {
        for (let attempt = 0; attempt < ANCHOR_POLL_TRIES && !signal.aborted; attempt++) {
          const root = scrollRootRef.current;
          if (root && revealChatMessage(root, key, { onBeforeScroll })) return;
          await wait();
        }
      }
      if (signal.aborted) return;
      // The key is not in this timeline: a chat that ran live in this window
      // shows live ids, not the index's `h:*` keys. Find the text instead.
      for (let attempt = 0; attempt < FALLBACK_POLL_TRIES && !signal.aborted; attempt++) {
        const root = scrollRootRef.current;
        const anchor = root && findMessageAnchorByText(root, request.query, request.index);
        if (root && anchor) {
          revealAnchor(root, anchor, { onBeforeScroll });
          return;
        }
        await wait();
      }
      // Nothing on screen says it: the chat is open, the find bar goes quietly.
      const current = useChatJumpStore.getState();
      if (!signal.aborted && current.request?.seq === seq) current.clear();
    })();
    return () => controller.abort();
  }, [seq, sessionId]);
}
