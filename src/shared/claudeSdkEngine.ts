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
