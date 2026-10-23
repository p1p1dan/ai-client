/**
 * Route B, S-1 (docs/plantree/plans/claude-sdk-engine/topics/s1-engine-selection.md):
 * what Main, the renderer and the SDK host agree on about the Claude Agent SDK
 * engine — which chats may run on it, the settings switch, and the codes it
 * adds. Pure and import-light, so the SDK host can load it by type stripping.
 */

import type { DshModelPlan } from './dshModelPlan/types.ts';
import type { HostProxySetting } from './hostProxy.ts';

/** The engine a chat runs on, fixed when it is created. Absent anywhere means DSH. */
export type ChatEngine = 'dsh' | 'claude-sdk';

/**
 * The SDK host's session stub ends in this: a reopened chat runs on the engine
 * that created it, whatever the switch says now.
 */
export const CLAUDE_SDK_STUB_SUFFIX = '.ccsdk.json';

/**
 * Renderer-owned switch in `aiclient-settings`: new chats whose model is on the
 * Anthropic protocol run on the SDK engine. On by default (plan §4 S-1); off
 * sends them to DSH like every other model. Existing chats keep their engine
 * either way.
 */
export const CLAUDE_SDK_ENGINE_SETTING_KEY = 'claudeSdkEngineEnabled';
export const DEFAULT_CLAUDE_SDK_ENGINE_ENABLED = true;

/** Only a real boolean counts; anything else is the default. */
export function resolveClaudeSdkEngineEnabled(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_CLAUDE_SDK_ENGINE_ENABLED;
}

/**
 * Environment names (upper-cased; Windows names are case-insensitive) the SDK
 * host and the CLI under it may inherit: system paths, locale, proxies and the
 * trust store settings the DSH host inherits too, never credentials or any
 * `ANTHROPIC_*` / `CLAUDE_*` (plan §2 rule 2). Main and the host share this one list.
 */
export const CLAUDE_SDK_INHERITED_ENV: readonly string[] = [
  'PATH',
  'PATHEXT',
  // Windows PowerShell's module path. Without it the host's process query (Get-CimInstance,
  // processTree.ts) ran past 20 s on GitHub's Windows runners while it took 0.35 s with
  // it put back, alone (route B S-5 §8.3, README §11.2 #52); the CLI's own PowerShell
  // tool runs with it too.
  'PSMODULEPATH',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  // A private CA or a TLS-inspecting proxy: what lets the DSH host reach the
  // gateway must reach the CLI too.
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
];

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
 * The SDK route for `ref`, or null when the SDK engine does not serve it: it
 * must be in the plan, on an `anthropic-messages` route. The protocol is the
 * whole rule (user ruling 2026-10-16, plan §2 rule 5): whoever configures a
 * model on the Anthropic protocol declares it speaks Claude Code's requests —
 * Claude, or another model behind an Anthropic-compatible endpoint. Every
 * other protocol stays on DSH.
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
  const providerId = Object.hasOwn(plan.refs, route.apiKeyEnv) ? plan.refs[route.apiKeyEnv] : '';
  if (!providerId || !route.baseURL) return null;
  return { route: entry.route, providerId, baseURL: route.baseURL, model: entry.model };
}

/**
 * The CLI's per-model auto-compact window bounds (`modelSettings.<model>.autoCompactWindow`,
 * 2.1.300: "100000 to 1000000"). The CLI clamps the value to the model's own window.
 */
export const CLAUDE_SDK_AUTO_COMPACT_WINDOW_MIN = 100_000;
export const CLAUDE_SDK_AUTO_COMPACT_WINDOW_MAX = 1_000_000;

/** The SDK host's launch variable for {@link claudeSdkModelWindows}: JSON `{model: tokens}`, never a secret. */
export const CLAUDE_SDK_MODEL_WINDOWS_ENV = 'AICLIENT_CLAUDE_SDK_MODEL_WINDOWS';

/**
 * Route B (GPT usage check, user 2026-10-18): the context windows the catalog
 * declares on SDK route `routeName`, by the model id the CLI is asked for.
 *
 * The CLI sizes a model from its own table and never reads the catalog: a
 * Claude 5 model is 1,000,000 there, so a catalog that set claude-opus-5-5 to
 * 200,000 still ran to about 967k before compacting. The host hands the CLI
 * the smaller ones as per-model auto-compact windows (`catalogModelSettings`),
 * which do hold it to the catalog (measured on 2.1.300: 200,000 → threshold
 * 167,000), and compares a refusal's limit with all of them (the service took
 * less than the model is set to).
 */
export function claudeSdkModelWindows(
  plan: Pick<DshModelPlan, 'routes'> | null,
  routeName: string
): Record<string, number> {
  const route = plan && Object.hasOwn(plan.routes, routeName) ? plan.routes[routeName] : undefined;
  const windows: Record<string, number> = {};
  for (const model of route?.models ?? []) {
    const declared = model.contextWindow;
    if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) {
      windows[model.id] = declared;
    }
  }
  return windows;
}

/** {@link CLAUDE_SDK_MODEL_WINDOWS_ENV} read back; anything malformed is left out, never thrown. */
export function parseClaudeSdkModelWindows(raw: string | undefined): Record<string, number> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const windows: Record<string, number> = {};
  for (const [model, value] of Object.entries(parsed)) {
    if (model !== '' && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      windows[model] = value;
    }
  }
  return windows;
}

/**
 * User 2026-10-23: where an SDK chat compacts by itself, as a percentage of
 * its auto-compact window. The CLI's `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
 * (2.1.300): the threshold becomes `min(window × pct / 100, window − 13,000)`,
 * so 100 leaves the CLI's own threshold. A developer-mode setting
 * (`@shared/developerMode`); out of it, the default.
 */
export const CLAUDE_SDK_AUTO_COMPACT_PERCENT_SETTING_KEY = 'claudeSdkAutoCompactPercent';
export const DEFAULT_CLAUDE_SDK_AUTO_COMPACT_PERCENT = 60;
export const CLAUDE_SDK_AUTO_COMPACT_PERCENT_MIN = 10;
export const CLAUDE_SDK_AUTO_COMPACT_PERCENT_MAX = 100;

/** The SDK host's launch variable for the percentage Main read; the host passes it to the CLI. */
export const CLAUDE_SDK_AUTO_COMPACT_PERCENT_ENV = 'AICLIENT_CLAUDE_SDK_AUTO_COMPACT_PERCENT';

/** Only a whole number in range counts; anything else is the default. */
export function resolveClaudeSdkAutoCompactPercent(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CLAUDE_SDK_AUTO_COMPACT_PERCENT_MIN &&
    value <= CLAUDE_SDK_AUTO_COMPACT_PERCENT_MAX
    ? value
    : DEFAULT_CLAUDE_SDK_AUTO_COMPACT_PERCENT;
}

/** {@link CLAUDE_SDK_AUTO_COMPACT_PERCENT_ENV} read back, by the same rule. */
export function parseClaudeSdkAutoCompactPercent(raw: string | undefined): number {
  return resolveClaudeSdkAutoCompactPercent(raw?.trim() ? Number(raw.trim()) : undefined);
}

/**
 * User 2026-10-23: the SDK host's auth proxy drops the empty mid-conversation
 * `system` messages the CLI can send after a compaction (`authProxy.ts`). On by
 * default; a developer-mode setting, so off only while developer mode is on.
 */
export const CLAUDE_SDK_DROP_EMPTY_SYSTEM_SETTING_KEY = 'claudeSdkDropEmptySystemMessages';
export const DEFAULT_CLAUDE_SDK_DROP_EMPTY_SYSTEM = true;
/** The SDK host's launch variable for it: `0` off, anything else on. */
export const CLAUDE_SDK_DROP_EMPTY_SYSTEM_ENV = 'AICLIENT_CLAUDE_SDK_DROP_EMPTY_SYSTEM';

/** Only a real boolean counts; anything else is the default. */
export function resolveClaudeSdkDropEmptySystem(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_CLAUDE_SDK_DROP_EMPTY_SYSTEM;
}

/**
 * `WorkerManagerError` code: a model of another engine, or of another route,
 * asked of a running SDK chat. The renderer hands the message back and says why.
 */
export const MODEL_ENGINE_MISMATCH = 'model_engine_mismatch';

/** `session.failed` code: an SDK chat's engine process exited mid-turn. */
export const CLAUDE_ENGINE_EXITED = 'claude_engine_exited';

/**
 * Route B, S-2 (topic s2-permission-modes.md A-5): the Claude Agent SDK engine
 * refused a permission mode the host asked for. The worker's error code; its
 * message is one of `PERMISSION_MODE_REFUSAL_REASONS`, never the CLI's own
 * sentence. It reaches the renderer inside Electron's invoke error text as
 * `WORKER_PERMISSION_MODE_REFUSED: <reason>`.
 */
export const PERMISSION_MODE_REFUSED = 'WORKER_PERMISSION_MODE_REFUSED';

/** Why a mode was refused; the CLI's own codes where it gives one, `timeout` and `other` otherwise. */
export const PERMISSION_MODE_REFUSAL_REASONS = [
  'auto_mode_model',
  'auto_mode_settings',
  'auto_mode_circuit_breaker',
  'auto_mode_fast_mode',
  'auto_mode_unavailable',
  'bypass_disabled',
  'bypass_restricted',
  'bypass_not_launched',
  'invalid_mode',
  'timeout',
  'other',
] as const;
export type PermissionModeRefusalReason = (typeof PERMISSION_MODE_REFUSAL_REASONS)[number];

/** The refusal named in an error's text, `other` when none is. */
export function permissionModeRefusalReason(text: string): PermissionModeRefusalReason {
  return (
    PERMISSION_MODE_REFUSAL_REASONS.find((reason) =>
      new RegExp(`(?:^|[^a-z_])${reason}(?![a-z_])`).test(text)
    ) ?? 'other'
  );
}

/**
 * Route B, S-3 (topic s3-project-config.md K-5): Main hands the SDK host the
 * gateway key as the first IPC message, never as a launch variable (a
 * process's initial environment stays readable on Linux).
 */
export const CLAUDE_SDK_HOST_SECRET = 'host.secret';
export interface ClaudeSdkHostSecret {
  type: typeof CLAUDE_SDK_HOST_SECRET;
  apiKey: string;
  /**
   * Dsh-rebase decision 196: the product proxy the auth proxy's upstream leg
   * goes through (`null`: off, direct). Absent when Main keeps the engines off
   * it (rule 10): the host then follows its launch environment, as S-3 K-3
   * had it. Here rather than in the environment for the same reason as the
   * key: the URL may carry credentials.
   */
  proxy?: HostProxySetting | null;
}
export function isClaudeSdkHostSecret(value: unknown): value is ClaudeSdkHostSecret {
  const record = value as { type?: unknown; apiKey?: unknown } | null;
  return (
    typeof record === 'object' &&
    record !== null &&
    record.type === CLAUDE_SDK_HOST_SECRET &&
    typeof record.apiKey === 'string' &&
    record.apiKey.trim() !== ''
  );
}

/**
 * Dsh-rebase decision 196: the product proxy changed while the chat is open.
 * The host's auth proxy swaps its upstream route at once; the CLI keeps the
 * environment it started with. Never logged.
 */
export const CLAUDE_SDK_HOST_PROXY = 'host.proxy';
export interface ClaudeSdkHostProxyUpdate {
  type: typeof CLAUDE_SDK_HOST_PROXY;
  proxy: HostProxySetting | null;
}
export function isClaudeSdkHostProxyUpdate(value: unknown): value is ClaudeSdkHostProxyUpdate {
  const record = value as { type?: unknown } | null;
  return typeof record === 'object' && record !== null && record.type === CLAUDE_SDK_HOST_PROXY;
}
