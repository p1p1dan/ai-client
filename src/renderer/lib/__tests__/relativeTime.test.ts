import { describe, expect, it } from 'vitest';
import { formatAbsoluteTime } from '@/components/chat/messageMetadata';
import { formatAbsoluteDateTime } from '../relativeTime';

/**
 * Decision 167 §3: the sidebar's absolute time behind a relative age always
 * carries the date. Built from local-time parts, so these hold in any time
 * zone the suite runs in.
 */
describe('formatAbsoluteDateTime', () => {
  it('writes the date and the 24-hour time, zero-padded', () => {
    expect(formatAbsoluteDateTime(new Date(2026, 9, 9, 14, 55).getTime(), 'zh')).toBe(
      '2026-10-09 14:55'
    );
    expect(formatAbsoluteDateTime(new Date(2026, 0, 5, 7, 3).getTime(), 'zh')).toBe(
      '2026-01-05 07:03'
    );
  });

  it('keeps the date across a day boundary, where a bare HH:MM would collide', () => {
    const lateYesterday = new Date(2026, 9, 8, 23, 59).getTime();
    const earlyToday = new Date(2026, 9, 9, 0, 1).getTime();
    expect(formatAbsoluteDateTime(lateYesterday, 'zh')).toBe('2026-10-08 23:59');
    expect(formatAbsoluteDateTime(earlyToday, 'zh')).toBe('2026-10-09 00:01');
    // The same wall-clock time on two days reads differently — the reason the
    // turn footer's `HH:MM` (`formatAbsoluteTime`) is not used here.
    const a = new Date(2026, 9, 8, 14, 32).getTime();
    const b = new Date(2026, 9, 9, 14, 32).getTime();
    expect(formatAbsoluteTime(a)).toBe(formatAbsoluteTime(b));
    expect(formatAbsoluteDateTime(a, 'zh')).not.toBe(formatAbsoluteDateTime(b, 'zh'));
  });

  it('keeps the year across a year boundary', () => {
    expect(formatAbsoluteDateTime(new Date(2025, 11, 31, 23, 30).getTime(), 'zh')).toBe(
      '2025-12-31 23:30'
    );
    expect(formatAbsoluteDateTime(new Date(2027, 0, 1, 9, 0).getTime(), 'en')).toBe(
      '2027-01-01 09:00'
    );
  });

  it('follows the UI language, not the system locale, and falls back to English', () => {
    const at = new Date(2026, 9, 9, 14, 55).getTime();
    expect(formatAbsoluteDateTime(at, 'en')).toBe('2026-10-09 14:55');
    expect(formatAbsoluteDateTime(at)).toBe('2026-10-09 14:55');
    // An i18n stub that reports no language must not break the tooltip.
    expect(formatAbsoluteDateTime(at, undefined)).toBe('2026-10-09 14:55');
  });
});
