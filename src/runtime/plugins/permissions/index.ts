/**
 * The runtime's permission service: a thin Cordis wrapper (dsh-rebase P1-6a).
 *
 * The gate itself — judgement, queue, deadline, grants, audit records — lives
 * in `src/shared/permissions/gate.ts` so the DSH host can run the same code.
 * What stays here is only what is the runtime's own: the service name, the
 * transcript the grants are written to, and the `RuntimeHostError` a refusal
 * is thrown as. P1-12 deletes this file together with the runtime.
 */

import { type Context, Service } from 'cordis';
import {
  type DelegateCallScope,
  type PermissionAction,
  type PermissionActivityRecord,
  type PermissionConfig,
  type PermissionDecisionSource,
  PermissionGate,
  type PermissionGateService,
  type ToolPermissionRequest,
} from '../../../shared/permissions/gate.ts';
import {
  PERMISSION_GRANTS_ENTRY,
  type PersistedGrants,
} from '../../../shared/permissions/grants.ts';
import type {
  PermissionGear,
  RuntimeMode,
  RuntimePermissionSettings,
} from '../../../shared/types/runtimePermission.ts';
import { HOST_IO_SERVICE, SESSION_SERVICE } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';
import type { RuntimePermissionPolicy } from './policy.ts';

export {
  type DelegateCallScope,
  PERMISSION_TIMEOUT_MS,
  PERMISSION_TIMEOUT_REASON,
  type PermissionAction,
  type PermissionActivityRecord,
  type PermissionConfig,
  type PermissionDecisionSource,
  type PermissionQueueSlot,
  type PermissionScope,
  type ToolPermissionRequest,
} from '../../../shared/permissions/gate.ts';
export { containsPath } from '../../../shared/permissions/grants.ts';
export { type PathPolicyEnvironment, pathPolicy } from '../../../shared/permissions/pathPolicy.ts';

export const PERMISSIONS_SERVICE = 'runtimePermissions';

/** The gate's API under the name the runtime's plugins already use. */
export type RuntimePermissionsService = PermissionGateService;

declare module 'cordis' {
  interface Context {
    runtimePermissions: RuntimePermissionsService;
  }
}

export class PermissionsPlugin extends Service implements RuntimePermissionsService {
  static inject = [HOST_IO_SERVICE];
  private readonly gate: PermissionGate;

  constructor(ctx: Context, config: PermissionConfig) {
    super(ctx, PERMISSIONS_SERVICE);
    this.gate = new PermissionGate(config, {
      persistGrants: (record) => this.persistGrants(record),
      createDenial: (source, message) => new PermissionDenial(source, message),
    });
    ctx.effect(() => () => {
      this.gate.dispose();
    });
  }
  get policy(): RuntimePermissionPolicy | undefined {
    return this.gate.policy;
  }
  get mode(): RuntimeMode {
    return this.gate.mode;
  }
  get gear(): PermissionGear {
    return this.gate.gear;
  }
  configure(settings: Partial<RuntimePermissionSettings>): void {
    this.gate.configure(settings);
  }
  setGear(gear: PermissionGear): void {
    this.gate.setGear(gear);
  }
  scopeToolCall(toolCallId: string, scope: DelegateCallScope): () => void {
    return this.gate.scopeToolCall(toolCallId, scope);
  }
  isToolAllowed(name: string): boolean {
    return this.gate.isToolAllowed(name);
  }
  evaluate(request: ToolPermissionRequest): PermissionAction {
    return this.gate.evaluate(request);
  }
  canTraverse(request: ToolPermissionRequest): boolean {
    return this.gate.canTraverse(request);
  }
  onActivity(listener: (record: PermissionActivityRecord) => void): () => void {
    return this.gate.onActivity(listener);
  }
  authorize(request: ToolPermissionRequest, signal?: AbortSignal): Promise<void> {
    return this.gate.authorize(request, signal);
  }
  /**
   * Append the current grant set to the transcript, if there is one.
   *
   * Fire-and-forget on purpose. The gate is answering a user right now and a
   * session file that cannot be written must not turn their "Allow" into a
   * failed tool call — the cost of a lost append is that the grant does not
   * survive the next restart, which is exactly where this feature started.
   */
  private persistGrants(record: PersistedGrants): void {
    const session = this.ctx.get(SESSION_SERVICE);
    if (!session) return;
    void session
      .appendEntry({
        type: 'custom',
        customType: PERMISSION_GRANTS_ENTRY,
        data: record,
      })
      .catch(() => {
        // See above: persistence is best-effort, the decision already stands.
      });
  }
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
