/**
 * T38-a — the settled `usage.updated` payload, defined once for both ends.
 *
 * ## Why a shared module and not two hand-written readers
 *
 * `UsageUpdatedEvent.payload` is `Record<string, unknown>`: it was shaped for a
 * producer that no longer exists (the Claude host's `eventNormalizer`), so the
 * type says nothing about which keys are actually there. Writing the keys in the
 * worker and reading them in the renderer would be two copies of an unwritten
 * contract — exactly the drift that left the renderer folding Claude-era keys
 * (`interim`, `turn_output_tokens_display`) that Pi never emits. Both sides go
 * through `buildPiUsagePayload` / `readPiUsagePayload` instead, so the key set
 * has one definition and one test.
 *
 * ## Where the numbers come from
 *
 * - The token/cost totals are Pi's own `Usage` off the assistant message carried
 *   by the SDK's `turn_end` event (`@earendil-works/pi-ai`'s `Usage`). They
 *   describe THAT TURN, not the session — a run that calls tools emits several.
 * - `context` is `AgentSession.getContextUsage()`, which Pi computes from the
 *   active branch against the model's own `contextWindow`. `tokens: null` is a
 *   real answer, not a missing one: Pi returns it when the branch was compacted
 *   and no assistant has responded since, so the occupancy is genuinely unknown
 *   until the next reply. Callers must render that as "unknown", never as 0.
 *
 * Nothing here estimates. If Pi does not report a number, this module drops the
 * field rather than deriving one from character counts.
 */

import {
  CACHE_CAUSES,
  CACHE_STEP_KINDS,
  type CacheCause,
  type CacheChainTotals,
  type CacheStepKind,
  type CacheStepRef,
  type CacheStepVerdict,
  isNotableVerdict,
} from './cacheChain.ts';
import type { PiSessionUsage } from './piTurnRollup';
import { readSessionUsage } from './piTurnRollup.ts';
import type { ClientPrefixVerdict } from './types/requestScope.ts';

/**
 * Token and cost totals for one turn.
 *
 * Written as a `type` and not an `interface` on purpose: `UsageUpdatedEvent`
 * declares `payload: Record<string, unknown>`, and only a type alias gets the
 * implicit index signature that assignment needs.
 */
export type PiTurnUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Pi's own total; not re-derived here, so it stays whatever Pi billed. */
  totalTokens: number;
  /**
   * `Usage.cost.total`. Pi prices from its model table, whose unit is documented
   * as USD per million tokens (`pi-ai` `ModelCost`), so a renderer may print a
   * `$` next to it.
   */
  costUsd: number;
  /**
   * `Usage.reasoning` — provider-reported reasoning/thinking tokens, already
   * counted inside `output` (pi-ai's own contract: "subset of `output`", see
   * `pi-ai`'s `types.d.ts`). A breakdown of that figure, never a quantity to
   * add on top of it.
   *
   * Optional, and NOT defaulted to `0` here: pi-ai's Anthropic adapter only
   * sets it `if (thinkingTokens != null)`, so an absent field is a real "this
   * call did not report a breakdown" — same rule `context.tokens` follows for
   * "Pi cannot tell yet". Note for callers: pi-ai's OpenAI-style adapters take
   * the opposite approach and coerce a missing breakdown to a literal `0`
   * (`rawUsage.completion_tokens_details?.reasoning_tokens || 0`), so `0`
   * reaches THIS module already unable to tell "measured zero" from "field not
   * supported" on those channels — a distinction this module cannot recover
   * because pi-ai collapsed it upstream. Display sites should treat `0` (and
   * absence) as nothing to report; see `formatReasoningTokensClause`.
   */
  reasoning?: number;
};

/** `AgentSession.getContextUsage()`, passed through without re-derivation. */
export type PiContextUsage = {
  /** `null` = Pi cannot tell yet (post-compaction, before the next reply). */
  tokens: number | null;
  contextWindow: number;
  /** `null` whenever `tokens` is. Pi's own percentage, not recomputed here. */
  percent: number | null;
};

export type PiUsagePayload = PiTurnUsage & {
  /** Absent when the session has no model, or the model declares no window. */
  context?: PiContextUsage;
  /**
   * A2 — the running total for this conversation, carried BESIDE the turn
   * totals above and never folded into them.
   *
   * The fields at the top level are what the provider billed for one turn and
   * stay exactly that; this is a second, separately-labelled number. Absent
   * before anything has settled, and absent from any payload an older build
   * produced.
   */
  session?: PiSessionUsage;
  /**
   * decision 005 — of the `session` totals above, the part delegates ran up.
   *
   * A field on `usage.updated` rather than an event of its own: the renderer
   * already folds one event here, and a second channel would mean two places
   * to reconcile one total. Absent when no delegate has settled in this
   * conversation, which is not the same as "delegates cost nothing".
   */
  delegated?: PiTurnUsage;
  /**
   * 2026-09-19 — this payload reports the PROMPT side of a model call that has
   * not finished yet. See {@link buildPiInterimUsagePayload}.
   *
   * Only ever `true`: a settled payload omits the key entirely, so the merge a
   * consumer does (`{ ...existing, ...payload }`) cannot leave the mark behind
   * on numbers that have since been billed.
   */
  pending?: true;
  /**
   * T125 (2026-09-25, option B) — the provider never reported what this turn
   * cost. See {@link isUnreportedTurnUsage} for the rule.
   *
   * The token/cost fields beside it are still exactly what pi left on the
   * message (zeros, or Anthropic's real prompt side plus its `output: 1`
   * placeholder); nothing is estimated. Settled-bill surfaces print "unknown"
   * instead of them. Only ever `true`, same shape and reason as `pending`.
   */
  unreported?: true;
  /**
   * Decision 173 (issue #9) — what became of this step's prompt cache. Only on
   * a settled payload, and only when the step is notable: see
   * {@link PiUsageCacheStep}.
   */
  cache?: PiUsageCacheStep;
};

/**
 * Decision 173 (issue #9) — one step's prompt-cache verdict (`cacheChain.ts`),
 * beside its bill.
 *
 * Sent only on a notable step (`isNotableVerdict`: a rebuild, a shrink, or a
 * read of an older step's cache) of a route the bridge follows
 * (anthropic-messages). A warm, cold, untracked or turn-shrink step carries
 * no `cache`, and nothing does while the check is switched off
 * (`AICLIENT_RUNTIME_CACHE_CHAIN=0`). Numbers only, never content.
 */
export type PiUsageCacheStep = {
  /** DSH's coordinates of the step this payload settles. */
  turn: number;
  step: number;
  kind: CacheStepKind;
  /** A local event since the step before explains it (`causes`); false is what the alert is about. */
  explained: boolean;
  /** Those local events, in order of first sight; omitted when there are none. */
  causes?: CacheCause[];
  /** Cached tokens processed again: the step before's prompt less this read; omitted when 0. */
  lost?: number;
  /** input + read + write. */
  prompt: number;
  read: number;
  write: number;
  /** The step before's prompt. */
  prevPrompt?: number;
  /** The older step whose cached size this read reproduces: requests alternate between caches. */
  matched?: CacheStepRef;
  /**
   * How the request that served this step related to the session's previous
   * request (decision 173 B1, the host's prefix watch), when the bridge could
   * tell which request that was. `append` and `same` clear the client.
   */
  prefix?: ClientPrefixVerdict['kind'];
  /** The session so far: notable steps nothing local explains, and the tokens their rebuilds and shrinks lost. */
  session: Pick<CacheChainTotals, 'unexplained' | 'unexplainedLostTokens'>;
};

/** The two arcs of an occupancy ring, plus the figures printed beside them. */
export type ContextOccupancy = {
  usedTokens: number;
  contextWindow: number;
  /** Clamped to 0..100; the printed figure uses the same value as the arc. */
  percent: number;
  freeTokens: number;
};

/**
 * Turn Pi's `ContextUsage` into drawable occupancy, or `null` when there is
 * none to draw (no context reported, or `tokens: null` — genuinely unknown).
 *
 * Lives beside the payload rather than in the Run surface because the composer
 * bar's own chip needs the identical answer, and `components/chat` may not
 * import from `components/workspace-shell` (a guarded direction). One derivation
 * here is also what stops the bar and the panel from ever disagreeing about the
 * same percentage.
 *
 * Two guards, both because this feeds a drawing: a percentage above 100 (a
 * provider counting the reply into the prompt) would sweep the arc past a full
 * circle, and a `usedTokens` above the window would make `freeTokens` negative.
 * Clamped rather than rejected — the occupancy is still the best fact there is,
 * it just cannot be drawn literally.
 */
export function deriveContextOccupancy(
  context: PiContextUsage | null | undefined
): ContextOccupancy | null {
  if (!context || context.tokens === null || context.contextWindow <= 0) return null;
  const usedTokens = Math.max(0, context.tokens);
  const percent =
    context.percent === null ? (usedTokens / context.contextWindow) * 100 : context.percent;
  return {
    usedTokens,
    contextWindow: context.contextWindow,
    percent: Math.min(100, Math.max(0, percent)),
    freeTokens: Math.max(0, context.contextWindow - usedTokens),
  };
}

/**
 * A1 — the provider-reported prompt cache hit rate for one turn, as a whole
 * percent, or `null` when there is no answer to give.
 *
 * ## Why it is worth a row of its own
 *
 * The Run panel already prints `cacheRead` and `cacheWrite` as absolute
 * numbers, and absolute numbers move with prompt size, so they hide the thing
 * worth watching. The rate is a sentinel: a bundled extension switched on, a
 * system prompt that starts carrying something variable, a borrowed skill list
 * that changed — each shows up immediately as the rate falling, where the raw
 * token counts would only show up later as a bigger bill.
 *
 * ## Why the denominator excludes cache writes
 *
 * The question is "how much of this prompt was served from cache", so the
 * denominator is the prompt: `input` (the part billed uncached) plus
 * `cacheRead` (the part that came from cache). `cacheWrite` is what it cost to
 * PUT tokens into the cache for some later turn; counting it here would make
 * the very turn that warms a cache look like it missed twice over. Same formula
 * and same reasoning as PI-Desktop's `calculateCacheRate`
 * (`apps/desktop/src/lib/context-usage.ts`).
 *
 * ## Why the rounding happens here
 *
 * More than one surface can print this, and a percentage rounded separately in
 * each is how two views of one number end up a point apart. Rounded once, with
 * `Math.round` on a 0..100 scale — the same operator and scale
 * `ComposerUsageChip` already uses for occupancy.
 *
 * ## `null` versus `0`
 *
 * `0` is a measurement: the prompt was billed and none of it came from cache.
 * `null` is the absence of one — no prompt tokens at all, or a `cacheRead` the
 * runtime did not report. Callers render `null` as nothing; printing it as `0%`
 * would assert a cache miss nobody measured. The fields are re-checked at
 * runtime rather than trusted from the type, because this payload crosses the
 * `Record<string, unknown>` boundary described at the top of this file.
 */
export function deriveCacheHitRate(usage: PiTurnUsage | null | undefined): number | null {
  if (!usage) return null;
  const input = finiteNumber(usage.input);
  const cacheRead = finiteNumber(usage.cacheRead);
  if (input === null || cacheRead === null || input < 0 || cacheRead < 0) return null;
  const promptTokens = input + cacheRead;
  // No prompt at all: nothing was served from cache, but nothing was billed
  // uncached either, so there is no ratio to report.
  if (promptTokens <= 0) return null;
  return Math.round((cacheRead / promptTokens) * 100);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Narrow Pi's `ContextUsage` shape. Returns `null` for anything that is not a
 * usable window — a zero or negative `contextWindow` would make every consumer's
 * percentage a division by zero, and Pi itself returns `undefined` in that case.
 */
function readContextUsage(value: unknown): PiContextUsage | null {
  const source = record(value);
  if (!source) return null;
  const contextWindow = finiteNumber(source.contextWindow);
  if (contextWindow === null || contextWindow <= 0) return null;
  const tokens = finiteNumber(source.tokens);
  const percent = finiteNumber(source.percent);
  return {
    tokens,
    contextWindow,
    // Pi ties these together (`percent` is `null` exactly when `tokens` is);
    // enforce it here so no consumer has to handle the impossible half-state.
    percent: tokens === null ? null : percent,
  };
}

/**
 * T125 (2026-09-25, option B) — true when a model call was cut short after its
 * stream had started and the provider never reported the completion side.
 *
 * ## Why the zeros exist
 *
 * OpenAI-compatible and Responses streams report usage only in their LAST
 * frame, and pi-ai's adapters start every message from an all-zero `usage`
 * (`openai-completions.js`, the initial `output` literal). A Stop, a send-now,
 * a session closed mid-run, the decision-042 loop-guard cut or a broken stream
 * ends the call before that frame, and the adapter's catch leaves the zeros
 * standing. Anthropic keeps the real prompt side from `message_start`, but its
 * `output_tokens: 1` is the placeholder {@link buildPiInterimUsagePayload}
 * already refuses.
 *
 * ## The rule — all three must hold
 *
 * 1. `stopReason` is `'aborted'` or `'error'`. Every other stop reason arrived
 *    with the provider's final frame, so its usage is a measurement.
 * 2. `usage.output <= 1`: `0` is the adapters' starting value, `1` Anthropic's
 *    placeholder. A completion count above that (Google streams cumulative
 *    counts; a usage chunk can land just before a failure) was reported and
 *    stays a measurement. A missing `output` reads as `0`.
 * 3. The stream had started ({@link streamStarted}). A call that failed before
 *    its first frame — refused connection, an HTTP error status,
 *    `providerRetry`'s setup failure — was not billed, so its zeros are true
 *    and stay unflagged, exactly as before T125.
 *
 * `message` is `unknown` for the same version-boundary reason as the builder.
 */
export function isUnreportedTurnUsage(message: unknown): boolean {
  const source = record(message);
  if (!source) return false;
  if (source.stopReason !== 'aborted' && source.stopReason !== 'error') return false;
  const output = finiteNumber(record(source.usage)?.output) ?? 0;
  if (output > 1) return false;
  return streamStarted(source);
}

/**
 * Whether a cut call's stream had started — the proxy for "the provider billed
 * the prompt". Either signal suffices:
 *
 * - `responseId`: every streaming adapter sets it from the FIRST frame
 *   (Anthropic `message_start`, Responses `response.created`, the first
 *   chat-completions chunk), before any content. It is what catches a call cut
 *   while the model was still reasoning invisibly.
 * - A content block with something in it: non-empty text or thinking, a
 *   redacted thinking block, or any other block type (a tool call). An empty
 *   text block is not evidence that anything streamed.
 *
 * Blind spot, accepted: a provider that sends neither an id nor content before
 * the cut reads as "never started" and keeps today's zeros.
 */
function streamStarted(message: Record<string, unknown>): boolean {
  if (typeof message.responseId === 'string' && message.responseId.length > 0) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((value) => {
    const block = record(value);
    if (!block) return false;
    if (block.type === 'text') return typeof block.text === 'string' && block.text.length > 0;
    if (block.type === 'thinking')
      return (
        (typeof block.thinking === 'string' && block.thinking.length > 0) || block.redacted === true
      );
    return typeof block.type === 'string';
  });
}

/**
 * Build the payload from an SDK assistant message's `usage` and, optionally,
 * the session's context usage.
 *
 * Returns `null` when the turn carries no usable usage at all — the caller then
 * emits nothing rather than a row of zeroes, because "this turn cost nothing"
 * and "the provider reported nothing" are different claims.
 *
 * Both arguments are `unknown`: they cross a dependency version boundary, same
 * policy as `readLoadedExtensionInventory`.
 *
 * `marks.unreported` is the caller's {@link isUnreportedTurnUsage} verdict on
 * the message this usage came from; the numbers are passed through unchanged
 * either way. `marks.cache` is the step's {@link buildPiUsageCacheStep}, kept
 * to the keys the reader knows.
 */
export function buildPiUsagePayload(
  usage: unknown,
  contextUsage?: unknown,
  sessionUsage?: PiSessionUsage | null,
  delegatedUsage?: PiTurnUsage | null,
  marks: { unreported?: boolean; cache?: PiUsageCacheStep | null } = {}
): PiUsagePayload | null {
  const source = record(usage);
  if (!source) return null;
  const cost = record(source.cost);
  const context = readContextUsage(contextUsage);
  const cache = readCacheStep(marks.cache);
  // Not `?? 0`: an absent `reasoning` is "this call reported no breakdown",
  // and folding it into a `0` would make it indistinguishable from a provider
  // that measured zero (see the field's doc comment on `PiTurnUsage`).
  const reasoning = finiteNumber(source.reasoning);
  return {
    input: finiteNumber(source.input) ?? 0,
    output: finiteNumber(source.output) ?? 0,
    cacheRead: finiteNumber(source.cacheRead) ?? 0,
    cacheWrite: finiteNumber(source.cacheWrite) ?? 0,
    totalTokens: finiteNumber(source.totalTokens) ?? 0,
    costUsd: finiteNumber(cost?.total) ?? 0,
    ...(reasoning !== null ? { reasoning } : {}),
    ...(context ? { context } : {}),
    // A2: a sibling of the turn totals, never a substitute for them.
    ...(sessionUsage ? { session: sessionUsage } : {}),
    // decision 005: the delegated slice of `session`, never of the turn above.
    ...(delegatedUsage ? { delegated: delegatedUsage } : {}),
    // T125: omitted rather than `false`, so a merge cannot leave it behind.
    ...(marks.unreported ? { unreported: true as const } : {}),
    // Decision 173: a notable step's cache verdict only.
    ...(cache ? { cache } : {}),
  };
}

/**
 * Decision 173: the settled payload's `cache` for one step's verdict, or
 * `null` when the step is not notable (`isNotableVerdict`) — a warm, cold,
 * untracked or turn-shrink step says nothing. `totals` are the session's as
 * of this step; `prefix` is the kind of the prefix evidence the bridge
 * matched to the step's request, when it found one.
 */
export function buildPiUsageCacheStep(
  verdict: CacheStepVerdict,
  totals: Pick<CacheChainTotals, 'unexplained' | 'unexplainedLostTokens'>,
  prefix?: ClientPrefixVerdict['kind']
): PiUsageCacheStep | null {
  if (!isNotableVerdict(verdict)) return null;
  return {
    turn: verdict.turn,
    step: verdict.step,
    kind: verdict.kind,
    explained: verdict.explained,
    ...(verdict.causes.length > 0 ? { causes: [...verdict.causes] } : {}),
    ...(verdict.lost > 0 ? { lost: verdict.lost } : {}),
    prompt: verdict.prompt,
    read: verdict.read,
    write: verdict.write,
    ...(verdict.prevPrompt !== undefined ? { prevPrompt: verdict.prevPrompt } : {}),
    ...(verdict.matched
      ? { matched: { turn: verdict.matched.turn, step: verdict.matched.step } }
      : {}),
    ...(prefix ? { prefix } : {}),
    session: {
      unexplained: totals.unexplained,
      unexplainedLostTokens: totals.unexplainedLostTokens,
    },
  };
}

const PREFIX_KINDS: ReadonlySet<unknown> = new Set<ClientPrefixVerdict['kind']>([
  'first',
  'same',
  'append',
  'diverged',
]);

/** A token count: finite and not negative. */
function tokenCount(value: unknown): number | null {
  const count = finiteNumber(value);
  return count !== null && count >= 0 ? count : null;
}

function readStepRef(value: unknown): CacheStepRef | null {
  const source = record(value);
  const turn = finiteNumber(source?.turn);
  const step = finiteNumber(source?.step);
  return turn !== null && step !== null ? { turn, step } : null;
}

/**
 * Narrow a `cache` block to the keys {@link PiUsageCacheStep} names. `null`
 * when any required one is missing or malformed: half a verdict would read
 * as a different one. An unknown cause is dropped, an unknown prefix kind left
 * out.
 */
function readCacheStep(value: unknown): PiUsageCacheStep | null {
  const source = record(value);
  if (!source) return null;
  const at = readStepRef(source);
  const kind = (CACHE_STEP_KINDS as readonly unknown[]).includes(source.kind)
    ? (source.kind as CacheStepKind)
    : null;
  const prompt = tokenCount(source.prompt);
  const read = tokenCount(source.read);
  const write = tokenCount(source.write);
  const session = record(source.session);
  const unexplained = tokenCount(session?.unexplained);
  const unexplainedLostTokens = tokenCount(session?.unexplainedLostTokens);
  if (
    !at ||
    !kind ||
    typeof source.explained !== 'boolean' ||
    prompt === null ||
    read === null ||
    write === null ||
    unexplained === null ||
    unexplainedLostTokens === null
  ) {
    return null;
  }
  const causes = Array.isArray(source.causes)
    ? source.causes.filter((cause): cause is CacheCause =>
        (CACHE_CAUSES as readonly unknown[]).includes(cause)
      )
    : [];
  const lost = tokenCount(source.lost);
  const prevPrompt = tokenCount(source.prevPrompt);
  const matched = readStepRef(source.matched);
  return {
    turn: at.turn,
    step: at.step,
    kind,
    explained: source.explained,
    ...(causes.length > 0 ? { causes } : {}),
    ...(lost !== null && lost > 0 ? { lost } : {}),
    prompt,
    read,
    write,
    ...(prevPrompt !== null ? { prevPrompt } : {}),
    ...(matched ? { matched } : {}),
    ...(PREFIX_KINDS.has(source.prefix)
      ? { prefix: source.prefix as ClientPrefixVerdict['kind'] }
      : {}),
    session: { unexplained, unexplainedLostTokens },
  };
}

/**
 * Read a payload back on the consumer side.
 *
 * `null` for anything that is not a settled Pi payload, which includes the
 * legacy interim ticks (`payload.interim === true`) the Claude host used to
 * emit: they carried an estimate under a different key set and must never be
 * folded in as if they were billed totals.
 */
export function readPiUsagePayload(payload: unknown): PiUsagePayload | null {
  const source = record(payload);
  if (!source) return null;
  if (source.interim === true) return null;
  const input = finiteNumber(source.input);
  const output = finiteNumber(source.output);
  if (input === null || output === null) return null;
  const context = readContextUsage(source.context);
  const session = readSessionUsage(source.session);
  const delegated = readDelegatedUsage(source.delegated);
  const reasoning = finiteNumber(source.reasoning);
  const cache = readCacheStep(source.cache);
  return {
    input,
    output,
    cacheRead: finiteNumber(source.cacheRead) ?? 0,
    cacheWrite: finiteNumber(source.cacheWrite) ?? 0,
    totalTokens: finiteNumber(source.totalTokens) ?? 0,
    costUsd: finiteNumber(source.costUsd) ?? 0,
    ...(reasoning !== null ? { reasoning } : {}),
    ...(context ? { context } : {}),
    ...(session ? { session } : {}),
    ...(delegated ? { delegated } : {}),
    ...(source.unreported === true ? { unreported: true as const } : {}),
    ...(cache ? { cache } : {}),
  };
}

/**
 * Narrow the delegated slice. `null` for a payload from a build that had none,
 * and for one whose every column is zero — the absence has to stay tellable
 * from a measured zero, same rule as {@link readSessionUsage}.
 */
function readDelegatedUsage(value: unknown): PiTurnUsage | null {
  const source = record(value);
  if (!source) return null;
  const usage: PiTurnUsage = {
    input: finiteNumber(source.input) ?? 0,
    output: finiteNumber(source.output) ?? 0,
    cacheRead: finiteNumber(source.cacheRead) ?? 0,
    cacheWrite: finiteNumber(source.cacheWrite) ?? 0,
    totalTokens: finiteNumber(source.totalTokens) ?? 0,
    costUsd: finiteNumber(source.costUsd) ?? 0,
  };
  return usage.totalTokens === 0 && usage.costUsd === 0 && usage.input === 0 && usage.output === 0
    ? null
    : usage;
}

/**
 * The prompt side of a model call that is still streaming, or `null` when the
 * provider has not reported one.
 *
 * ## Why this exists (2026-09-19 user decision)
 *
 * Anthropic's `message_start` frame arrives at FIRST BYTE and already carries
 * the real prompt-side counts — measured on the gateway on 2026-09-18, e.g.
 * `input_tokens: 431` — while the settled bill only arrives at the end of the
 * turn. Waiting for `turn_end` meant the `↑` figure on the turn progress head
 * stayed blank for the ten-to-thirty seconds the user actually spends staring
 * at the screen, which is the one window where it answers a question.
 *
 * ## Why the completion side is force-zeroed
 *
 * The SAME frame reports `output_tokens: 1`. That is a placeholder, not a
 * measurement — it stays `1` for the whole stream and is replaced wholesale by
 * the `message_delta` frame at the end. Passing it through would put a
 * permanent `↓ 1 tokens` on screen for every turn. So `output` (and the cost
 * that is derived from it) is reported as `0` here, which every display site
 * already drops rather than prints — `formatTurnTokenClauses` omits a zero
 * column precisely because "nothing to say yet" must not read as "the model
 * wrote nothing".
 *
 * `totalTokens` is re-derived from the prompt side alone for the same reason:
 * pi-ai's own total at this point includes the placeholder.
 *
 * ## The `pending` mark, and who reads it
 *
 * Surfaces that report a SETTLED bill (the Run panel's "last turn" rows, via
 * `foldSettledUsage`) must ignore this payload entirely — a turn still running
 * has not been billed. Surfaces that report LIVE progress (the turn progress
 * head, via the per-message metadata registry) fold it in and let the settled
 * payload that follows overwrite every numeric key on the same message, so the
 * interim figure is corrected rather than added to.
 *
 * Returns `null` when the prompt side is all zeroes: that is a provider which
 * reports nothing before the end, and an event saying so carries no
 * information.
 */
export function buildPiInterimUsagePayload(usage: unknown): PiUsagePayload | null {
  const source = record(usage);
  if (!source) return null;
  const input = finiteNumber(source.input) ?? 0;
  const cacheRead = finiteNumber(source.cacheRead) ?? 0;
  const cacheWrite = finiteNumber(source.cacheWrite) ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  if (promptTokens <= 0) return null;
  return {
    input,
    output: 0,
    cacheRead,
    cacheWrite,
    totalTokens: promptTokens,
    costUsd: 0,
    pending: true,
  };
}

/**
 * True for a payload built by {@link buildPiInterimUsagePayload}.
 *
 * Read by consumers that may only show settled bills. Kept next to the builder
 * so the key is written and tested in one place rather than spelled out again
 * at each call site.
 */
export function isPendingUsagePayload(payload: unknown): boolean {
  return record(payload)?.pending === true;
}
