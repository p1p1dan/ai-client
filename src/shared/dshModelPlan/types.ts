// New in dsh-rebase P1-5a
/**
 * The model plan: what Main hands the shared DSH host instead of a catalog
 * with keys in it (decision 033), and what the model menu is filtered by.
 *
 * Every field is safe to log and to hold in the host's memory: a route names
 * its key by reference (`apiKeyEnv`) and never carries one. The key itself is
 * pulled per request (decision 034, P1-5b).
 */

import type { SessionEffortLevel } from '../types/agentHost.ts';
import type { PromptCacheTtl } from '../types/promptCacheTtl.ts';
import type { RequestUserAgentMode, RequestUserAgentProblem } from '../types/requestUserAgent.ts';

/** DSH's effort vocabulary is ours word for word (`dsh-llm-pi-ai` lib/index.js:297-305). */
export type DshEffortLevel = SessionEffortLevel;

/** The only wire protocols a hand-declared `llm-pi-ai` route may name (decision 036). */
export type DshProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

/** One `models[]` entry of an `llm-pi-ai` route. */
export interface DshPlanModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
  /** `false` for a non-reasoning model; otherwise every offered level with its wire value. */
  reasoningEfforts: false | Partial<Record<DshEffortLevel, string>>;
  compat?: Record<string, unknown>;
}

export interface DshRetryPolicy {
  mode: 'normal';
  maxRetries: number;
  backoff: { initialDelayMs: number; maxDelayMs: number };
}

/** The route-level knobs mapped from our settings (decision 040 rule 3). */
export interface DshRouteSettings {
  cacheRetention: 'short' | 'long';
  streamIdleTimeoutMs: number;
  retryPolicy: DshRetryPolicy;
}

/** Our settings, as read by Main. Absent means "the user never touched it". */
export interface DshRouteSettingsInput {
  promptCacheTtl?: PromptCacheTtl;
  providerIdleTimeoutMs?: number;
  /**
   * GW-16 temporary switch (decision 159): `true` keeps pi-ai's breakpoint on
   * the last tool of an anthropic-messages request. Absent or `false` plans
   * `compat.supportsCacheControlOnTools: false` on those routes.
   */
  cacheControlOnTools?: boolean;
  /**
   * Decision 171: the User-Agent every route sends (`requestUserAgentMode`).
   * Absent means the default, `claude-cli-pilab/<clientVersion>`.
   */
  userAgentMode?: RequestUserAgentMode;
  /** Decision 171: the custom value as stored; read in `custom` mode only, and checked here. */
  userAgentCustom?: string;
}

/** One `llm-pi-ai` provider profile, keyed in `routes` by the route name. */
export interface DshPlanRoute extends DshRouteSettings {
  api: DshProtocol;
  baseURL: string;
  /** A reference name the credential provider resolves; never a key. */
  apiKeyEnv: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  defaultContextWindow: number;
  defaultMaxTokens: number;
  models: DshPlanModel[];
}

/** Our `provider/modelId` → where DSH serves it. */
export interface DshPlanIndexEntry {
  route: string;
  model: string;
  /** Selectable levels in escalation order; empty for a non-reasoning model. */
  efforts: DshEffortLevel[];
  image: boolean;
}

/** Why a model the catalog lists is not in the plan. */
export type DshModelDropReason =
  | 'unsupported_api'
  | 'no_base_url'
  | 'no_api_key'
  | 'credential_header';

/** Why a field was left out of a route or model that stays in the plan. */
export type DshFieldDropReason =
  | 'compat_not_offered'
  | 'compat_unset'
  | 'sampling_params'
  | 'reserved_header'
  | 'unresolved_header'
  | 'invalid_header'
  /** Decision 141: `off` cannot be offered to a row forced onto adaptive thinking. */
  | 'adaptive_thinking_forced'
  /** Decision 141: advisory only — a reasoning row with no declared adaptive-only compat. */
  | 'adaptive_thinking_undeclared'
  /**
   * Decision 146: not left out but replaced — `maxTokens` over half the row's
   * `contextWindow` is planned as a quarter of it (`detail`: `<declared> -> <planned>`).
   */
  | 'max_tokens_clamped';

/** Why a setting was not planned as it stands (decision 171). */
export type DshSettingDropReason =
  /**
   * The User-Agent choice fails the shared check (`detail`: why): a custom
   * value is planned as the default, an unusable default as DSH's own.
   */
  'invalid_user_agent';

export type DshPlanDrop =
  | {
      kind: 'model';
      providerId: string;
      modelId: string;
      reason: DshModelDropReason;
      detail?: string;
    }
  | {
      kind: 'field';
      providerId: string;
      modelId?: string;
      field: string;
      reason: DshFieldDropReason;
      detail?: string;
    }
  | {
      kind: 'setting';
      setting: 'userAgent';
      reason: DshSettingDropReason;
      detail: RequestUserAgentProblem;
    };

export interface DshModelPlan {
  /** sha256 of the canonical JSON of `routes`, `defaultModel` and `index`. */
  revision: string;
  routes: Record<string, DshPlanRoute>;
  defaultModel: { provider: string; model: string };
  /** In catalog order. */
  index: Record<string, DshPlanIndexEntry>;
  /** Reference name → our provider id. */
  refs: Record<string, string>;
  dropped: DshPlanDrop[];
}

export interface DshModelPlanInput {
  /** The `models.json` half of the in-memory catalog (`toPiModelsJson` + user services). */
  models: Record<string, unknown>;
  /** Whether each provider has a non-empty key. Booleans only; no key reaches this module. */
  keyed: Readonly<Record<string, boolean>>;
  /** Environment used to expand `$NAME` header values, as the native runtime does. */
  env?: Readonly<Record<string, string | undefined>>;
  settings?: DshRouteSettingsInput;
  /**
   * The app version, sent on every route as `X-Pilab-Client` (decision 037),
   * and the version of the default User-Agent (decision 171).
   */
  clientVersion?: string;
}
