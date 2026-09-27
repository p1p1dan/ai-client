// New in dsh-rebase P1-5a
/**
 * The DSH model plan (decisions 033, 035, 036, 040): Main translates its
 * in-memory catalog into `llm-pi-ai` routes that carry no key, filters the
 * model menu by the same plan, and the bridge resolves each turn's model and
 * effort against it.
 *
 * A pure library shared by Main and the DSH host's bridge. It must not reach
 * into the runtime, the host, any DSH package or the file system (guarded by
 * `__tests__/dshModelPlanBoundaryStatic.test.ts`).
 */

export {
  buildDshModelPlan,
  effortsOf,
  isCredentialHeaderName,
  keyRefFor,
  translateReasoningEfforts,
} from './build.ts';
export { applyDshPlanToCatalog } from './menu.ts';
export {
  type DshRouteFailureCode,
  type DshRouteMode,
  type DshRouteResolution,
  resolveRoute,
} from './route.ts';
export { dshRouteSettings } from './settings.ts';
export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DSH_EFFORT_LEVELS,
  DSH_OFFERED_COMPAT,
  DSH_PROTOCOLS,
  EMPTY_PLAN_DEFAULT_MODEL,
  KEY_REF_PREFIX,
} from './tables.ts';
export type * from './types.ts';
