/** Reading the review model's answer, and the review's own deadline (decision 192 §3.2–3.3). */

const MAX_REASON_CHARS = 300;

export type ParsedReviewAnswer = { block: false } | { block: true; reason?: string } | null;

/**
 * `<block>yes|no` (the closing tag may be cut by the stop sequence), with an
 * optional `<reason>`. Thinking is ignored. Both verdicts, or neither, is null:
 * Claude Code counts that as no verdict at all.
 */
export function parseReviewAnswer(text: string): ParsedReviewAnswer {
  const visible = text.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/gi, '');
  const verdicts = new Set(
    [...visible.matchAll(/<block>\s*(yes|no)\b/gi)].map((match) => match[1]?.toLowerCase())
  );
  if (verdicts.size !== 1) return null;
  if (verdicts.has('no')) return { block: false };
  const reason = /<reason>([\s\S]*?)(<\/reason>|$)/i.exec(visible)?.[1]?.trim();
  if (!reason) return { block: true };
  return {
    block: true,
    reason: reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason,
  };
}

/**
 * A rough token count for budgeting: about four ASCII characters per token,
 * and one per character for everything else (CJK runs close to that).
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

/** Claude Code's: 60 s, plus 10 s per 50k prompt tokens past the first 50k, at most 120 s. */
export function reviewTimeoutMs(promptTokens: number): number {
  const extra = Math.max(0, Math.ceil((promptTokens - 50_000) / 50_000));
  return Math.min(120_000, 60_000 + extra * 10_000);
}
