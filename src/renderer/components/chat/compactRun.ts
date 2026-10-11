/**
 * dsh-rebase decision 176 — one `/compact` on its way: `runWithSessionStarted`
 * with its phases on `useCompactRunsStore` and the conversation's end
 * honoured.
 *
 * Ending the conversation (the sidebar's 「结束对话」) while it is being started
 * cancels the compaction: Main closes it once the start is through, and the
 * compaction is not asked of what is left. Ended later, while the worker
 * summarizes, the request is cut short by the close and comes back
 * `worker_compact_interrupted` (`classifyCompactFailure`).
 *
 * Decision 180: the run shows in the timeline from the moment it begins —
 * its command line, then its running row, which says 「正在启动对话…」 while
 * the conversation is started and 「正在压缩上下文…」 after — and Esc or Stop
 * cancels it (`cancelCompactRun`): while the conversation is being started
 * the compaction is simply not asked for; while it compacts, Main is asked to
 * cut it short, again until the answer says so or the run is over (the
 * cancel may reach Main before the compaction does).
 */

import { DSH_COMPACT_STARTING_KEY, DSH_COMPACTION_RUNNING_KEY } from '@shared/dshHistory/types';
import { setCompactRunKey, showCompactRun } from '@/stores/chatSessionActions';
import { selectCompactPhase, useCompactRunsStore } from '@/stores/compactRuns';
import { isSessionRetired } from '@/stores/sessionRetirement';
import { onSessionEnded } from './sessionEndSignal';
import {
  runWithSessionStarted,
  type SessionStartEffects,
  type StartedOperationResult,
} from './sessionStart';
import { sessionStartEffects } from './sessionStartDeps';

/** Decision 180: the run's two rows, under ids of the run's own until the bridge names them. */
export interface CompactRunRows {
  runId: string;
  /** The command line as typed: `/compact` and its instructions. */
  command: string;
}

/** Decision 180: what came of a run, beside the operation's own result. */
export type CompactRunResult<T> = StartedOperationResult<T> & {
  /** Esc or Stop asked for the cancel while it ran. */
  cancelRequested?: true;
};

let runSequence = 0;

/** A fresh id for a run's rows. */
export function nextCompactRunId(): string {
  runSequence += 1;
  return `${Date.now().toString(36)}-${runSequence}`;
}

export async function runCompactWhenRunning<T>(
  sessionId: string,
  operation: () => Promise<T>,
  effects: SessionStartEffects = sessionStartEffects,
  rows?: CompactRunRows
): Promise<CompactRunResult<T>> {
  const startsFirst = !effects.isRunning(sessionId);
  if (!useCompactRunsStore.getState().begin(sessionId, startsFirst ? 'starting' : 'compacting')) {
    // The composer checks first; this is the latch two Enters cannot both pass.
    throw new Error(`compact_in_progress: Session ${sessionId} is already being compacted`);
  }
  if (rows) {
    showCompactRun(
      sessionId,
      rows.runId,
      rows.command,
      startsFirst ? DSH_COMPACT_STARTING_KEY : DSH_COMPACTION_RUNNING_KEY
    );
  }
  let ended = false;
  const stopListening = onSessionEnded((endedSessionId) => {
    if (endedSessionId === sessionId) ended = true;
  });
  const cancelRequested = () => useCompactRunsStore.getState().cancelling[sessionId] === true;
  try {
    const result = await runWithSessionStarted({
      sessionId,
      operation,
      ...effects,
      onPhase: (phase) => {
        const next = phase === 'starting' ? 'starting' : 'compacting';
        useCompactRunsStore.getState().setPhase(sessionId, next);
        if (rows) {
          setCompactRunKey(
            sessionId,
            rows.runId,
            next === 'starting' ? DSH_COMPACT_STARTING_KEY : DSH_COMPACTION_RUNNING_KEY
          );
        }
      },
      cancelled: () => ended || cancelRequested() || isSessionRetired(sessionId),
    });
    return cancelRequested() ? { ...result, cancelRequested: true } : result;
  } finally {
    stopListening();
    useCompactRunsStore.getState().end(sessionId);
  }
}

/** How often, and how many times, a cancel that found no compaction with Main is asked again. */
const CANCEL_RETRY_MS = 250;
const CANCEL_RETRIES = 40;

/**
 * Decision 180: Esc or Stop on this window's `/compact` for `sessionId`.
 * `false` when none is on its way. While the conversation is being started
 * nothing is asked of Main: the compaction is not asked for at all
 * (`runCompactWhenRunning`'s `cancelled`).
 */
export function cancelCompactRun(
  sessionId: string,
  cancel: (sessionId: string) => Promise<{ cancelled: boolean }> = (id) =>
    window.electronAPI.chat.cancelCompact({ sessionId: id })
): boolean {
  const store = useCompactRunsStore.getState();
  if (selectCompactPhase(store, sessionId) === undefined) return false;
  if (!store.requestCancel(sessionId)) return true;
  void askToCancel(sessionId, cancel);
  return true;
}

async function askToCancel(
  sessionId: string,
  cancel: (sessionId: string) => Promise<{ cancelled: boolean }>
): Promise<void> {
  for (let attempt = 0; attempt < CANCEL_RETRIES; attempt += 1) {
    const phase = selectCompactPhase(useCompactRunsStore.getState(), sessionId);
    // Over, or not with Main yet: the start's own check takes care of it.
    if (phase === undefined) return;
    if (phase === 'compacting') {
      try {
        if ((await cancel(sessionId)).cancelled) return;
      } catch (error) {
        console.warn('[compact] the cancel did not reach the engine:', error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, CANCEL_RETRY_MS));
  }
}
