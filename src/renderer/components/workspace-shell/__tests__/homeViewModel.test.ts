import { describe, expect, it } from 'vitest';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import {
  deriveHomeRecentRows,
  groupHomeRows,
  HOME_RECENT_BATCH,
  HOME_RECENT_LIMIT,
  homeDayGroup,
  limitHomeRows,
  nextHomeRowsShown,
} from '../homeViewModel';

/**
 * Decision 174 (GitHub issue #6, second wave; user rulings 2026-10-10): the
 * home page's 「最近对话」 — every conversation, five rows and 「查看更多（N）」,
 * ungrouped while five, 今天 / 昨天 / 更早 once expanded.
 */

const workspaces: ChatWorkspace[] = [
  { id: 'ws-a', projectId: 'p-a', name: 'Main', kind: 'main', path: '/repo/a', branch: 'main' },
];

function chat(id: string, updatedAt: number, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'p-a',
    workspaceId: 'ws-a',
    title: id,
    status: 'idle',
    updatedAt,
    ...extra,
  };
}

const NOW = new Date(2026, 9, 10, 15, 0, 0).getTime();
const HOUR = 3_600_000;

describe('deriveHomeRecentRows', () => {
  it('lists every conversation the sidebar lists — repository and temporary — newest first', () => {
    const rows = deriveHomeRecentRows({
      sessions: [
        chat('old', 1),
        chat('temp', 3, { projectId: '', workspaceId: '' }),
        chat('new', 5),
        chat('orphan', 9, { workspaceId: 'ws-gone' }),
      ],
      workspaces,
    });
    expect(rows.map((row) => row.sessionId)).toEqual(['new', 'temp', 'old']);
    expect(rows.find((row) => row.sessionId === 'temp')?.unbound).toBe(true);
  });
});

describe('limitHomeRows / nextHomeRowsShown', () => {
  const rows = deriveHomeRecentRows({
    sessions: Array.from({ length: 12 }, (_, index) => chat(`c${index}`, 100 - index)),
    workspaces,
  });

  it('shows five rows, the rest behind 「查看更多（N）」', () => {
    expect(HOME_RECENT_LIMIT).toBe(5);
    const limited = limitHomeRows(rows, HOME_RECENT_LIMIT);
    expect(limited.rows.map((row) => row.sessionId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(limited.hiddenCount).toBe(7);
    expect(limited.collapsible).toBe(false);
  });

  it('one press shows the rest when they fit in a batch, then 「收起」', () => {
    const limited = limitHomeRows(rows, nextHomeRowsShown(HOME_RECENT_LIMIT));
    expect(limited.rows).toHaveLength(12);
    expect(limited.hiddenCount).toBe(0);
    expect(limited.collapsible).toBe(true);
  });

  it('a long history comes in batches', () => {
    const many = deriveHomeRecentRows({
      sessions: Array.from({ length: 250 }, (_, index) => chat(`m${index}`, 1000 - index)),
      workspaces,
    });
    const once = limitHomeRows(many, nextHomeRowsShown(HOME_RECENT_LIMIT));
    expect(once.rows).toHaveLength(HOME_RECENT_LIMIT + HOME_RECENT_BATCH);
    expect(once.hiddenCount).toBe(250 - HOME_RECENT_LIMIT - HOME_RECENT_BATCH);
    expect(once.collapsible).toBe(true);
  });

  it('five or fewer: no 「查看更多」, no 「收起」', () => {
    const few = limitHomeRows(rows.slice(0, 5), HOME_RECENT_LIMIT);
    expect(few.hiddenCount).toBe(0);
    expect(few.collapsible).toBe(false);
  });
});

describe('homeDayGroup / groupHomeRows', () => {
  it('reads the local calendar day', () => {
    expect(homeDayGroup(NOW - HOUR, NOW)).toBe('today');
    expect(homeDayGroup(new Date(2026, 9, 9, 23, 59).getTime(), NOW)).toBe('yesterday');
    expect(homeDayGroup(new Date(2026, 9, 8, 12, 0).getTime(), NOW)).toBe('earlier');
  });

  const rows = deriveHomeRecentRows({
    sessions: [
      chat('t1', NOW - HOUR),
      chat('t2', NOW - 2 * HOUR),
      chat('y1', new Date(2026, 9, 9, 10, 0).getTime()),
      chat('e1', new Date(2026, 8, 1, 10, 0).getTime()),
    ],
    workspaces,
  });

  it('five rows are not grouped', () => {
    expect(groupHomeRows(rows, false, NOW)).toEqual([{ group: null, rows }]);
  });

  it('the expanded list is grouped today / yesterday / earlier, in that order', () => {
    expect(
      groupHomeRows(rows, true, NOW).map((group) => [
        group.group,
        group.rows.map((row) => row.sessionId),
      ])
    ).toEqual([
      ['today', ['t1', 't2']],
      ['yesterday', ['y1']],
      ['earlier', ['e1']],
    ]);
  });

  it('nothing to list is no group at all', () => {
    expect(groupHomeRows([], false, NOW)).toEqual([]);
  });
});
