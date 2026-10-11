/**
 * dsh-rebase decision 176 — one `/compact` on its way: `runWithSessionStarted`
 * with its phases on `useCompactRunsStore` (the composer's status line reads
 * them) and the conversation's end honoured.
 *
 * Ending the conversation (the sidebar's 「结束对话」) while it is being started
 * cancels the compaction: Main closes it once the start is through, and the
 * compaction is not asked of what is left. Ended later, while the worker
 * summarizes, the request is cut short by the close and comes back
 * `worker_compact_interrupted` (`classifyCompactFailure`).
 */

import { useCompactRunsStore } from '@/stores/compactRuns';
import { isSessionRetired } from '@/stores/sessionRetirement';
import { onSessionEnded } from './sessionEndSignal';
import {
  runWithSessionStarted,
  type SessionStartEffects,
  type StartedOperationResult,
} from './sessionStart';
import { sessionStartEffects } from './sessionStartDeps';

export async function runCompactWhenRunning<T>(
  sessionId: string,
  operation: () => Promise<T>,
  effects: SessionStartEffects = sessionStartEffects
): Promise<StartedOperationResult<T>> {
  if (!useCompactRunsStore.getState().begin(sessionId)) {
    // The composer checks first; this is the latch two Enters cannot both pass.
    throw new Error(`compact_in_progress: Session ${sessionId} is already being compacted`);
  }
  let ended = false;
  const stopListening = onSessionEnded((endedSessionId) => {
    if (endedSessionId === sessionId) ended = true;
  });
  try {
    return await runWithSessionStarted({
      sessionId,
      operation,
      ...effects,
      onPhase: (phase) =>
        useCompactRunsStore
          .getState()
          .setPhase(sessionId, phase === 'starting' ? 'starting' : 'compacting'),
      cancelled: () => ended || isSessionRetired(sessionId),
    });
  } finally {
    stopListening();
    useCompactRunsStore.getState().end(sessionId);
  }
}
