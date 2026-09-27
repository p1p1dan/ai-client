// New in dsh-rebase P1-5a
/**
 * `resolveRoute`: our `provider/modelId` and effort choice → the DSH model
 * selection a turn (`installModelSelection`) or a one-shot completion
 * (`ctx.llm.stream`) should use (decision 035, decision 040 rule 2).
 */

import { isSessionEffortLevel } from '../types/agentHost.ts';
import type { DshEffortLevel, DshModelPlan } from './types.ts';

/** `session`: a chat turn. `completion`: a one-shot utility call (P1-15). */
export type DshRouteMode = 'session' | 'completion';

/** Codes a caller maps onto `session.failed` (`MODEL_NOT_CONFIGURED`, design 03 §5). */
export type DshRouteFailureCode = 'MODEL_NOT_IN_PLAN' | 'MODEL_CATALOG_EMPTY';

export type DshRouteResolution =
  | {
      ok: true;
      /** Our id the selection resolved from; the default model's when none was given. */
      modelId: string;
      selection: { provider: string; model: string; reasoningEffort?: DshEffortLevel };
      image: boolean;
      /** An explicit level the model cannot take, removed instead of failing the turn. */
      droppedEffort?: DshEffortLevel;
    }
  | { ok: false; code: DshRouteFailureCode; modelId?: string };

/**
 * Resolve one request.
 *
 * - No `modelId`: the plan's default model. A session caller passes its
 *   current selection first; only a new session or a completion lands here.
 * - A `modelId` the plan does not index: `MODEL_NOT_IN_PLAN`, so the renderer
 *   refreshes its catalog.
 * - No effort (or one outside the vocabulary, such as the renderer's
 *   `default`): a session sends `medium` when the model offers it, as the
 *   native loop did; a completion sends nothing.
 * - `off` in a completion sends nothing (the native utility path's rule).
 * - An explicit level the model does not offer is dropped, never sent: DSH
 *   would fail the turn with `UNSUPPORTED_REASONING_EFFORT`.
 */
export function resolveRoute(
  plan: DshModelPlan,
  modelId: string | null | undefined,
  effort: string | null | undefined,
  mode: DshRouteMode
): DshRouteResolution {
  const requested = typeof modelId === 'string' ? modelId.trim() : '';
  const ids = Object.keys(plan.index);
  if (ids.length === 0) {
    return { ok: false, code: 'MODEL_CATALOG_EMPTY', ...(requested ? { modelId: requested } : {}) };
  }
  // R9: the default model is the first indexed one.
  const resolvedId = requested || (ids[0] as string);
  const entry = Object.hasOwn(plan.index, resolvedId) ? plan.index[resolvedId] : undefined;
  if (!entry) return { ok: false, code: 'MODEL_NOT_IN_PLAN', modelId: resolvedId };

  const explicit = isSessionEffortLevel(effort) ? effort : undefined;
  let reasoningEffort: DshEffortLevel | undefined;
  let droppedEffort: DshEffortLevel | undefined;
  if (explicit === undefined) {
    if (mode === 'session' && entry.efforts.includes('medium')) reasoningEffort = 'medium';
  } else if (mode === 'completion' && explicit === 'off') {
    reasoningEffort = undefined;
  } else if (entry.efforts.includes(explicit)) {
    reasoningEffort = explicit;
  } else {
    droppedEffort = explicit;
  }

  return {
    ok: true,
    modelId: resolvedId,
    selection: {
      provider: entry.route,
      model: entry.model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
    image: entry.image,
    ...(droppedEffort ? { droppedEffort } : {}),
  };
}
