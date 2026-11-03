/**
 * How the chat transcript draws a turn's work (user ruling 2026-11-03, decision 208).
 *
 * - `terminal`: Claude Code's CLI. A bullet column, one line per step with the
 *   tool's own name, and a `⎿` result line under it. Default.
 * - `desktop`: Claude Code's desktop app. Each run of steps between two
 *   paragraphs folds into one muted summary line that opens to the rows.
 *
 * There is deliberately no third value: the look before this setting is not
 * kept as an option (same ruling).
 *
 * No imports, so `src/shared` and the renderer can both take it in.
 */

export const CHAT_TRANSCRIPT_STYLES = ['terminal', 'desktop'] as const;

export type ChatTranscriptStyle = (typeof CHAT_TRANSCRIPT_STYLES)[number];

export const DEFAULT_CHAT_TRANSCRIPT_STYLE: ChatTranscriptStyle = 'terminal';

export function isChatTranscriptStyle(value: unknown): value is ChatTranscriptStyle {
  return (CHAT_TRANSCRIPT_STYLES as readonly unknown[]).includes(value);
}

/** The stored value, or the default when it is missing or not one we know. */
export function resolveChatTranscriptStyle(value: unknown): ChatTranscriptStyle {
  return isChatTranscriptStyle(value) ? value : DEFAULT_CHAT_TRANSCRIPT_STYLE;
}
