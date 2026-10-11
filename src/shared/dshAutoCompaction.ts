/**
 * dsh-rebase decision 177 — automatic compaction, model by model.
 *
 * DSH's `compaction-basic` row (0.1.7-rc.2) compacts a conversation once its
 * request reaches a threshold worked out from the routed model's context
 * window W and output reservation O (`resolveCompactSpec`):
 *
 *   message budget B = W − O
 *   threshold        = floor(min(0.8 × W, B − headroom))     headroom 65536
 *   retained tail    = floor(0.16 × B), which must stay below the threshold
 *
 * With that headroom every model whose B is 78,019 or less fails the check:
 * DSH warns once and never compacts it automatically (overflow recovery still
 * runs). A little above that line the threshold sits so close to the tail
 * that each compaction folds away almost nothing. And the summary request
 * asks for 65536 output tokens whatever the model's own limit is, which a
 * service that checks `max_tokens` refuses.
 *
 * `autoCompactionPolicy` keeps DSH's defaults wherever they leave a useful
 * span, lowers only the headroom where they do not, says so when nothing
 * reasonable works, and caps the summary at the model's own output limit. The
 * DSH host turns it into the row's `modelPolicies` (lib/hostCompaction.ts),
 * Main puts it on the model menu (`applyDshPlanToCatalog`), and the settings
 * show it.
 *
 * Pure and import-free: the host bundle takes this file in as it is
 * (`HOST_INPUTS`, scripts/dsh-host-build-lib.mjs).
 */

/** `compaction-basic`'s default headroom (`resolveConfig`: `headroomTokens ?? 65536`). */
export const DSH_COMPACTION_HEADROOM_TOKENS = 65_536;
/** `DEFAULT_THRESHOLD_RATIO`. */
export const DSH_COMPACTION_THRESHOLD_RATIO = 0.8;
/** `DEFAULT_RETAIN_RATIO`. */
export const DSH_COMPACTION_RETAIN_RATIO = 0.16;
/** The summary request's output cap when nothing sets one (`maxTokens ?? headroomTokens`). */
export const DSH_COMPACTION_SUMMARY_MAX_TOKENS = DSH_COMPACTION_HEADROOM_TOKENS;

/**
 * The least one automatic compaction must be able to fold away: threshold
 * minus retained tail. What it folds also has to cover the system prompt and
 * tools (about 5.5k tokens bare, more with AGENTS.md, skills and MCP) and the
 * summary itself, so a smaller span compacts on nearly every step.
 */
export const AUTO_COMPACTION_MIN_SPAN_TOKENS = 24_576;
/** The least headroom a lowered headroom keeps, for one step's growth and the summary's output. */
export const AUTO_COMPACTION_MIN_HEADROOM_TOKENS = 8_192;
/** Lowering the output limit below this is not offered as the fix; the window is too small then. */
export const AUTO_COMPACTION_MIN_OUTPUT_TOKENS = 4_096;

/** The smallest message budget whose lowered headroom still keeps both floors above. */
function minimumMessageBudget(): number {
  const need = AUTO_COMPACTION_MIN_SPAN_TOKENS + AUTO_COMPACTION_MIN_HEADROOM_TOKENS;
  let budget = Math.max(1, Math.floor(need / (1 - DSH_COMPACTION_RETAIN_RATIO)) - 8);
  while (budget - Math.floor(budget * DSH_COMPACTION_RETAIN_RATIO) < need) budget += 1;
  return budget;
}

/** W − O below this: no headroom works (39,009 tokens with the floors above). */
export const AUTO_COMPACTION_MIN_MESSAGE_BUDGET = minimumMessageBudget();

export type DshCompactSpecFailure =
  | 'invalid_size'
  | 'no_message_budget'
  | 'no_pressure_budget'
  | 'retain_not_below_threshold';

export type DshCompactSpec =
  | { ok: true; messageBudgetTokens: number; thresholdTokens: number; retainTokens: number }
  | { ok: false; failure: DshCompactSpecFailure };

/**
 * `resolveCompactSpec`'s arithmetic for a policy that keeps DSH's ratios,
 * restated for code that runs where DSH is not installed. A host test holds it
 * against the installed function (src/dsh-host/lib/__tests__/hostCompaction.test.ts).
 */
export function dshCompactSpec(
  contextWindow: number,
  reservedCompletionTokens: number,
  headroomTokens: number = DSH_COMPACTION_HEADROOM_TOKENS
): DshCompactSpec {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    return { ok: false, failure: 'invalid_size' };
  }
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    return { ok: false, failure: 'invalid_size' };
  }
  const messageBudgetTokens = contextWindow - reservedCompletionTokens;
  if (messageBudgetTokens <= 0) return { ok: false, failure: 'no_message_budget' };
  const pressureBudgetTokens = messageBudgetTokens - headroomTokens;
  if (pressureBudgetTokens <= 0) return { ok: false, failure: 'no_pressure_budget' };
  const thresholdTokens = Math.floor(
    Math.min(contextWindow * DSH_COMPACTION_THRESHOLD_RATIO, pressureBudgetTokens)
  );
  const retainTokens = Math.floor(messageBudgetTokens * DSH_COMPACTION_RETAIN_RATIO);
  if (retainTokens >= thresholdTokens) return { ok: false, failure: 'retain_not_below_threshold' };
  return { ok: true, messageBudgetTokens, thresholdTokens, retainTokens };
}

/** Why a model gets no automatic compaction. */
export type AutoCompactionOffReason = 'window_too_small' | 'output_too_large';

/** What a policy was worked out for: the sizes the host hands `llm-pi-ai`. */
export interface AutoCompactionSize {
  contextWindow: number;
  /** The output reservation: the planned `maxTokens`, which every turn requests. */
  maxTokens: number;
}

interface AutoCompactionCommon extends AutoCompactionSize {
  /**
   * The summary request's output cap: the model's own limit, never more than
   * DSH's 65536, and within the headroom when the headroom was lowered. Also
   * what a manual `/compact` and overflow recovery ask for.
   */
  summaryMaxTokens: number;
}

export interface AutoCompactionOn extends AutoCompactionCommon {
  auto: true;
  /** Where automatic compaction starts, in DSH's own estimate of the request. */
  thresholdTokens: number;
  retainTokens: number;
  headroomTokens: number;
  /** The headroom is lowered from DSH's default (DSH's default leaves too small a span). */
  headroomLowered: boolean;
}

export interface AutoCompactionOff extends AutoCompactionCommon {
  auto: false;
  reason: AutoCompactionOffReason;
  /** `output_too_large`: the largest output limit with which automatic compaction runs. */
  maxOutputForAuto?: number;
}

export type AutoCompactionPolicy = AutoCompactionOn | AutoCompactionOff;

/**
 * The automatic compaction a model with these sizes gets (decision 177):
 *
 * 1. DSH's defaults, when they leave at least `AUTO_COMPACTION_MIN_SPAN_TOKENS`
 *    between the threshold and the retained tail.
 * 2. Otherwise the same retained tail with the headroom lowered just enough to
 *    leave that span, so the threshold sits exactly the span above the tail;
 *    allowed while the headroom stays at `AUTO_COMPACTION_MIN_HEADROOM_TOKENS`
 *    or more. The threshold rises with the budget on both sides of the switch.
 * 3. Otherwise none: lowering the output limit to `maxOutputForAuto` fixes it
 *    when that leaves at least `AUTO_COMPACTION_MIN_OUTPUT_TOKENS`, and the
 *    window is too small when it would not.
 *
 * Undefined for sizes that are not whole numbers (no plan row has them).
 */
export function autoCompactionPolicy(size: AutoCompactionSize): AutoCompactionPolicy | undefined {
  const { contextWindow, maxTokens } = size;
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined;
  if (!Number.isInteger(maxTokens) || maxTokens < 0) return undefined;
  const sizes = { contextWindow, maxTokens };
  // The summary is one more reply of this model: no more than its own limit.
  const outputCap =
    maxTokens > 0
      ? Math.min(DSH_COMPACTION_SUMMARY_MAX_TOKENS, maxTokens)
      : DSH_COMPACTION_SUMMARY_MAX_TOKENS;

  const dsh = dshCompactSpec(contextWindow, maxTokens);
  if (dsh.ok && dsh.thresholdTokens - dsh.retainTokens >= AUTO_COMPACTION_MIN_SPAN_TOKENS) {
    return {
      auto: true,
      ...sizes,
      thresholdTokens: dsh.thresholdTokens,
      retainTokens: dsh.retainTokens,
      headroomTokens: DSH_COMPACTION_HEADROOM_TOKENS,
      headroomLowered: false,
      summaryMaxTokens: outputCap,
    };
  }

  const budget = contextWindow - maxTokens;
  if (budget >= AUTO_COMPACTION_MIN_MESSAGE_BUDGET) {
    const retain = Math.floor(budget * DSH_COMPACTION_RETAIN_RATIO);
    const headroomTokens = Math.min(
      DSH_COMPACTION_HEADROOM_TOKENS,
      budget - retain - AUTO_COMPACTION_MIN_SPAN_TOKENS
    );
    const spec = dshCompactSpec(contextWindow, maxTokens, headroomTokens);
    if (
      spec.ok &&
      headroomTokens >= AUTO_COMPACTION_MIN_HEADROOM_TOKENS &&
      spec.thresholdTokens - spec.retainTokens >= AUTO_COMPACTION_MIN_SPAN_TOKENS
    ) {
      return {
        auto: true,
        ...sizes,
        thresholdTokens: spec.thresholdTokens,
        retainTokens: spec.retainTokens,
        headroomTokens,
        headroomLowered: headroomTokens < DSH_COMPACTION_HEADROOM_TOKENS,
        summaryMaxTokens: Math.min(outputCap, headroomTokens),
      };
    }
  }

  const maxOutputForAuto = contextWindow - AUTO_COMPACTION_MIN_MESSAGE_BUDGET;
  return maxOutputForAuto >= AUTO_COMPACTION_MIN_OUTPUT_TOKENS
    ? {
        auto: false,
        ...sizes,
        reason: 'output_too_large',
        maxOutputForAuto,
        summaryMaxTokens: outputCap,
      }
    : { auto: false, ...sizes, reason: 'window_too_small', summaryMaxTokens: outputCap };
}

/** The fields of one `modelPolicies` entry of `compaction-basic`, provider and model aside. */
export interface AutoCompactionOverride {
  headroomTokens?: number;
  maxTokens?: number;
}

/**
 * What `compaction-basic` must be told for this policy, or undefined when its
 * own defaults already are the policy. A lowered headroom always comes with
 * its `maxTokens`: alone, DSH would cap the summary at the headroom instead.
 */
export function autoCompactionOverride(
  policy: AutoCompactionPolicy
): AutoCompactionOverride | undefined {
  if (policy.auto && policy.headroomLowered) {
    return { headroomTokens: policy.headroomTokens, maxTokens: policy.summaryMaxTokens };
  }
  if (policy.summaryMaxTokens !== DSH_COMPACTION_SUMMARY_MAX_TOKENS) {
    return { maxTokens: policy.summaryMaxTokens };
  }
  return undefined;
}
