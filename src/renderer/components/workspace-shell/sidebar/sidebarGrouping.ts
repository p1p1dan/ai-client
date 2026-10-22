/**
 * Layout 5b (ui-cohesion §6, ruling L2): the sidebar's derived groupings — by
 * status and by date. Pure, so the buckets are covered without a DOM (F10:
 * nothing here reads layout).
 *
 * 「按仓库」 and 「按分组」 are not here: they are the repository tree
 * (`buildSidebarFolders`) and the user's own groups (`buildGroupFolder` over
 * `useSidebarArchiveStore`). These two file nothing — a chat moves between
 * buckets on its own as it runs, waits or ages.
 */
import type { ChatSession } from '@/stores/chatSessions';
import { isBusySessionStatus, isWaitingSessionStatus } from '../sidebarTree';

export type StatusBucket = 'running' | 'waiting' | 'done';
export type DateBucket = 'today' | 'yesterday' | 'week' | 'earlier';

/** Fixed order, most urgent first (the ruling's 运行中、等你处理、最近完成). */
export const STATUS_BUCKETS: readonly StatusBucket[] = ['running', 'waiting', 'done'];
export const DATE_BUCKETS: readonly DateBucket[] = ['today', 'yesterday', 'week', 'earlier'];

/** Display names (dictionary keys; the caller translates). */
export const STATUS_BUCKET_LABELS: Readonly<Record<StatusBucket, string>> = {
  running: 'Running',
  waiting: 'Waiting for you',
  done: 'Recently finished',
};
export const DATE_BUCKET_LABELS: Readonly<Record<DateBucket, string>> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  earlier: 'Earlier',
};

/**
 * Bucket ids double as fold keys and nav keys, so they are prefixed to stay
 * clear of project and group ids.
 */
export const statusBucketId = (bucket: StatusBucket) => `status:${bucket}`;
export const dateBucketId = (bucket: DateBucket) => `date:${bucket}`;

/**
 * Waiting outranks running: a turn parked on an approval or a question is
 * busy too, but the next move is the user's. A pending approval counts even
 * when the status has not caught up yet — the permission card is the truth.
 */
export function statusBucketOf(
  session: Pick<ChatSession, 'id' | 'status'>,
  pendingApprovalSessionIds: ReadonlySet<string>
): StatusBucket {
  if (isWaitingSessionStatus(session.status) || pendingApprovalSessionIds.has(session.id)) {
    return 'waiting';
  }
  if (isBusySessionStatus(session.status)) return 'running';
  return 'done';
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Calendar buckets in local time. 「本周」 starts on Monday (the zh
 * convention) and holds what is older than yesterday; early in the week it is
 * simply empty. Clock skew (an `updatedAt` in the future) reads as today.
 */
export function dateBucketOf(updatedAt: number, now: number): DateBucket {
  const today = startOfLocalDay(now);
  if (updatedAt >= today) return 'today';
  const yesterdayDate = new Date(today);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = yesterdayDate.getTime();
  if (updatedAt >= yesterday) return 'yesterday';
  const weekStartDate = new Date(today);
  // getDay(): 0 = Sunday … 6 = Saturday; days since Monday.
  weekStartDate.setDate(weekStartDate.getDate() - ((weekStartDate.getDay() + 6) % 7));
  if (updatedAt >= weekStartDate.getTime()) return 'week';
  return 'earlier';
}

export interface SessionBucket<T> {
  /** `statusBucketId` / `dateBucketId`. */
  id: string;
  /** Dictionary key of the heading. */
  label: string;
  sessions: T[];
}

/**
 * The sessions of `mode`'s buckets in their fixed order. Empty buckets are
 * dropped: unlike a repository or a user group there is nothing to do on an
 * empty 「昨天」. Session order inside a bucket is left to the row builder
 * (`buildGroupFolder` sorts by `updatedAt`).
 */
export function bucketSessions<T extends Pick<ChatSession, 'id' | 'status' | 'updatedAt'>>(
  sessions: readonly T[],
  mode: 'status' | 'date',
  options: { now: number; pendingApprovalSessionIds: ReadonlySet<string> }
): SessionBucket<T>[] {
  if (mode === 'status') {
    const byBucket = new Map<StatusBucket, T[]>();
    for (const session of sessions) {
      const bucket = statusBucketOf(session, options.pendingApprovalSessionIds);
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), session]);
    }
    return STATUS_BUCKETS.filter((bucket) => byBucket.has(bucket)).map((bucket) => ({
      id: statusBucketId(bucket),
      label: STATUS_BUCKET_LABELS[bucket],
      sessions: byBucket.get(bucket) ?? [],
    }));
  }
  const byBucket = new Map<DateBucket, T[]>();
  for (const session of sessions) {
    const bucket = dateBucketOf(session.updatedAt, options.now);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), session]);
  }
  return DATE_BUCKETS.filter((bucket) => byBucket.has(bucket)).map((bucket) => ({
    id: dateBucketId(bucket),
    label: DATE_BUCKET_LABELS[bucket],
    sessions: byBucket.get(bucket) ?? [],
  }));
}
