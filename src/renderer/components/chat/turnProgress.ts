import { englishTranslate, type Translate } from '@shared/i18n';
import { readPiUsagePayload } from '@shared/piUsage';
import { formatTokenTotal } from './countFormat';
import { splitWorkedForDuration } from './turnTiming';

/**
 * The live numbers on the turn progress head (2026-09-18 user decision).
 *
 * ## The defect this exists for, measured
 *
 * A one-word prompt («nihao») took 49.6s; a `sleep 90` tool call showed nothing
 * but 「运行中」 for a minute and a half. For that whole time the ONLY evidence on
 * screen that the turn was alive was a seconds counter above the composer — far
 * from the reply it describes, and carrying no answer to "is it actually doing
 * anything". The head above the reply now carries the same clock PLUS what the
 * turn has spent, which is the only live signal this app can honestly produce:
 * the claude channel returns no thinking text at all (signature only), so
 * "stream the reasoning" is not available on the primary model.
 *
 * ## Nothing here estimates
 *
 * Every function returns `null` for "not measured" and the render site drops the
 * clause. The rule is `piUsage.ts`'s and A07 `:2399`'s, restated at turn scale:
 * a `0` that means "we have no number" is a lie, and it is a lie about exactly
 * the thing the user is staring at while they wait.
 *
 * Pure and store-free so the node-env vitest can truth-table it without
 * mounting React — same discipline as `turnProcessFold.ts` beside it.
 */

/** Prompt-side and completion-side token totals for ONE turn. */
export interface TurnTokenTotals {
  /**
   * Everything that went UP: uncached prompt + cache reads + cache writes.
   *
   * That is `totalTokens - output` for every payload Pi has produced
   * (`{"input":2,"output":1321,"cacheRead":0,"cacheWrite":10656,"totalTokens":11979}`
   * — checked against real session files, not assumed), so the two halves here
   * add back up to the total Pi billed.
   *
   * Deliberately NOT `deriveCacheHitRate`'s `input + cacheRead` denominator:
   * that one answers "how much of the prompt came from cache", where a cache
   * WRITE must be excluded or the turn that warms a cache looks like it missed
   * twice. This one answers "how much went up the wire", and a cache write went
   * up the wire.
   */
  up: number;
  /** Completion tokens — the `↓` half. */
  down: number;
  /**
   * `Usage.reasoning` summed across the turn's model calls — already counted
   * inside `down` (pi-ai's own contract: "subset of `output`"), so this is a
   * BREAKDOWN of that figure, never a third quantity to add to `up`/`down`.
   *
   * `undefined` when no call in the turn reported it, so "not measured" stays
   * tellable from "reported zero" — the same distinction `piUsage.ts` keeps at
   * the payload layer. Display policy (dropping a `0`, and choosing between
   * this and the wall-clock thinking clause) lives in
   * `formatReasoningTokensClause` / `turnProgressClauses`, not here.
   */
  reasoning?: number;
}

/**
 * Fold a turn's per-message `usage.updated` payloads into one pair of totals.
 *
 * ## Why summing is the right shape, and what it means
 *
 * `usage.updated` is emitted once per MODEL CALL (`projector.ts`'s `turn_end`
 * branch), and a turn that calls a tool makes several. The registry attributes
 * each one to the assistant message that was open at the time
 * (`messageMetadata.ts`'s `bySessionLastAssistant`), so a turn's messages carry
 * one payload each and the sum is what the provider billed FOR THIS TURN.
 *
 * The second call's prompt necessarily re-sends the first call's prompt (mostly
 * as `cacheRead`), so `up` is not "the size of the context" — it is the billed
 * traffic, which is also why it only ever grows while a turn runs. "How full is
 * the context" is a different question with its own surface, the composer's
 * occupancy chip (`deriveContextOccupancy`).
 *
 * ## `null` vs a zero row
 *
 * `readPiUsagePayload` rejects anything that is not a settled payload — which
 * includes the empty `{}` that real assistant entries sometimes carry, and the
 * retired Claude-era interim ticks. If NO message in the turn produced a usable
 * payload, there is no measurement and the caller prints nothing.
 */
export function sumTurnTokens(
  usages: readonly (Record<string, unknown> | null | undefined)[]
): TurnTokenTotals | null {
  let up = 0;
  let down = 0;
  let measured = false;
  let reasoning = 0;
  let reasoningMeasured = false;
  for (const raw of usages) {
    const usage = readPiUsagePayload(raw);
    if (!usage) continue;
    measured = true;
    up += usage.input + usage.cacheRead + usage.cacheWrite;
    down += usage.output;
    // Folded the same way `up`/`down` are: a tool-calling turn bills several
    // model calls, and this is the reasoning slice of ALL of them, not just
    // the last. Only counted as "measured" when at least one call actually
    // reported the field — see `TurnTokenTotals.reasoning`.
    if (typeof usage.reasoning === 'number') {
      reasoning += usage.reasoning;
      reasoningMeasured = true;
    }
  }
  if (!measured) return null;
  return { up, down, ...(reasoningMeasured ? { reasoning } : {}) };
}

/**
 * One thinking block's timing, as `turnTiming.ts`'s registry holds it. Declared
 * structurally so this module stays a leaf of that one.
 */
export interface TurnThinkingSpan {
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

/**
 * How long this turn has spent thinking, across every thinking block in it.
 *
 * ## The live half, and the guard on it
 *
 * A block that has started and not finished is counted as `nowMs - startedAt`
 * ONLY while `live` — i.e. while the turn is actually running. Without that
 * guard an interrupted turn (Stop pressed mid-thought, so `thinking.completed`
 * never arrives) would report a thinking time that kept growing for as long as
 * the session stayed open, on a turn that stopped minutes ago.
 *
 * ## When this is simply unavailable
 *
 * `projector.ts` opens a thought on the first thinking DELTA, so a provider that
 * returns no reasoning text emits no `thinking.started` and no span reaches this
 * function. That is the claude channel's normal behaviour (signature only, no
 * body), and the honest answer there is `null` — no clause — rather than `0 秒`,
 * which would claim the model did not think.
 */
export function sumTurnThinkingMs(
  spans: readonly (TurnThinkingSpan | null | undefined)[],
  options: { nowMs: number; live: boolean }
): number | null {
  let total = 0;
  let measured = false;
  for (const span of spans) {
    if (!span) continue;
    const settled =
      typeof span.durationMs === 'number'
        ? span.durationMs
        : typeof span.startedAt === 'number' && typeof span.completedAt === 'number'
          ? span.completedAt - span.startedAt
          : null;
    if (settled !== null) {
      // A clock that ran backwards is unknown time, not negative time — the
      // same ruling `deriveTurnWorkedMs` makes about the turn's own span.
      if (settled > 0) {
        total += settled;
        measured = true;
      }
      continue;
    }
    if (!options.live) continue;
    if (typeof span.startedAt !== 'number' || span.completedAt != null) continue;
    const running = options.nowMs - span.startedAt;
    if (running > 0) {
      total += running;
      measured = true;
    }
  }
  return measured ? total : null;
}

/**
 * The `↑ 12.0k tokens` / `↓ 1.3k tokens` clauses, or an empty list.
 *
 * Arrow outside the catalog key, unit inside it — the same split
 * `replyCharsLabel` already uses for `↓ 128 chars`, so the two status surfaces
 * cannot word the same idea differently. A zero column is dropped rather than
 * printed: before the first payload settles there is genuinely nothing to say
 * about the `↓` half, and `↓ 0 tokens` would read as "the model wrote nothing".
 */
export function formatTurnTokenClauses(
  tokens: TurnTokenTotals | null,
  t: Translate = englishTranslate
): string[] {
  if (!tokens) return [];
  const clauses: string[] = [];
  if (tokens.up > 0) clauses.push(`↑ ${formatTokenTotal(tokens.up)} ${t('tokens')}`);
  if (tokens.down > 0) clauses.push(`↓ ${formatTokenTotal(tokens.down)} ${t('tokens')}`);
  return clauses;
}

/**
 * The 「思考 20 秒」 clause, or `null` when nothing was measured.
 *
 * Three literal keys and not one `{{duration}}` slot, for the reason the work
 * group head already carries: English writes "20s" and Chinese writes 「20 秒」,
 * so the unit words belong to the catalog. Shares `splitWorkedForDuration`, so
 * a minute is written the same way here as in the head beside it.
 */
export function formatThinkingClause(
  thinkingMs: number | null,
  t: Translate = englishTranslate
): string | null {
  if (thinkingMs === null) return null;
  const { minutes, seconds } = splitWorkedForDuration(thinkingMs);
  if (minutes === 0) return t('Thinking {{seconds}}s', { seconds });
  if (seconds === 0) return t('Thinking {{minutes}}m', { minutes });
  return t('Thinking {{minutes}}m {{seconds}}s', { minutes, seconds });
}

/**
 * The 「思考 607 tokens」 clause — `TurnTokenTotals.reasoning`, i.e. the
 * provider-BILLED reasoning token count, as opposed to `formatThinkingClause`'s
 * wall-clock span of open `thinking` blocks. A different source (`usage`, not
 * the thinking-block registry `turnTiming.ts` keys), and `turnProgressClauses`
 * is what reconciles the two when a turn happens to report both.
 *
 * `<= 0` is dropped, not printed as `0`, and this is NOT the same guard as
 * `formatTurnTokenClauses`' "still zero" case: pi-ai's OpenAI-style adapters
 * (`openai-completions.js`, `openai-responses-shared.js`) coerce a MISSING
 * reasoning breakdown to a literal `0` for every plain, non-reasoning model
 * they serve — `rawUsage.completion_tokens_details?.reasoning_tokens || 0` —
 * so most turns on most models would carry a defined `0` here, not `undefined`.
 * Printing it would tell a user whose model never reasons at all that it
 * "thought about nothing", when the true statement is "this number does not
 * apply". Only pi-ai's Anthropic adapter leaves the field genuinely unset when
 * unreported, and `sumTurnTokens` already keeps that distinction as far as this
 * function — but here, at the display boundary, both cases print nothing.
 */
export function formatReasoningTokensClause(
  reasoningTokens: number | null | undefined,
  t: Translate = englishTranslate
): string | null {
  if (!reasoningTokens || reasoningTokens <= 0) return null;
  return t('Thinking {{count}} tokens', { count: formatTokenTotal(reasoningTokens) });
}

/**
 * The head's live clauses, under the TWO-STAGE rule (user decision,
 * 2026-09-18): 「确实在没收到回复的时候，只显示状态词+运行时间，收到内容后，再
 * 持续更新 ↑↓ token，思考量」.
 *
 * ## Why the first stage is a rule and not just "there is no data yet"
 *
 * It is both, and the rule is the load-bearing half. Upstream sends NOTHING
 * for the whole wait — measured against the gateway with a bare fetch on
 * 2026-09-18, five prompts, first byte at 11.4s / 12.8s / 16.9s / 18.5s /
 * 29.9s with total minus first byte pinned at ~2s every time. So the wait is
 * pure silence and the clock is the only honest signal during it.
 *
 * But a turn that calls tools settles its FIRST model call mid-turn, which
 * means real token totals exist while the SECOND call is still waiting in that
 * same silence. Gating on `tokens !== null` alone would therefore print a
 * token count during a wait — the exact thing the first stage forbids — for
 * every turn after the first tool call. `hasReplyContent` is what makes the
 * stage boundary the user's ("has anything come back yet") rather than the
 * data's ("has anything been billed yet").
 *
 * The flag is the same fact `deriveTurnStatus` switches its own wording on
 * (`hasBlocks`), so the head and the status line cannot disagree about when
 * the wait ended.
 *
 * ## The thinking clause: duration first, token count as its fallback
 *
 * `formatThinkingClause` (wall-clock) and `formatReasoningTokensClause`
 * (billed token count) answer the same question — "how much did it think" —
 * from two different sources, and this function shows at most ONE of them:
 * two clauses both starting with 「思考」 would read as a repeated word, not
 * two facts.
 *
 * Duration wins when both are available: it is the shape already shipped and
 * tested here, and it reuses the same seconds/minutes vocabulary the rest of
 * this "how long" head already speaks, where a token count would be the only
 * clause not answering "how long" on a head whose other clauses all do.
 *
 * That said, "both available" is the UNCOMMON case in practice, for opposite
 * reasons on the two channels this matters for. On claude, duration is close
 * to never available — `projector.ts` opens a thought on the first thinking
 * DELTA, and this app's claude calls stream a signature with no thinking text
 * at all, so `thinking.started` does not fire — while pi-ai's Anthropic
 * adapter (`anthropic-messages.js`) reads the token count from a DIFFERENT
 * field, `message_delta.usage.output_tokens_details.thinking_tokens`, so it
 * can and does come through independent of that same redaction. That is
 * exactly the gap this fallback exists to fill. On the reasoning-streaming
 * channels where duration DOES work, pi-ai's OpenAI-style adapters populate
 * the token count too (`completion_tokens_details.reasoning_tokens` /
 * `output_tokens_details.reasoning_tokens`) — so duration simply wins there
 * every time, and the fallback never triggers. Either way, at most one source
 * is actually live for a given turn; the `??` matters for the rare turn where
 * both genuinely are.
 */
export function turnProgressClauses(
  input: {
    /** The turn has produced at least one block — the wait is over. */
    hasReplyContent: boolean;
    tokens: TurnTokenTotals | null;
    thinkingMs: number | null;
  },
  t: Translate = englishTranslate
): string[] {
  if (!input.hasReplyContent) return [];
  const thinking =
    formatThinkingClause(input.thinkingMs, t) ??
    formatReasoningTokensClause(input.tokens?.reasoning, t);
  return [...formatTurnTokenClauses(input.tokens, t), ...(thinking ? [thinking] : [])];
}

/**
 * Join the head's verb with whatever clauses were measured, ` · `-separated —
 * the separator every other status line in this app already uses.
 *
 * Takes the pieces rather than building them so the caller keeps its literal
 * single-quoted catalog keys at its own translate call, which is the only form
 * `i18nCoverage.test.ts` can scan.
 */
export function joinTurnProgressLine(
  head: string,
  clauses: readonly (string | null | undefined)[]
): string {
  const parts = [head, ...clauses.filter((clause): clause is string => !!clause)];
  return parts.join(' · ');
}
