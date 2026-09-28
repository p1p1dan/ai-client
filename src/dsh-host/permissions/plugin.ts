/**
 * aiclient-permissions — ai-client's permission gate as a DSH host row
 * (dsh-rebase P1-6b; decisions 041, 042, 047, 048).
 *
 * The behaviour lives in `permissionHost.ts`; this file only wires it to the
 * row's Cordis context and publishes `ctx.aiclientPermissions`, the service
 * the bridge injects to attach one `PermissionGate` per chat session.
 *
 * Off in the product bundle until the bridge attaches gates (P1-6b part 2):
 * with the row on and nothing attached, every tool call is refused.
 *
 * Two ways in, like the bridge row (decision 011): a source checkout loads
 * `bundle/lib/permissions.js`, a one-line re-export of this file; the packaged
 * host loads the esbuild bundle scripts/build-dsh-host.mjs writes over it.
 */

import type {
  DshApprovalOutcome,
  DshApprovalRequest,
  DshPostToolDecision,
  DshPreToolDecision,
  DshSessionView,
  DshToolCall,
  DshToolResult,
} from './dshTypes.ts';
import { PERMISSION_HOST_SERVICE, PermissionHost } from './permissionHost.ts';
import { loadBashParser } from './treeSitter.ts';

export {
  type AttachedGate,
  type AttachGateOptions,
  type DshPermissionHost,
  PERMISSION_HOST_SERVICE,
} from './permissionHost.ts';

/** Stable Cordis plugin name. */
export const name = 'aiclient-permissions';

/** The tool registry, for the guard. Everything else is an event. */
export const inject = ['tools'];

type Listener = (...args: never[]) => unknown;

/** The slice of the row's Cordis context used here. */
export interface PermissionRowContext {
  on(name: string, listener: Listener, options?: { prepend?: boolean }): () => boolean;
  tools: { guard(guard: (exec: object) => string | undefined): () => void };
  provide(name: string, value: unknown): () => void;
}

export function apply(ctx: PermissionRowContext): void {
  const host = new PermissionHost({
    loadParser: loadBashParser,
    log: (...args) => console.error(...args),
  });
  ctx.on('session/created', (session: DshSessionView | undefined) =>
    host.onSessionCreated(session)
  );
  ctx.on('session/disposed', (session: DshSessionView | undefined) =>
    host.onSessionDisposed(session)
  );
  ctx.on(
    'tools/pre-execute',
    (exec: DshToolCall, next: () => Promise<DshPreToolDecision>) => host.preExecute(exec, next),
    { prepend: true }
  );
  ctx.tools.guard((exec) => host.guard(exec));
  // Prepend on purpose (experiment E3): a filtered result must not reach
  // tool-fs-search's spill, which runs after every earlier-activated row.
  ctx.on(
    'tools/post-execute',
    (exec: DshToolCall, result: DshToolResult, next: () => Promise<DshPostToolDecision>) =>
      host.postExecute(exec, result, next),
    { prepend: true }
  );
  ctx.on('tools/result', (exec: { callId?: string } | undefined) => host.onToolResult(exec));
  ctx.on(
    'approval/request',
    (request: DshApprovalRequest, next: () => Promise<DshApprovalOutcome>) =>
      host.answerApproval(request, next)
  );
  ctx.provide(PERMISSION_HOST_SERVICE, host.api);
}
