/**
 * Which DSH route serves a turn (dsh-rebase P1-5a; decisions 033, 035, 040).
 *
 * The renderer, the session index and the settings keep our own
 * `provider/modelId`; the host was configured with Main's model plan, and
 * `resolveRoute` (`@shared/dshModelPlan`) translates one into the other for
 * each request. A chat turn resolves in `session` mode (no effort chosen:
 * `medium` when the model offers it); a one-shot completion (P1-15) resolves
 * in `completion` mode through the same router. A model the plan cannot serve
 * is refused with `MODEL_NOT_CONFIGURED`, before anything is sent.
 */

import { MODEL_NOT_CONFIGURED } from '../../shared/dshFailureCodes.ts';
import { type DshRouteMode, resolveRoute } from '../../shared/dshModelPlan/route.ts';
import type {
  DshEffortLevel,
  DshModelPlan,
  DshPlanRoute,
} from '../../shared/dshModelPlan/types.ts';
import { BridgeSessionError } from './bridgeErrors.ts';

/** The plan as the host provides it (`aiclientModelPlan`): no nonce, nothing secret. */
export type DshBridgeModelPlan = Pick<DshModelPlan, 'revision' | 'defaultModel' | 'index'> & {
  /**
   * The routes, by the name DSH gives a step's `provider`, as far as decision
   * 173 reads them (`cacheChainReport.ts`): protocol and cache retention.
   * Routing never reads them.
   */
  readonly routes?: Readonly<Record<string, Partial<Pick<DshPlanRoute, 'api' | 'cacheRetention'>>>>;
};

/** What `installModelSelection` routes a request to (`@deepseek-ai/dsh-agent`). */
export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: DshEffortLevel;
}

/** One resolved request: our id, the DSH selection, and whether the model reads images. */
export interface DshRoutedModel {
  modelId: string;
  selection: DshModelSelection;
  image: boolean;
}

export class DshModelRouter {
  private readonly plan: () => DshBridgeModelPlan | undefined;
  private readonly log?: (...args: unknown[]) => void;

  constructor(plan: () => DshBridgeModelPlan | undefined, log?: (...args: unknown[]) => void) {
    this.plan = plan;
    this.log = log;
  }

  /** Whether the host was configured with a plan at all. */
  get configured(): boolean {
    return this.plan() !== undefined;
  }

  /** The plan's default model as a selection, for an agent opened before any turn. */
  defaultSelection(): DshModelSelection | undefined {
    const plan = this.plan();
    return plan ? { ...plan.defaultModel } : undefined;
  }

  /** A chat turn: `modelId` is the turn's model, or the session's current one. */
  session(modelId: string | null | undefined, effort: string | null | undefined): DshRoutedModel {
    return this.route(modelId, effort, 'session');
  }

  /** A one-shot completion (P1-15): no session, `off` and no effort both send none. */
  completion(
    modelId: string | null | undefined,
    effort: string | null | undefined
  ): DshRoutedModel {
    return this.route(modelId, effort, 'completion');
  }

  /** Like `session`, but undefined instead of a refusal (an agent opened before any turn). */
  trySession(
    modelId: string | null | undefined,
    effort: string | null | undefined
  ): DshRoutedModel | undefined {
    try {
      return this.session(modelId, effort);
    } catch {
      return undefined;
    }
  }

  private route(
    modelId: string | null | undefined,
    effort: string | null | undefined,
    mode: DshRouteMode
  ): DshRoutedModel {
    const plan = this.plan();
    if (!plan) {
      throw new BridgeSessionError(
        MODEL_NOT_CONFIGURED,
        'This engine was started without a model plan; no model can be reached'
      );
    }
    const resolved = resolveRoute(
      { ...plan, routes: {}, refs: {}, dropped: [] },
      modelId,
      effort,
      mode
    );
    if (!resolved.ok) {
      throw new BridgeSessionError(
        MODEL_NOT_CONFIGURED,
        resolved.code === 'MODEL_CATALOG_EMPTY'
          ? 'No model is available: sign in, or add a model service'
          : `Model ${resolved.modelId ?? ''} is not available (${resolved.code})`
      );
    }
    if (resolved.droppedEffort) {
      this.log?.(
        `[dsh-bridge] ${resolved.modelId} does not offer effort ${resolved.droppedEffort}; sending none`
      );
    }
    return { modelId: resolved.modelId, selection: resolved.selection, image: resolved.image };
  }
}
