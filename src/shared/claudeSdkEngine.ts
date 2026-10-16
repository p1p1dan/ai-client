/**
 * Route B, S-1 (docs/plantree/plans/claude-sdk-engine/topics/s1-engine-selection.md):
 * what Main, the renderer and the SDK host agree on about the Claude Agent SDK
 * engine — which chats may run on it, the settings switch, and the codes it
 * adds. Pure and import-light, so the SDK host can load it by type stripping.
 */

import type { DshModelPlan } from './dshModelPlan/types.ts';

/** The engine a chat runs on, fixed when it is created. Absent anywhere means DSH. */
export type ChatEngine = 'dsh' | 'claude-sdk';

/**
 * The SDK host's session stub ends in this: a reopened chat runs on the engine
 * that created it, whatever the switch says now.
 */
export const CLAUDE_SDK_STUB_SUFFIX = '.ccsdk.json';

/**
 * Renderer-owned switch in `aiclient-settings`: new Claude chats run on the SDK
 * engine. On by default (plan §4 S-1); off sends them to DSH like every other
 * model. Existing chats keep their engine either way.
 */
export const CLAUDE_SDK_ENGINE_SETTING_KEY = 'claudeSdkEngineEnabled';
export const DEFAULT_CLAUDE_SDK_ENGINE_ENABLED = true;

/** Only a real boolean counts; anything else is the default. */
export function resolveClaudeSdkEngineEnabled(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_CLAUDE_SDK_ENGINE_ENABLED;
}

/** A Claude model, by its provider-side id (`claude-opus-5`, `claude-sonnet-5`, ...). */
export function isClaudeFamilyModelId(modelId: string): boolean {
  return /^claude-/i.test(modelId.trim());
}

/** Where a model runs when it runs on the SDK engine. */
export interface ClaudeSdkRoute {
  /** The plan's route name (`claude`, `claude~2`); a running SDK chat stays on one route. */
  route: string;
  /** Our provider id: whose key the gateway gets. */
  providerId: string;
  /** Gateway root, the CLI's `ANTHROPIC_BASE_URL` (the plan already strips `/v1`). */
  baseURL: string;
  /** Provider-side model id, what the CLI is asked for. */
  model: string;
}

type PlanView = Pick<DshModelPlan, 'index' | 'routes' | 'refs'>;

/**
 * `ref` when given, else the model a new chat would actually use: the plan's
 * first indexed model (the DSH route resolver's rule, `dshModelPlan/route.ts`).
 */
export function effectiveModelRef(
  plan: Pick<DshModelPlan, 'index'>,
  ref: string | null | undefined
): string | undefined {
  const requested = typeof ref === 'string' ? ref.trim() : '';
  return requested || Object.keys(plan.index)[0];
}

/**
 * The SDK route for `ref`, or null when the model is not one the SDK engine
 * serves: it must be in the plan, on an `anthropic-messages` route, and a
 * Claude model. Protocol alone is not enough — an Anthropic-compatible
 * endpoint can serve GLM and others, which stay on DSH (plan §2 rule 5).
 */
export function claudeSdkRouteFor(
  plan: PlanView,
  ref: string | null | undefined
): ClaudeSdkRoute | null {
  if (typeof ref !== 'string' || ref === '') return null;
  const entry = Object.hasOwn(plan.index, ref) ? plan.index[ref] : undefined;
  if (!entry) return null;
  const route = Object.hasOwn(plan.routes, entry.route) ? plan.routes[entry.route] : undefined;
  if (!route || route.api !== 'anthropic-messages') return null;
  if (!isClaudeFamilyModelId(entry.model)) return null;
  const providerId = Object.hasOwn(plan.refs, route.apiKeyEnv) ? plan.refs[route.apiKeyEnv] : '';
  if (!providerId || !route.baseURL) return null;
  return { route: entry.route, providerId, baseURL: route.baseURL, model: entry.model };
}

/**
 * `WorkerManagerError` code: a model of another engine, or of another route,
 * asked of a running SDK chat. The renderer hands the message back and says why.
 */
export const MODEL_ENGINE_MISMATCH = 'model_engine_mismatch';

/** `session.failed` code: an SDK chat's engine process exited mid-turn. */
export const CLAUDE_ENGINE_EXITED = 'claude_engine_exited';
