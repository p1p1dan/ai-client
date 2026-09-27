// New in dsh-rebase P1-4a

import type { HistoryMessage, SessionHistoryPage } from '../types/sessionHistory.ts';

/** The page Main asks for when it opens a session (`readHistory(entry, 0, 80)`). */
export const HISTORY_PAGE_DEFAULT_LIMIT = 80;
/** `isWorkerHistoryPayload` refuses a larger page. */
export const HISTORY_PAGE_MAX_LIMIT = 500;

/**
 * One chronological page counted back from the newest message: `offset` newer
 * messages are skipped, then up to `limit` older ones are returned in order.
 *
 * The same algorithm as `paginatePiSessionHistory`
 * (`src/shared/legacyPiSession/timeline.ts`), kept apart because that module
 * reaches zod through `sessionFileChange.ts` and the bundled bridge may import
 * no npm package but `@deepseek-ai/dsh-llm`. `page.test.ts` pins the two
 * together.
 */
export function paginateHistory(
  messages: readonly HistoryMessage[],
  offset = 0,
  limit = HISTORY_PAGE_DEFAULT_LIMIT
): SessionHistoryPage {
  const totalCount = messages.length;
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const normalizedLimit = Number.isFinite(limit)
    ? Math.min(HISTORY_PAGE_MAX_LIMIT, Math.max(1, Math.floor(limit)))
    : HISTORY_PAGE_DEFAULT_LIMIT;
  if (normalizedOffset >= totalCount) {
    return {
      messages: [],
      offset: normalizedOffset,
      limit: normalizedLimit,
      totalCount,
      hasMore: false,
    };
  }
  const end = Math.max(0, totalCount - normalizedOffset);
  const start = Math.max(0, end - normalizedLimit);
  return {
    messages: messages.slice(start, end),
    offset: normalizedOffset,
    limit: normalizedLimit,
    totalCount,
    hasMore: start > 0,
  };
}
