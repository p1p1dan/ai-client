import { englishTranslate, type Translate } from '@shared/i18n';
import type { LegacyImportItemResult } from '@shared/types';

/**
 * T067 (D9) — the sentence a failed import row shows.
 *
 * The 2026-09-17 field pass photographed 「Claude session exceeds the
 * 4000-entry import limit」 sitting directly above 「新导入 0 个，已存在 0 个，
 * 失败 1 个。」: one row, two languages, and a byte ceiling printed as
 * 67108864. Three separate faults, all of them fixed here rather than in the
 * main process, because the main process is the one layer that cannot know the
 * user's language.
 *
 *  - The WORDING comes from the catalog, keyed off `errorCode`.
 *  - The NUMBER is formatted where it is read, not where it is enforced.
 *  - The row gains a NEXT STEP. A limit the user cannot act on is a dead end;
 *    「请改导入较小的会话」 is the whole difference between a refusal and an
 *    error message.
 *
 * An uncoded failure still shows its raw `error`. That is deliberate: the
 * remaining failures are diagnostics (a source that vanished, a permission
 * error, a session with no assistant reply), and inventing a friendly Chinese
 * paraphrase for them would lose the only detail worth reporting.
 *
 * §12 verification first: `__tests__/legacyImportFailure.test.ts`.
 */
export function describeLegacyImportFailure(
  result: Pick<LegacyImportItemResult, 'error' | 'errorCode' | 'errorParams'> | undefined,
  t: Translate = englishTranslate
): string | undefined {
  if (!result) return undefined;
  const limit = result.errorParams?.limit;
  if (result.errorCode === 'source-entry-limit' && typeof limit === 'number') {
    return t(
      'This conversation has more than {{limit}} records, past the import limit. Import a smaller conversation, or split it up first.',
      { limit }
    );
  }
  if (result.errorCode === 'source-byte-limit' && typeof limit === 'number') {
    return t(
      'This conversation is larger than {{size}}, past the import limit. Import a smaller conversation, or split it up first.',
      { size: formatImportLimitBytes(limit) }
    );
  }
  return result.error;
}

/**
 * Binary units, and no decimal when there does not need to be one.
 *
 * The limits this formats are powers of two by construction, so the honest
 * rendering of 67108864 is `64 MiB` — not `64.0 MB`, which names a different
 * unit, and not the raw digits, which name nothing a user can picture.
 */
export function formatImportLimitBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}
