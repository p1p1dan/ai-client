/**
 * `/compact` as the composer runs it locally — and what happens when it cannot.
 *
 * 2026-09-24 point-check A6/N1: typing `/compact` while a turn ran went to Main,
 * Main refused (`cannot compact the conversation while active` — compaction
 * aborts the running turn in pi, so the guard is right), the rejection escaped
 * `handleSend` as an unhandled promise, and the screen showed nothing at all
 * with `/compact ` still sitting in the input box.
 *
 * Two fixes, one module so both are testable without mounting the composer:
 *
 *  - a turn that is visibly running is answered HERE, before any IPC: the
 *    outcome is known, and asking Main only to be told no was the silent path;
 *  - any other refusal (a race with the turn's own end, no ready worker, a
 *    summary request that failed) comes back as a reason the caller shows.
 *
 * The caller keeps the typed command in the input box on every outcome except
 * success, so the user can press Enter again once the turn ends — including any
 * instructions typed after `/compact`, which clearing would have thrown away.
 */

import { unwrapIpcErrorMessage } from '@/lib/ipcError';

/**
 * dsh-rebase P1-4d2 (decision 113): the worker's refusal of `/compact <text>`
 * — DSH's `/compact` takes no instructions. Spelled here rather than imported,
 * as `SessionTreeDialog` spells its own worker code: the renderer imports only
 * types from `workerRpc`. `compactCommand.test.ts` pins it to the worker's.
 */
export const COMPACT_INSTRUCTIONS_UNSUPPORTED = 'WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED';

export type CompactCommandOutcome =
  | { kind: 'compacted' }
  /** A turn is running; nothing was sent to Main. */
  | { kind: 'turn-running' }
  /** The engine takes `/compact` alone; nothing ran, and the typed text is still there. */
  | { kind: 'instructions-unsupported' }
  /** Main or the worker refused; `reason` is their sentence, wrapper removed. */
  | { kind: 'failed'; reason: string };

export async function runCompactCommand(input: {
  /** A turn is running or stopping in this session, as the composer sees it. */
  turnRunning: boolean;
  compact: () => Promise<unknown>;
}): Promise<CompactCommandOutcome> {
  if (input.turnRunning) return { kind: 'turn-running' };
  try {
    await input.compact();
    return { kind: 'compacted' };
  } catch (error) {
    const reason = unwrapIpcErrorMessage(error);
    if (reason.includes(COMPACT_INSTRUCTIONS_UNSUPPORTED)) {
      return { kind: 'instructions-unsupported' };
    }
    return { kind: 'failed', reason };
  }
}
