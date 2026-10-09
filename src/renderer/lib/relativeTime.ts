/**
 * Shared relative-age formatting.
 *
 * Extracted from `components/workspace-shell/sidebarTree.ts` (which still
 * re-exports it, so its callers and tests are untouched) when T-31 / P-18 gave
 * the chat turn footer a relative timestamp too. Chat must not import from
 * `components/workspace-shell` — that dependency direction is inverted on
 * purpose (see `ReadingColumn.tsx` / T-22 spec §2.13) — so the single
 * implementation both sides share lives here, in `lib`.
 *
 * One bucket table, two renderings: the sidebar's narrow right-hand column
 * takes the bare age ("5d"), the chat footer adds the "ago" suffix
 * (`messageMetadata.formatRelativeTimestamp`).
 */

import type { Locale } from '@shared/i18n';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Sub-minute age (including small clock skew). A distinct token rather than
 * "0m" because consumers phrase it differently ("now" / "just now") and must
 * not have to string-match a number to detect the case.
 */
export const RELATIVE_AGE_NOW = 'now';

/**
 * Compact relative age for the right-aligned column ("5d" / "6d" in the
 * Cursor reference shot). Sub-minute — including small clock skew — reads
 * "now"; no "ago" suffix, the column is too narrow.
 */
export function formatRelativeAge(updatedAt: number, now: number): string {
  const diff = now - updatedAt;
  if (diff < MINUTE_MS) {
    return RELATIVE_AGE_NOW;
  }
  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)}m`;
  }
  if (diff < DAY_MS) {
    return `${Math.floor(diff / HOUR_MS)}h`;
  }
  if (diff < WEEK_MS) {
    return `${Math.floor(diff / DAY_MS)}d`;
  }
  if (diff < MONTH_MS) {
    return `${Math.floor(diff / WEEK_MS)}w`;
  }
  if (diff < YEAR_MS) {
    return `${Math.floor(diff / MONTH_MS)}mo`;
  }
  return `${Math.floor(diff / YEAR_MS)}y`;
}

/**
 * Decision 167 §3: the absolute moment behind a sidebar row's relative age,
 * for its tooltip. Always date AND time (`YYYY-MM-DD HH:MM`, 24-hour, local
 * time): sidebar rows span days and years, and a bare `14:32` — what
 * `formatAbsoluteTime` (`chat/messageMetadata.ts`, `HH:MM` only, the turn
 * footer's hover) prints — is ambiguous the moment it is not today.
 *
 * The pattern is chosen by the UI language, never by the system locale
 * (`toLocaleString()` would read the OS setting and print a different shape
 * on every machine). Both languages use the numeric form today; the table is
 * where a language that wants another order would say so.
 */
const ABSOLUTE_DATE_TIME_PATTERN: Readonly<Record<Locale, string>> = {
  en: '{Y}-{M}-{D} {h}:{m}',
  zh: '{Y}-{M}-{D} {h}:{m}',
};

export function formatAbsoluteDateTime(ms: number, locale: Locale = 'en'): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  const parts: Record<string, string> = {
    Y: String(date.getFullYear()),
    M: pad(date.getMonth() + 1),
    D: pad(date.getDate()),
    h: pad(date.getHours()),
    m: pad(date.getMinutes()),
  };
  const pattern = ABSOLUTE_DATE_TIME_PATTERN[locale] ?? ABSOLUTE_DATE_TIME_PATTERN.en;
  return pattern.replace(/\{(\w)\}/g, (_match, key: string) => parts[key] ?? '');
}
