/**
 * dsh-rebase P1-5a — the Main side of the DSH model plan (decision 033).
 *
 * The translation itself is the shared pure library `@shared/dshModelPlan`.
 * This module is the seam between it and the in-memory catalog: it hands the
 * library the `models` half and a yes/no per provider for the `auth` half, so
 * no key ever enters the plan. `index.ts` supplies the real inputs; tests
 * supply their own, as with `nativeCatalog.ts`.
 */

import {
  buildDshModelPlan,
  type DshModelPlan,
  type DshRouteSettingsInput,
} from '@shared/dshModelPlan';
import type { NativeModelCatalog } from './nativeCatalog';

/**
 * Which providers the `auth.json`-shaped document holds a usable key for.
 * Booleans only: this is the one place a key value is looked at, and only to
 * ask whether it is empty.
 */
export function providerKeyPresence(
  auth: Record<string, unknown> | undefined
): Record<string, boolean> {
  const presence: Record<string, boolean> = {};
  for (const [providerId, entry] of Object.entries(auth ?? {})) {
    const key = entry && typeof entry === 'object' ? (entry as { key?: unknown }).key : undefined;
    presence[providerId] = typeof key === 'string' && key.trim() !== '';
  }
  return presence;
}

export interface DshModelPlanDeps {
  /** `resolveNativeModelCatalog()`; `undefined` when no catalog could be assembled. */
  native: NativeModelCatalog | undefined;
  /** Expands `$NAME` header values, as the native runtime did in its own process. */
  env: Readonly<Record<string, string | undefined>>;
  settings: DshRouteSettingsInput;
  /** The app version, sent as `X-Pilab-Client` (decision 037). */
  clientVersion?: string;
  log?: (...args: unknown[]) => void;
}

let lastLoggedRevision: string | null = null;

type DshModelPlanListener = (plan: DshModelPlan) => void;
const planListeners = new Set<DshModelPlanListener>();

/**
 * Decision 033 rule 4: every plan Main builds (a menu read, a sync, a host
 * start) is announced, so a host running an older revision can be replaced
 * and the credential broker can drop keys the new plan no longer names.
 */
export function onDshModelPlanBuilt(listener: DshModelPlanListener): () => void {
  planListeners.add(listener);
  return () => planListeners.delete(listener);
}

/**
 * The plan for this catalog. With no catalog the plan is empty: the host can
 * serve nothing, and the menu built beside it says so rather than listing
 * models from a file nothing can authenticate against.
 */
export function resolveDshModelPlanWith(deps: DshModelPlanDeps): DshModelPlan {
  const plan = buildDshModelPlan({
    models: deps.native?.models ?? { providers: {} },
    keyed: providerKeyPresence(deps.native?.auth),
    env: deps.env,
    settings: deps.settings,
    ...(deps.clientVersion ? { clientVersion: deps.clientVersion } : {}),
  });
  // Once per revision, not per menu open.
  if (plan.revision !== lastLoggedRevision) {
    lastLoggedRevision = plan.revision;
    if (plan.dropped.length > 0) {
      deps.log?.('[dsh-model-plan] left out of the plan', {
        revision: plan.revision.slice(0, 12),
        dropped: plan.dropped.map((drop) =>
          drop.kind === 'model'
            ? `${drop.providerId}/${drop.modelId}: ${drop.reason}${drop.detail ? ` (${drop.detail})` : ''}`
            : `${drop.providerId}${drop.modelId ? `/${drop.modelId}` : ''} ${drop.field}: ${drop.reason}`
        ),
      });
    }
  }
  for (const listener of [...planListeners]) {
    try {
      listener(plan);
    } catch (error) {
      deps.log?.('[dsh-model-plan] a plan listener failed', error);
    }
  }
  return plan;
}
