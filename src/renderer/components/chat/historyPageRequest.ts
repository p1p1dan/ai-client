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

/**
 * Ask for one older page and let the answer arrive as a `session.history`
 * event, exactly as before. Rejects with whatever the serving channel rejected
 * with, so both call sites keep the error handling they already have.
 *
 * `hostBound` is the renderer's belief about this session, which can be stale
 * in one direction: a worker may have come up since. Main is the authority and
 * says `worker_active` in that case, which is the one failure worth retrying on
 * the other channel — any other failure is about the file, and asking a worker
 * that does not exist would only replace a precise error with a vague one.
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
    await fromWorker();
    return;
  }
  try {
    await window.electronAPI.chat.readSessionPage({ sessionId, offset, limit });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('worker_active')) throw error;
    await fromWorker();
  }
}
