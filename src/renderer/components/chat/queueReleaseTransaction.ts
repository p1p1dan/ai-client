import type { QueuedMessage } from './messageQueue';
import { isAdmittedOutcome, type RunEntryOutcome } from './queueRelease';

export interface QueueReleaseOperations {
  takeHead: (sessionId: string) => QueuedMessage | null;
  restoreHead: (entry: QueuedMessage) => void;
  pauseRejected: (sessionId: string) => void;
  runEntry: (entry: QueuedMessage) => Promise<RunEntryOutcome>;
}

export type QueueReleaseTransactionResult =
  | { type: 'empty' }
  | { type: 'admitted'; entry: QueuedMessage; outcome: 'committed' | 'pending' }
  | { type: 'restored'; entry: QueuedMessage; outcome: 'skipped' | 'rejected' | 'thrown' };

/**
 * Owns the asynchronous pop → run → restore transaction outside React.
 *
 * The store reducer makes restore a no-op after lifecycle pruning, so an
 * Archive/repository removal that wins while `runEntry` is pending cannot be
 * undone here. Evidence-free Host rejection and unexpected throws also pause
 * the queue before the hook may render again, preventing restore/re-release
 * loops. A transient guard skip is restored without a pause; the runtime gates
 * that caused it are expected to settle on the next render.
 */
export async function releaseQueueHead(
  sessionId: string,
  operations: QueueReleaseOperations
): Promise<QueueReleaseTransactionResult> {
  const entry = operations.takeHead(sessionId);
  if (!entry) return { type: 'empty' };

  try {
    const outcome = await operations.runEntry(entry);
    if (isAdmittedOutcome(outcome)) {
      return { type: 'admitted', entry, outcome };
    }
    operations.restoreHead(entry);
    if (outcome === 'rejected') operations.pauseRejected(sessionId);
    return { type: 'restored', entry, outcome };
  } catch {
    operations.restoreHead(entry);
    operations.pauseRejected(sessionId);
    return { type: 'restored', entry, outcome: 'thrown' };
  }
}
