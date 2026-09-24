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

export type CompactCommandOutcome =
  | { kind: 'compacted' }
  /** A turn is running; nothing was sent to Main. */
  | { kind: 'turn-running' }
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
    return { kind: 'failed', reason: unwrapIpcErrorMessage(error) };
  }
}
