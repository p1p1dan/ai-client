function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Format a session/project activity timestamp (Unix seconds) into a compact label:
 * - Today: `HH:mm`
 * - Yesterday: `昨天`
 * - This year: `M月D日`
 * - Other years: `YYYY/M/D`
 */
export function formatActivityLabel(timestampSeconds: number | null | undefined): string {
  if (!timestampSeconds || timestampSeconds <= 0) return '';

  const tsMs = timestampSeconds * 1000;
  const date = new Date(tsMs);
  const now = new Date();

  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isSameDay) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return '昨天';

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
