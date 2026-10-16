// New in dsh-rebase P1-5a
/**
 * The model menu, cut down to what the plan routes (decision 033 rule 3).
 *
 * Main builds the menu and the plan from the SAME in-memory catalog and joins
 * them here, so a model is offered exactly when the host can serve it, and
 * with exactly the efforts the host accepts. What the plan left out is not
 * silently lost: it is counted in `unavailable` for the menu's footer.
 *
 * Decision 177: each offered model also carries its automatic compaction, from
 * the same sizes the host hands `llm-pi-ai` and the same rules the host turns
 * into `compaction-basic`'s policies, for the settings to show.
 *
 * Route B, S-1 (decision 5): a model the Claude Agent SDK engine serves also
 * carries its route (`sdkRoute`), so an SDK chat's menu offers only the models
 * of the route it runs on.
 */

import { claudeSdkRouteFor } from '../claudeSdkEngine.ts';
import { autoCompactionPolicy } from '../dshAutoCompaction.ts';
import type {
  AgentModelAutoCompaction,
  AgentModelCatalog,
  AgentModelUnavailable,
} from '../types/agentCatalog.ts';
import type { DshModelDropReason, DshModelPlan, DshPlanIndexEntry } from './types.ts';

/**
 * The routed row's automatic compaction, the row sized like the host sizes it
 * (`sizedModel`: the route's defaults fill what the row left out).
 */
function autoCompactionOf(
  plan: DshModelPlan,
  entry: DshPlanIndexEntry
): AgentModelAutoCompaction | undefined {
  const route = Object.hasOwn(plan.routes, entry.route) ? plan.routes[entry.route] : undefined;
  const row = route?.models.find((model) => model.id === entry.model);
  if (!route || !row) return undefined;
  const policy = autoCompactionPolicy({
    contextWindow: row.contextWindow ?? route.defaultContextWindow,
    maxTokens: row.maxTokens ?? route.defaultMaxTokens,
  });
  return policy && { ...policy, contextWindowDefaulted: row.contextWindow === undefined };
}

export function applyDshPlanToCatalog(
  catalog: AgentModelCatalog,
  plan: DshModelPlan
): AgentModelCatalog {
  const reasons = new Map<string, DshModelDropReason>();
  for (const drop of plan.dropped) {
    if (drop.kind === 'model') reasons.set(`${drop.providerId}/${drop.modelId}`, drop.reason);
  }
  const models: AgentModelCatalog['models'] = [];
  const unavailable: AgentModelUnavailable[] = [];
  for (const option of catalog.models) {
    const entry = Object.hasOwn(plan.index, option.id) ? plan.index[option.id] : undefined;
    if (entry) {
      const autoCompaction = autoCompactionOf(plan, entry);
      const sdkRoute = claudeSdkRouteFor(plan, option.id)?.route;
      const { sdkRoute: _stale, ...offered } = option;
      models.push({
        ...offered,
        efforts: [...entry.efforts],
        ...(autoCompaction ? { autoCompaction } : {}),
        ...(sdkRoute ? { sdkRoute } : {}),
      });
    } else {
      // `not_in_plan`: no catalog could be assembled for the plan at all (for
      // example a locked keyring), so the menu's rows come from somewhere the
      // host cannot reach.
      unavailable.push({ label: option.label, reason: reasons.get(option.id) ?? 'not_in_plan' });
    }
  }
  const { unavailable: _stale, ...rest } = catalog;
  return { ...rest, models, ...(unavailable.length > 0 ? { unavailable } : {}) };
}
