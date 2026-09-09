import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { type Context, Service } from 'cordis';
import { AICLIENT_DEFAULT_PERMISSION_POLICY } from '../../../agent-host/permissionPolicy.mjs';
import {
  type LegacyPermissionTier,
  type PermissionGear,
  type RuntimeMode,
  type RuntimePermissionSettings,
  resolveRuntimePermission,
} from '../../../shared/types/runtimePermission.ts';
import { HOST_IO_SERVICE } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';
import { policyAction, type RuntimePermissionPolicy } from './policy.ts';

export const PERMISSIONS_SERVICE = 'runtimePermissions';
export const PERMISSION_TIMEOUT_MS = 120_000;
export type PermissionAction = 'allow' | 'ask' | 'deny';
export interface ToolPermissionRequest {
  tool: string;
  toolCallId: string;
  path: string;
  command?: string;
  paths?: readonly string[];
  commands?: readonly string[];
  unresolvedPaths?: boolean;
  exploration?: boolean;
}
export interface PermissionScope {
  root: string;
  tools: readonly string[];
  action: PermissionAction;
}
export interface PermissionConfig {
  cwd: string;
  mode?: RuntimeMode;
  gear?: PermissionGear;
  tier?: LegacyPermissionTier;
  allowedTools?: readonly string[];
  scopes?: readonly PermissionScope[];
  policy?: RuntimePermissionPolicy;
  projectTrusted?: boolean;
  approve?: (
    request: ToolPermissionRequest,
    signal: AbortSignal
  ) => Promise<'allow-once' | 'allow-session' | 'deny'>;
  timeoutMs?: number;
}
/**
 * How a gate resolved, in the vocabulary the timeline row already speaks.
 *
 * The deny arms are split rather than collapsed into one `error`, because the
 * transcript row derived from them is the only place a refusal explains itself:
 * "a rule forbade this" and "you said no" and "the turn was cancelled while the
 * dialog was open" produce the same missing tool result and are otherwise
 * indistinguishable after the modal is gone.
 */
export type PermissionDecisionSource =
  | 'policy'
  | 'session-grant'
  | 'allow-once'
  | 'allow-session'
  | 'policy-deny'
  | 'user-denied'
  | 'cancelled'
  | 'error';

/**
 * One observation about a gate, for observers that record rather than decide.
 *
 * Two phases because the transcript needs both halves: `prompt` says a question
 * was raised (the row that sits there while the modal is up), `decision` says
 * how it ended. A gate that never prompts — every `policy` allow — emits only
 * the second, and that record is the ONLY evidence the call was gated at all
 * rather than simply unchecked.
 */
export type PermissionActivityRecord =
  | { phase: 'prompt'; request: ToolPermissionRequest; mode: RuntimeMode; gear: PermissionGear }
  | {
      phase: 'decision';
      request: ToolPermissionRequest;
      decision: 'allow' | 'deny';
      source: PermissionDecisionSource;
      mode: RuntimeMode;
      gear: PermissionGear;
    };

export interface RuntimePermissionsService {
  /**
   * Watch gates resolve. Read-only by contract: a listener never decides,
   * delays or vetoes anything, and its exceptions are swallowed so a broken
   * observer cannot take the permission system down with it.
   */
  onActivity(listener: (record: PermissionActivityRecord) => void): () => void;
  authorize(request: ToolPermissionRequest, signal?: AbortSignal): Promise<void>;
  evaluate(request: ToolPermissionRequest): PermissionAction;
  isToolAllowed(name: string): boolean;
  configure(settings: Partial<RuntimePermissionSettings>): void;
  readonly mode: RuntimeMode;
  readonly gear: PermissionGear;
  readonly policy: RuntimePermissionPolicy | undefined;
  canTraverse(request: ToolPermissionRequest): boolean;
}

declare module 'cordis' {
  interface Context {
    runtimePermissions: RuntimePermissionsService;
  }
}

export class PermissionsPlugin extends Service implements RuntimePermissionsService {
  static inject = [HOST_IO_SERVICE];
  private readonly config: PermissionConfig;
  private readonly grants = new Set<string>();
  private readonly controller = new AbortController();
  private settings: RuntimePermissionSettings;
  private epoch = 0;
  private readonly listeners = new Set<(record: PermissionActivityRecord) => void>();

  constructor(ctx: Context, config: PermissionConfig) {
    super(ctx, PERMISSIONS_SERVICE);
    this.config = config;
    this.settings = resolveRuntimePermission(config);
    ctx.effect(() => () => {
      this.controller.abort();
      this.grants.clear();
      this.listeners.clear();
    });
  }
  get policy(): RuntimePermissionPolicy | undefined {
    return this.config.policy;
  }
  get mode(): RuntimeMode {
    return this.settings.mode;
  }
  get gear(): PermissionGear {
    return this.settings.gear;
  }
  configure(settings: Partial<RuntimePermissionSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.epoch++;
    this.grants.clear();
  }
  isToolAllowed(name: string): boolean {
    return !this.config.allowedTools || this.config.allowedTools.includes(name);
  }
  evaluate(request: ToolPermissionRequest): PermissionAction {
    if (!this.isToolAllowed(request.tool)) return 'deny';
    const inspectedPaths = [request.path, ...(request.paths ?? [])];
    const policy = this.config.policy;
    const decisions = policy
      ? [
          ...inspectedPaths.map((path) => policyAction(policy, 'path', [path], this.config.cwd)),
          ...(request.tool === 'bash'
            ? [request.command ?? '', ...(request.commands ?? [])]
            : [request.path]
          ).map((value) => policyAction(policy, request.tool, [value], this.config.cwd)),
          ...inspectedPaths
            .filter((path) => !containsPath(this.config.cwd, path))
            .map((path) => policyAction(policy, 'external_directory', [path], this.config.cwd)),
        ]
      : [];
    if (decisions.includes('deny')) return 'deny';
    const pathAction = pathPolicy(request.path);
    if (pathAction === 'deny') return 'deny';
    if ((request.paths ?? []).some((path) => pathPolicy(path) === 'deny')) return 'deny';
    if (
      this.mode === 'plan' &&
      (!['read', 'glob', 'grep', 'bash'].includes(request.tool) ||
        (request.tool === 'bash' && !request.exploration))
    )
      return 'deny';
    const matches = (this.config.scopes ?? []).filter(
      (scope) =>
        (scope.tools.includes('*') || scope.tools.includes(request.tool)) &&
        [request.path, ...(request.paths ?? [])].some((path) => containsPath(scope.root, path))
    );
    if (matches.some((scope) => scope.action === 'deny')) return 'deny';
    if (this.gear === 'auto') return 'allow';
    if (matches.some((scope) => scope.action === 'ask'))
      return this.grants.has(grantKey(request)) ? 'allow' : 'ask';
    if (
      inspectedPaths.every((path) =>
        matches.some((scope) => scope.action === 'allow' && containsPath(scope.root, path))
      )
    )
      return 'allow';
    if (this.grants.has(grantKey(request))) return 'allow';
    if (request.unresolvedPaths) return 'ask';
    if (
      pathAction === 'ask' ||
      !containsPath(this.config.cwd, request.path) ||
      (request.paths ?? []).some(
        (path) => !containsPath(this.config.cwd, path) || pathPolicy(path) === 'ask'
      )
    )
      return 'ask';
    if (
      policy &&
      inspectedPaths.some((path) => policyAction(policy, 'path', [path], this.config.cwd) === 'ask')
    )
      return 'ask';
    if (['read', 'grep', 'glob'].includes(request.tool))
      return decisions.includes('ask') ? 'ask' : 'allow';
    if (this.gear === 'accept-edits' && ['write', 'edit', 'bash'].includes(request.tool))
      return 'allow';
    return 'ask';
  }
  canTraverse(request: ToolPermissionRequest): boolean {
    if (
      this.config.policy &&
      policyAction(this.config.policy, 'path', [request.path], this.config.cwd) === 'ask' &&
      this.gear !== 'auto'
    )
      return false;
    if (pathPolicy(request.path) === 'deny' || this.evaluate(request) === 'deny') return false;
    if (pathPolicy(request.path) === 'ask' && this.gear !== 'auto') return false;
    return !(this.config.scopes ?? []).some(
      (scope) =>
        scope.action !== 'allow' &&
        (scope.tools.includes('*') || scope.tools.includes(request.tool)) &&
        [request.path, ...(request.paths ?? [])].some((path) => containsPath(scope.root, path))
    );
  }
  onActivity(listener: (record: PermissionActivityRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /**
   * Tell observers, without letting them affect the gate.
   *
   * Errors are contained here rather than at each call site: a listener throwing
   * inside `authorize` would surface as a denial, which is the one outcome an
   * observer must never be able to cause.
   */
  private notify(record: PermissionActivityRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // Read-only observer; a failure here is not the gate's problem.
      }
    }
  }
  async authorize(request: ToolPermissionRequest, signal?: AbortSignal): Promise<void> {
    let source: PermissionDecisionSource;
    try {
      source = await this.check(request, signal);
    } catch (error) {
      this.notify({
        phase: 'decision',
        request,
        decision: 'deny',
        source: error instanceof PermissionDenial ? error.source : 'error',
        mode: this.mode,
        gear: this.gear,
      });
      throw error;
    }
    this.notify({
      phase: 'decision',
      request,
      decision: 'allow',
      source,
      mode: this.mode,
      gear: this.gear,
    });
  }
  private async check(
    request: ToolPermissionRequest,
    signal?: AbortSignal
  ): Promise<PermissionDecisionSource> {
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    if (combined.aborted) throw denied('cancelled', 'permission request cancelled');
    const action = this.evaluate(request);
    if (action === 'deny')
      throw denied('policy-deny', `access denied: ${request.tool} ${request.path}`);
    if (action === 'allow') return this.grants.has(grantKey(request)) ? 'session-grant' : 'policy';
    if (!this.config.approve) throw denied('error', 'approval UI is not connected');
    // Announced before the await, so the transcript can show the gate is open
    // for as long as the dialog actually is.
    this.notify({ phase: 'prompt', request, mode: this.mode, gear: this.gear });
    const epoch = this.epoch;
    const controller = new AbortController();
    const approvalSignal = AbortSignal.any([combined, controller.signal]);
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? PERMISSION_TIMEOUT_MS
    );
    let abort: (() => void) | undefined;
    try {
      const cancelled = new Promise<'deny'>((resolve) => {
        abort = () => resolve('deny');
        approvalSignal.addEventListener('abort', abort, { once: true });
      });
      const decision = await Promise.race([
        this.config.approve(request, approvalSignal),
        cancelled,
      ]);
      if (approvalSignal.aborted || epoch !== this.epoch)
        throw denied('cancelled', 'permission request expired');
      if (decision === 'deny') throw denied('user-denied', 'permission denied');
      if (decision === 'allow-session') this.grants.add(grantKey(request));
      return decision;
    } finally {
      clearTimeout(timeout);
      if (abort) approvalSignal.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}
export function containsPath(root: string, path: string): boolean {
  const delta = relative(root, path);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}
function grantKey(request: ToolPermissionRequest): string {
  return JSON.stringify([request.tool, request.path, request.command ?? null, request.paths ?? []]);
}
/**
 * A refusal that remembers why.
 *
 * Still a `tool_denied` `RuntimeHostError`, so every existing `errorCode`
 * check keeps working; the extra field exists only so `authorize` can report
 * the reason instead of flattening every path to `error`.
 */
class PermissionDenial extends RuntimeHostError {
  readonly source: PermissionDecisionSource;
  constructor(source: PermissionDecisionSource, message: string) {
    super('tool_denied', message);
    this.source = source;
  }
}
function denied(source: PermissionDecisionSource, message: string): PermissionDenial {
  return new PermissionDenial(source, message);
}

export function pathPolicy(path: string): PermissionAction {
  let action: PermissionAction = 'allow';
  const candidate = path.replaceAll('\\', '/');
  for (const [pattern, value] of Object.entries(
    AICLIENT_DEFAULT_PERMISSION_POLICY.permission.path
  )) {
    if (value !== 'allow' && value !== 'ask' && value !== 'deny') continue;
    const expanded = pattern.startsWith('~/')
      ? resolve(homedir(), pattern.slice(2)).replaceAll('\\', '/')
      : pattern;
    const expression = expanded
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const regex = new RegExp(`^${expression}$`, process.platform === 'win32' ? 'i' : '');
    if (regex.test(candidate) || (!expanded.includes('/') && regex.test(basename(path))))
      action = value;
  }
  return action;
}
