/**
 * T-27 round-3 (point-check #10): pure title-derivation helpers for the
 * "no more 'New chat' / 'Session xxxxxx' placeholders in the left nav"
 * fix — the user's first message gets condensed into the session title
 * instead of a small model doing the summarizing.
 *
 * `isPlaceholderTitle` is the SINGLE definition of "what counts as a
 * placeholder title" — `resumeIntent.ts`'s `resumeDisplayTitle` (existing,
 * T-03) and the new first-message auto-title wiring both call this one
 * function instead of each carrying their own inline check, so the rule can
 * never drift between the two call sites.
 */

/**
 * R4 fix: single source for the `Session xxxxxx` fallback title shape — both
 * the FORMATTER (this function) and the RECOGNIZER (`isPlaceholderTitle`
 * below) now derive from it, so they can never drift apart again.
 * `sessionIndexMerge.ts` re-exports this (thin forward) instead of keeping
 * its own copy — it used to define this independently, and the recognizer's
 * regex only matched `[0-9a-zA-Z]{6}`, which a UUID session id's `slice(-6)`
 * can violate: the id may itself contain a `-` right at that boundary (e.g.
 * `...ab-c12`), producing `Session ab-c12`, a title the old regex silently
 * failed to recognize as a placeholder.
 */
export function fallbackSessionTitle(sessionId: string): string {
  return `Session ${sessionId.slice(-6)}`;
}

/**
 * Matches `fallbackSessionTitle(id)` output structurally rather than by an
 * id-alphabet allowlist: the formatter slices the trailing 1–6 characters of
 * ANY session id without restricting its charset, so an allowlist here is a
 * contract drift waiting to happen (an id tail with, say, a `.` would produce
 * a fallback title the recognizer silently rejects). Session ids never
 * contain whitespace, so `\S{1,6}` covers the formatter's entire output
 * domain; 1–6 (not exactly 6) because `slice(-6)` of a shorter id yields
 * fewer characters.
 */
const SESSION_FALLBACK_TITLE_PATTERN = /^Session \S{1,6}$/;

/**
 * True when `title` is one of the app's own placeholder values and should be
 * replaced by something more useful once real content is available:
 * empty/whitespace-only, the literal seed titles (`createChatSessionOnWorkspace`'s
 * `'New chat'` default, the DEMO seed's `'Live Agent Host'`), or the
 * `Session xxxxxx` last-resort fallback (`fallbackSessionTitle` above).
 */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (!title || title.trim() === '') {
    return true;
  }
  if (title === 'New chat' || title === 'Live Agent Host') {
    return true;
  }
  return SESSION_FALLBACK_TITLE_PATTERN.test(title);
}

// ---- First-user-message presence (R3) ----

/**
 * True when `messages` already contains at least one user-role message.
 *
 * Used to gate the first-message auto-title (T-27 round-3 point-check #10):
 * a session's timeline only ever gains a user entry via the Host's own
 * confirmed echo (`message.started{role:'user'}` — see `assistantProgress.ts`'s
 * `isUserEchoForSend`; there is no local/optimistic add), so this reads as
 * "has this session's REAL first message already landed" — including a
 * resumed session's replayed history, which satisfies this even though its
 * title may still be a placeholder (it predates this feature, or the actual
 * first message had no derivable title). Callers must capture this BEFORE
 * starting the send that might add the very message being checked for.
 */
export function sessionHasUserMessage(messages: readonly { role: string }[]): boolean {
  return messages.some((message) => message.role === 'user');
}

// ---- First-message title derivation ----

/**
 * First sentence-ending punctuation (CJK + ASCII) or a line break.
 *
 * R5(a) fix: CJK terminators (`。！？`) and line breaks split immediately —
 * unconditional, as before. ASCII `.`/`!`/`?` only count when followed by
 * whitespace or end-of-string (`(?=\s|$)`): unqualified, a `.` inside a file
 * extension (`foo.ts`), version number (`v2.1`), domain name
 * (`example.com`), or filename (`package.json`) was being misread as ending
 * the sentence, truncating the title mid-word.
 */
const SENTENCE_BOUNDARY = /[。！？\n\r]|[.!?](?=\s|$)/;

/**
 * Leading markdown decoration to strip before using text as a title:
 * headings (`#`..`######`), list markers (`-`/`*`/`+`, `1.`/`1)`),
 * blockquotes (`>`), and stray backtick fences — repeated so `"> # Fix it"`
 * loses both layers.
 */
const MARKDOWN_PREFIX = /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|`{1,3})+/;

/** Any letter or digit in any script — used to reject symbol-only/emoji-only input. */
const HAS_MEANINGFUL_CHAR = /[\p{L}\p{N}]/u;

/** Title length tier — matches `resumeIntent.ts`'s existing preview cap. */
const MAX_TITLE_LENGTH = 60;

/**
 * Derive a session title from the user's first message: take the first
 * sentence (cut at the first sentence-ending punctuation or line break),
 * strip a leading markdown prefix, collapse whitespace, and cap the length.
 *
 * Returns `''` when nothing usable survives (empty/whitespace-only input, or
 * a first sentence that is punctuation/emoji only) — callers must treat an
 * empty result as "could not derive a title" and leave the existing title
 * alone rather than overwriting it with nothing.
 */
export function deriveSessionTitleFromFirstMessage(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  // Strip markdown decoration BEFORE hunting for a sentence boundary — a
  // numbered list's own `.` (e.g. "1. do the thing") would otherwise be
  // misread as the sentence terminator and truncate to just "1".
  const withoutMarkdown = normalized.replace(MARKDOWN_PREFIX, '');
  const boundaryIndex = withoutMarkdown.search(SENTENCE_BOUNDARY);
  const firstSentence =
    boundaryIndex === -1 ? withoutMarkdown : withoutMarkdown.slice(0, boundaryIndex);
  const collapsed = firstSentence.trim().replace(/\s+/g, ' ');

  if (!collapsed || !HAS_MEANINGFUL_CHAR.test(collapsed)) {
    return '';
  }
  // R5(b) fix: cap by Unicode CODE POINT count (`Array.from`), not UTF-16
  // code units (`.length`) — a `.slice`/`.length` cut on raw UTF-16 units can
  // land inside a surrogate pair (emoji, other supplementary-plane
  // characters), tearing it in half.
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= MAX_TITLE_LENGTH) {
    return collapsed;
  }
  return `${codePoints.slice(0, MAX_TITLE_LENGTH - 1).join('')}…`;
}
