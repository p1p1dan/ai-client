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
import { decideQueueRelease, isAdmittedOutcome, type RunEntryOutcome } from './queueRelease';

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
  runEntry: (entry: QueuedMessage) => Promise<RunEntryOutcome>;
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
  // reorder the queue when it restores). Cleared in the `.finally()` below,
  // which covers every outcome — 'committed'/'skipped'/'rejected' AND an
  // unexpected rejection.
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
    // Round-2 P0 fix: `takeHead` above already popped the entry — from this
    // point on ANY unexpected outcome (a rejection thrown before runEntry's
    // own try/catch, e.g. toWireAttachments/onSendStart) must not silently
    // drop it. `.catch` restores it exactly like a 'skipped'/'rejected'
    // result would, and `.finally` is the only place that reliably clears
    // the latch — a `.then`-only reset never runs on a rejection, which used
    // to freeze this session's queue forever.
    void runEntry(entry)
      .then((result: RunEntryOutcome) => {
        // Never swallow: a guard-fail inside runEntry ('skipped'), or a turn
        // the Host flatly refused to admit ('rejected' — no echo, no turn
        // started), puts the entry right back at the front of the queue
        // instead of dropping it.
        //
        // F2 (§4.3 consumption point 5): asked as "was this turn ADMITTED?"
        // rather than as a list of the two names that happen to mean "no"
        // today. Behaviour is identical for the three pre-existing outcomes;
        // what changes is that `'pending'` — a turn the Host took and is still
        // running, which this renderer merely stopped waiting for — is
        // STRUCTURALLY excluded from requeueing, instead of being excluded by
        // the accident of not appearing in a name list. Requeueing it would
        // release the identical text as a second turn while the first is still
        // in flight.
        if (!isAdmittedOutcome(result)) {
          useMessageQueueStore.getState().restoreHead(entry);
        }
      })
      .catch(() => {
        useMessageQueueStore.getState().restoreHead(entry);
      })
      .finally(() => {
        releasingRef.current = false;
      });
  }, [sessionId, queue, hasTarget, disabled, sending, status, isInFlight, runEntry]);
}
