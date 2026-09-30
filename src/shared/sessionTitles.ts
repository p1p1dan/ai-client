/**
 * Titles the app gives a chat itself, shared by Main (which writes some of them
 * to the session index) and the renderer (which shows them).
 *
 * The placeholder titles are stored identifiers, not copy (decision 144): the
 * renderer shows them in the UI language through `displaySessionTitle`.
 */

import { englishTranslate, type Translate } from './i18n';

/**
 * The title every "new chat" path gives a chat before its first message names
 * it. Stored as this English identifier; shown as 「新建对话」 in Chinese.
 */
export const NEW_CHAT_TITLE = 'New chat';

/**
 * The start-up seed's title before decision 144 (a development-era demo name).
 * No longer written; still a placeholder, because rows carrying it may exist.
 */
export const LEGACY_SEED_TITLE = 'Live Agent Host';

/**
 * dsh-rebase P1-7e e6 (problem 40, decision 145): what a fork is called — the
 * source's title and this suffix, a dictionary key (「（分叉）」 in Chinese).
 */
export const FORK_TITLE_KEY = '{{title}} (fork)';

/**
 * The title Main writes for a new fork, in the app's language at that moment.
 *
 * Like the 1.0.x branch title (decision 131 §15) it is the chat's name from
 * then on, so switching the language later does not rewrite it, and forks
 * made before this change keep the English suffix they were stored with.
 * A source still carrying a placeholder (or no title) contributes the
 * placeholder as shown — 「新建对话（分叉）」 — rather than the identifier.
 */
export function forkSessionTitle(sourceTitle: string, t: Translate = englishTranslate): string {
  const trimmed = sourceTitle.trim();
  const base =
    trimmed.length === 0 || trimmed === NEW_CHAT_TITLE || trimmed === LEGACY_SEED_TITLE
      ? t(NEW_CHAT_TITLE)
      : sourceTitle;
  return t(FORK_TITLE_KEY, { title: base });
}
