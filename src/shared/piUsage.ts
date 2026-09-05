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
 * Build the payload from an SDK assistant message's `usage` and, optionally,
 * the session's context usage.
 *
 * Returns `null` when the turn carries no usable usage at all — the caller then
 * emits nothing rather than a row of zeroes, because "this turn cost nothing"
 * and "the provider reported nothing" are different claims.
 *
 * Both arguments are `unknown`: they cross a dependency version boundary, same
 * policy as `readLoadedExtensionInventory`.
 */
export function buildPiUsagePayload(usage: unknown, contextUsage?: unknown): PiUsagePayload | null {
  const source = record(usage);
  if (!source) return null;
  const cost = record(source.cost);
  const context = readContextUsage(contextUsage);
  return {
    input: finiteNumber(source.input) ?? 0,
    output: finiteNumber(source.output) ?? 0,
    cacheRead: finiteNumber(source.cacheRead) ?? 0,
    cacheWrite: finiteNumber(source.cacheWrite) ?? 0,
    totalTokens: finiteNumber(source.totalTokens) ?? 0,
    costUsd: finiteNumber(cost?.total) ?? 0,
    ...(context ? { context } : {}),
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
  return {
    input,
    output,
    cacheRead: finiteNumber(source.cacheRead) ?? 0,
    cacheWrite: finiteNumber(source.cacheWrite) ?? 0,
    totalTokens: finiteNumber(source.totalTokens) ?? 0,
    costUsd: finiteNumber(source.costUsd) ?? 0,
    ...(context ? { context } : {}),
  };
}
