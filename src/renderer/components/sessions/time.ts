import { englishTranslate, type Translate } from '@shared/i18n';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Format a session/project activity timestamp (Unix seconds) into a compact label:
 * - Today: `HH:mm`
 * - Yesterday: `Yesterday`
 * - This year: `M/D`
 * - Other years: `YYYY/M/D`
 *
 * Two of those four need words, so this takes a translator rather than
 * returning a key — the month/day form interpolates numbers and cannot be one.
 * `englishTranslate` is the default, which is the English text itself, so a
 * caller that has not been wired yet changes not one byte of output.
 */
export function formatActivityLabel(
  timestampSeconds: number | null | undefined,
  t: Translate = englishTranslate
): string {
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
  if (isYesterday) return t('Yesterday');

  if (date.getFullYear() === now.getFullYear()) {
    return t('{{month}}/{{day}}', { month: date.getMonth() + 1, day: date.getDate() });
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
