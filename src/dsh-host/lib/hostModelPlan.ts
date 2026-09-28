/**
 * The DSH host's side of the model plan (dsh-rebase P1-5a; decision 033).
 *
 * Main's first IPC message to a host it spawned is `configure`: the plan's
 * routes (no key in them, only `apiKeyEnv` reference names), its default
 * model, index and reference table, and the nonce every credential request of
 * this host must carry. host.ts waits for it before it composes the profile,
 * then injects two in-memory overlays, `llm-pi-ai` and `agent-default-model`,
 * after every user layer; nothing is written to disk or to the environment.
 *
 * Bundled into host.js with host.ts, which may take in only its own `lib/`
 * (scripts/build-dsh-host.mjs): the protocol's guard and timeout are restated
 * here, and a test pins them to `src/shared/types/dshHostProtocol.ts`.
 */

import type { DshModelPlan, DshPlanModel, DshPlanRoute } from '../../shared/dshModelPlan/types.ts';
import type { DshRouteDiagnostic } from '../../shared/types/dshHostProtocol.ts';

/** `DSH_CONFIGURE_TIMEOUT_MS`: how long a host waits for `configure` before it refuses to boot. */
export const CONFIGURE_TIMEOUT_MS = 10_000;

/** What `configure` carries, validated. */
export interface HostModelPlan
  extends Pick<DshModelPlan, 'revision' | 'routes' | 'defaultModel' | 'index' | 'refs'> {
  nonce: string;
}

/** Placeholder route of a host that received no plan (no IPC): nothing can be served. */
const NO_PLAN_DEFAULT_MODEL = { provider: 'aiclient-none', model: 'none' };

/** The plan of a host run without IPC (by hand, for a boot check): no route at all. */
export function emptyHostModelPlan(): HostModelPlan {
  return {
    revision: 'none',
    nonce: '',
    routes: {},
    defaultModel: { ...NO_PLAN_DEFAULT_MODEL },
    index: {},
    refs: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Whether `message` is a `configure` at all, well formed or not. */
export function isConfigureMessage(message: unknown): boolean {
  return isRecord(message) && message.host === 'configure';
}

/**
 * The plan a `configure` message carries, or a reason it is refused. Shape
 * only, restating `isDshHostConfigure`, plus what host.ts relies on: every
 * route a record with a model list, and the default model's route among them
 * whenever there is any route.
 */
export function readConfigure(
  message: unknown
): { ok: true; plan: HostModelPlan } | { ok: false; reason: string } {
  if (!isRecord(message) || message.host !== 'configure') {
    return { ok: false, reason: 'not a configure message' };
  }
  const { nonce, revision, routes, index, refs, defaultModel } = message;
  if (!isNonEmptyString(nonce)) return { ok: false, reason: 'no nonce' };
  if (!isNonEmptyString(revision)) return { ok: false, reason: 'no revision' };
  if (!isRecord(routes) || !isRecord(index)) return { ok: false, reason: 'no routes or index' };
  if (!isRecord(refs) || !Object.values(refs).every(isNonEmptyString)) {
    return { ok: false, reason: 'malformed refs' };
  }
  if (
    !isRecord(defaultModel) ||
    !isNonEmptyString(defaultModel.provider) ||
    !isNonEmptyString(defaultModel.model)
  ) {
    return { ok: false, reason: 'malformed default model' };
  }
  for (const [route, profile] of Object.entries(routes)) {
    if (!isRecord(profile) || !Array.isArray(profile.models)) {
      return { ok: false, reason: `route ${JSON.stringify(route)} has no model list` };
    }
  }
  const routeCount = Object.keys(routes).length;
  if (routeCount > 0 && !Object.hasOwn(routes, defaultModel.provider)) {
    return { ok: false, reason: 'the default model names no route of the plan' };
  }
  return {
    ok: true,
    plan: {
      nonce,
      revision,
      routes: routes as DshModelPlan['routes'],
      defaultModel: { provider: defaultModel.provider, model: defaultModel.model },
      index: index as DshModelPlan['index'],
      refs: refs as DshModelPlan['refs'],
    },
  };
}

/** What `input` a model gets when the plan left it out: `llm-pi-ai`'s own `defaultInput`. */
const DEFAULT_INPUT: Array<'text' | 'image'> = ['text'];

/**
 * Decision 077 rule 2: every model states its context window, output limit
 * and input modalities. A route named like a pi-ai built-in provider (a user
 * service called "OpenAI" is route `openai`) would otherwise take them from
 * pi-ai's own catalog instead of the route's defaults (128000 / 8192).
 */
function sizedModel(model: DshPlanModel, route: DshPlanRoute): DshPlanModel {
  return {
    ...model,
    contextWindow: model.contextWindow ?? route.defaultContextWindow,
    maxTokens: model.maxTokens ?? route.defaultMaxTokens,
    input: model.input && model.input.length > 0 ? [...model.input] : [...DEFAULT_INPUT],
  };
}

/** The `llm-pi-ai` `providers` dict for this plan: its routes, every model sized. */
export function llmPiAiProviders(
  plan: Pick<HostModelPlan, 'routes'>
): Record<string, DshPlanRoute> {
  const providers: Record<string, DshPlanRoute> = {};
  for (const [name, route] of Object.entries(plan.routes)) {
    providers[name] = { ...route, models: route.models.map((model) => sizedModel(model, route)) };
  }
  return providers;
}

/**
 * The two launch overlays of decision 033, placed after the home layer: each
 * replaces its row's whole `config` (`dsh-app-boot` patch semantics).
 */
export function modelPlanOverlays(
  plan: Pick<HostModelPlan, 'routes' | 'defaultModel'>
): Array<{ id: string; config: Record<string, unknown> }> {
  return [
    { id: 'llm-pi-ai', config: { providers: llmPiAiProviders(plan) } },
    {
      id: 'agent-default-model',
      config: { provider: plan.defaultModel.provider, model: plan.defaultModel.model },
    },
  ];
}

/** The plan as the host's rows read it (`aiclientModelPlan`): everything but the nonce. */
export function publicModelPlan(plan: HostModelPlan): Omit<HostModelPlan, 'nonce'> {
  const { nonce: _nonce, ...rest } = plan;
  return rest;
}

/**
 * The plan's routes DSH did not take as they are, for `ready`. A route missing
 * from `llm`'s configurable-provider directory was never registered; one with
 * an `error` was registered with a catalog diagnostic. Empty when the plan's
 * translation rules and the installed DSH agree (the drift gate).
 */
export function routeDiagnostics(
  plan: Pick<HostModelPlan, 'routes'>,
  directory: ReadonlyArray<{ provider?: unknown; error?: unknown }> | undefined
): DshRouteDiagnostic[] {
  const entries = new Map<string, { error?: unknown }>();
  for (const entry of directory ?? []) {
    if (typeof entry.provider === 'string') entries.set(entry.provider, entry);
  }
  const out: DshRouteDiagnostic[] = [];
  for (const provider of Object.keys(plan.routes)) {
    const entry = entries.get(provider);
    if (!entry) {
      out.push({ provider, error: 'not registered by llm-pi-ai' });
    } else if (entry.error !== undefined && entry.error !== null && entry.error !== '') {
      out.push({ provider, error: String(entry.error) });
    }
  }
  return out;
}
