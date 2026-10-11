/**
 * T102 (decision 030) — which channel serves one "load older" click.
 *
 * Paging used to have exactly one answer, `chat:loadHistoryPage`, which asks a
 * live worker and refuses with `session_not_found` when there is none. That was
 * sound while the only way to see a transcript was to resume it. Since T102 a
 * session can be on screen with no worker behind it at all, so the first page
 * and every older page have to be able to come off the file.
 *
 * Shared by the two call sites (`MessageTimeline`, `SessionReviewPanel`) rather
 * than written twice: they ask the same question, and a second copy would be
 * the one that keeps asking the worker.
 */

import { isSessionNotRunningError } from './sessionStart';

/**
 * Ask for one older page and let the answer arrive as a `session.history`
 * event, exactly as before. Rejects with whatever the serving channel rejected
 * with, so both call sites keep the error handling they already have.
 *
 * `hostBound` is the renderer's belief about this session, which can be stale
 * in either direction. A worker may have come up since: Main says
 * `worker_active`, which is the one file failure worth retrying on the other
 * channel — any other is about the file, and asking a worker that does not
 * exist would only replace a precise error with a vague one. Or the worker
 * went (a reclaim this window missed): Main says `session_not_found`, and the
 * file serves the page, as for any chat not running (decision 176; it used to
 * become a 「读取历史失败」 card quoting Main's "No ready Pi WorkerSlot").
 */
export async function loadOlderHistoryPage(input: {
  sessionId: string;
  offset: number;
  limit?: number;
  hostBound: boolean;
}): Promise<void> {
  const { sessionId, offset, limit = 80, hostBound } = input;
  const fromWorker = () => window.electronAPI.chat.loadHistoryPage({ sessionId, offset, limit });
  if (hostBound) {
    try {
      await fromWorker();
      return;
    } catch (error) {
      if (!isSessionNotRunningError(error)) throw error;
    }
  }
  try {
    await window.electronAPI.chat.readSessionPage({ sessionId, offset, limit });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('worker_active')) throw error;
    await fromWorker();
  }
}
