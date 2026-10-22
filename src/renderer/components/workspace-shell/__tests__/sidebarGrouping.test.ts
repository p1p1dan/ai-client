/**
 * Layout 5b (ruling L2): the sidebar's 「按状态」 / 「按时间」 buckets.
 */
import { describe, expect, it } from 'vitest';
import { bucketSessions, dateBucketOf, statusBucketOf } from '../sidebar/sidebarGrouping';

const NONE = new Set<string>();

/** A Wednesday, 15:00 local time. */
const NOW = new Date(2026, 9, 21, 15, 0, 0).getTime();
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour, 0, 0).getTime();

describe('statusBucketOf', () => {
  it('puts a turn parked on the user in 等你处理, ahead of running', () => {
    expect(statusBucketOf({ id: 'a', status: 'waiting_permission' }, NONE)).toBe('waiting');
    expect(statusBucketOf({ id: 'a', status: 'waiting_question' }, NONE)).toBe('waiting');
  });

  it('counts a pending approval as waiting even before the status catches up', () => {
    expect(statusBucketOf({ id: 'a', status: 'running' }, new Set(['a']))).toBe('waiting');
    expect(statusBucketOf({ id: 'a', status: 'idle' }, new Set(['a']))).toBe('waiting');
  });

  it('busy statuses run; everything else is done', () => {
    for (const status of ['starting', 'running', 'stopping'] as const) {
      expect(statusBucketOf({ id: 'a', status }, NONE)).toBe('running');
    }
    for (const status of ['idle', 'failed'] as const) {
      expect(statusBucketOf({ id: 'a', status }, NONE)).toBe('done');
    }
  });
});

describe('dateBucketOf', () => {
  it('splits by local calendar day', () => {
    expect(dateBucketOf(at(21, 0), NOW)).toBe('today');
    expect(dateBucketOf(at(20, 23), NOW)).toBe('yesterday');
    expect(dateBucketOf(at(20, 0), NOW)).toBe('yesterday');
  });

  it('本周 starts on Monday and holds what is older than yesterday', () => {
    // Monday the 19th is this week; Sunday the 18th is not.
    expect(dateBucketOf(at(19, 9), NOW)).toBe('week');
    expect(dateBucketOf(at(18, 23), NOW)).toBe('earlier');
  });

  it('on a Monday, yesterday (Sunday) is 昨天 and 本周 is empty', () => {
    const monday = new Date(2026, 9, 19, 10).getTime();
    expect(dateBucketOf(at(18, 10), monday)).toBe('yesterday');
    expect(dateBucketOf(at(17, 10), monday)).toBe('earlier');
  });

  it('reads a timestamp from the future (clock skew) as today', () => {
    expect(dateBucketOf(NOW + 86_400_000, NOW)).toBe('today');
  });
});

describe('bucketSessions', () => {
  const sessions = [
    { id: 'idle-old', status: 'idle' as const, updatedAt: at(1) },
    { id: 'run', status: 'running' as const, updatedAt: at(21) },
    { id: 'ask', status: 'waiting_question' as const, updatedAt: at(20) },
    { id: 'fail', status: 'failed' as const, updatedAt: at(21) },
  ];

  it('by status: fixed order, empty buckets dropped, prefixed ids', () => {
    const buckets = bucketSessions(sessions, 'status', {
      now: NOW,
      pendingApprovalSessionIds: NONE,
    });
    expect(buckets.map((bucket) => bucket.id)).toEqual([
      'status:running',
      'status:waiting',
      'status:done',
    ]);
    expect(buckets.map((bucket) => bucket.label)).toEqual([
      'Running',
      'Waiting for you',
      'Recently finished',
    ]);
    expect(buckets[2]?.sessions.map((session) => session.id)).toEqual(['idle-old', 'fail']);

    const idleOnly = bucketSessions([sessions[0]!], 'status', {
      now: NOW,
      pendingApprovalSessionIds: NONE,
    });
    expect(idleOnly.map((bucket) => bucket.id)).toEqual(['status:done']);
  });

  it('by date: today, yesterday, this week, earlier — only those with chats', () => {
    const buckets = bucketSessions(sessions, 'date', { now: NOW, pendingApprovalSessionIds: NONE });
    expect(buckets.map((bucket) => bucket.id)).toEqual([
      'date:today',
      'date:yesterday',
      'date:earlier',
    ]);
    expect(buckets[0]?.sessions.map((session) => session.id)).toEqual(['run', 'fail']);
  });

  it('every session lands in exactly one bucket', () => {
    for (const mode of ['status', 'date'] as const) {
      const ids = bucketSessions(sessions, mode, { now: NOW, pendingApprovalSessionIds: NONE })
        .flatMap((bucket) => bucket.sessions.map((session) => session.id))
        .sort();
      expect(ids).toEqual(sessions.map((session) => session.id).sort());
    }
  });
});
