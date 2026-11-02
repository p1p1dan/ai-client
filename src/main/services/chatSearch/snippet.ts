/**
 * Chat search: where a query sits in a message, and the window of text one
 * result row shows around it. Offsets are UTF-16 code units, as the contract
 * (`ChatSearchSnippet`) states.
 */

import type { ChatSearchRole, ChatSearchSnippet } from '@shared/types/chatSearch';

/** Characters kept before and after the match. */
export const SNIPPET_BEFORE = 40;
export const SNIPPET_AFTER = 80;
const ELLIPSIS = '…';

/**
 * First case-insensitive occurrence of `query` in `text`: its start and
 * length in `text`, or null. Folding that changes a string's length (rare:
 * `İ`) falls back to comparing window by window.
 */
export function findMatch(text: string, query: string): { start: number; length: number } | null {
  if (!query) return null;
  const foldedQuery = query.toLowerCase();
  const foldedText = text.toLowerCase();
  if (foldedText.length === text.length && foldedQuery.length === query.length) {
    const start = foldedText.indexOf(foldedQuery);
    return start < 0 ? null : { start, length: query.length };
  }
  for (let start = 0; start + query.length <= text.length; start += 1) {
    if (text.slice(start, start + query.length).toLowerCase() === foldedQuery) {
      return { start, length: query.length };
    }
  }
  return null;
}

/** Case-insensitive containment, the same folding as {@link findMatch}. */
export function containsText(text: string, query: string): boolean {
  return findMatch(text, query) !== null;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The row's window around the match: up to {@link SNIPPET_BEFORE} units
 * before and {@link SNIPPET_AFTER} after, `…` where it was cut, line breaks
 * and tabs shown as spaces. A surrogate pair is never split.
 */
export function buildSnippet(
  text: string,
  role: ChatSearchRole,
  match: { start: number; length: number } | null
): ChatSearchSnippet {
  const at = match ?? { start: 0, length: 0 };
  let from = Math.max(0, at.start - SNIPPET_BEFORE);
  let to = Math.min(text.length, at.start + at.length + SNIPPET_AFTER);
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from -= 1;
  if (to < text.length && isHighSurrogate(text.charCodeAt(to - 1))) to += 1;
  const head = from > 0 ? ELLIPSIS : '';
  const tail = to < text.length ? ELLIPSIS : '';
  const body = text.slice(from, to).replace(/[\r\n\t]/g, ' ');
  return {
    role,
    text: `${head}${body}${tail}`,
    matchStart: head.length + (at.start - from),
    matchLength: at.length,
  };
}
