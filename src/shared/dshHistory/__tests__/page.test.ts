import { describe, expect, it } from 'vitest';
import { paginatePiSessionHistory } from '../../legacyPiSession/timeline.ts';
import type { HistoryMessage } from '../../types/sessionHistory.ts';
import { paginateHistory } from '../page.ts';

/**
 * dsh-rebase P1-4a — DSH history pages exactly as pi history pages. The
 * algorithm is kept apart from `legacyPiSession/timeline.ts` only because that
 * module reaches zod, which the bundled bridge may not import; this pins the
 * two copies together.
 */

function messages(count: number): HistoryMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `h:m${index}` as const,
    role: 'user' as const,
    blocks: [],
  }));
}

describe('paginateHistory', () => {
  const counts = [0, 1, 79, 80, 81, 250];
  const offsets = [undefined, 0, 1, 79, 80, 200, 300, -5, 2.7, Number.NaN];
  const limits = [undefined, 1, 5, 80, 499, 500, 501, 0, -1, 3.9, Number.NaN];

  it('pages every (count, offset, limit) the way the pi projection does', () => {
    for (const count of counts) {
      const all = messages(count);
      for (const offset of offsets) {
        for (const limit of limits) {
          expect(paginateHistory(all, offset, limit)).toEqual(
            paginatePiSessionHistory(all, offset, limit)
          );
        }
      }
    }
  });

  it('counts back from the newest message', () => {
    const page = paginateHistory(messages(5), 1, 2);
    expect(page).toEqual({
      messages: [
        { id: 'h:m2', role: 'user', blocks: [] },
        { id: 'h:m3', role: 'user', blocks: [] },
      ],
      offset: 1,
      limit: 2,
      totalCount: 5,
      hasMore: true,
    });
  });
});
