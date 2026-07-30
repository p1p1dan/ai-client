/**
 * T-19 idle-release effect — the only place besides ChatComposer's own send
 * handlers allowed to call `takeHead`/`restoreHead` on the message queue
 * store. Contains no judgment of its own: `decideQueueRelease` in
 * `queueRelease.ts` decides WHETHER to release, this hook only acts on that
 * decision (design decision 3.1/3.3 — "无变化返回同引用" reducers make the
 * effect naturally converge without a manual loop).
 *
 * Scoped to the ACTIVE session only — see `queueRelease.ts`'s header for why
 * this intentionally does not drive background sessions' queues (T-19b).
 */

import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { useEffect, useRef } from 'react';
import { useMessageQueueStore } from '@/stores/messageQueue';
import { type QueuedMessage, selectSessionQueue } from './messageQueue';
import { decideQueueRelease } from './queueRelease';

export interface UseQueueReleaseInput {
  sessionId: string | null;
  hasTarget: boolean;
  disabled: boolean;
  sending: boolean;
  /** Read fresh when the effect runs — the synchronous `inFlightRef.current`
   *  latch, never React state (which lags a render behind). */
  isInFlight: () => boolean;
  status: SessionRuntimeStatus;
  /** Runs the queued entry through the SAME guards as a live send (decision
   *  3.3's consistency guarantee) — e.g. `(entry) => runSend(entry.text, entry.attachments)`. */
  runEntry: (entry: QueuedMessage) => Promise<'committed' | 'skipped'>;
}

export function useQueueRelease(input: UseQueueReleaseInput): void {
  const { sessionId, hasTarget, disabled, sending, isInFlight, status, runEntry } = input;
  const queue = useMessageQueueStore((state) => selectSessionQueue(state.state, sessionId));
  // M5 fix: a latch this hook owns and closes SYNCHRONOUSLY before `takeHead`
  // — not borrowed from `runSend`'s `inFlightRef` (a cross-module side
  // effect this hook has no contract with). `decideQueueRelease` is
  // currently strictly stronger than `runSend`'s own guard, so the gap this
  // closes is dormant today, but it is exactly the gap React 18 StrictMode's
  // double-invoked mount effect would fall into on the 'skipped' branch
  // (`runSend`'s own latch never closes on that path, so a second effect run
  // reading a stale `queue` closure would `takeHead` a SECOND entry and
  // reorder the queue when it restores). Cleared in the `.then()`, which
  // covers both the 'committed' and 'skipped' outcomes.
  const releasingRef = useRef(false);

  useEffect(() => {
    if (sessionId == null) return;
    if (releasingRef.current) return;
    const decision = decideQueueRelease({
      sessionId,
      entries: queue.entries,
      paused: queue.paused,
      hasTarget,
      disabled,
      sending,
      inFlight: isInFlight(),
      status,
    });
    if (decision.type !== 'release') return;

    releasingRef.current = true;
    const entry = useMessageQueueStore.getState().takeHead(sessionId);
    if (!entry) {
      // raced away (e.g. removed via the strip) — nothing to release
      releasingRef.current = false;
      return;
    }
    void runEntry(entry).then((result) => {
      releasingRef.current = false;
      // Never swallow: a guard-fail inside runEntry puts the entry right
      // back at the front of the queue instead of dropping it.
      if (result === 'skipped') {
        useMessageQueueStore.getState().restoreHead(entry);
      }
    });
  }, [sessionId, queue, hasTarget, disabled, sending, status, isInFlight, runEntry]);
}
