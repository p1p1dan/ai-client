/**
 * aiclient-permissions — ai-client's permission gate as a DSH host row
 * (dsh-rebase P1-6b; decisions 041, 042, 047, 048).
 *
 * The behaviour lives in `permissionHost.ts`; this file only wires it to the
 * row's Cordis context, publishes `ctx.aiclientPermissions`, the service the
 * bridge injects to attach one `PermissionGate` per chat session, and
 * registers two prompt contexts: `aiclient:permission` (`promptContext.ts`)
 * and `aiclient:environment` (`environmentContext.ts`, decision 164: the OS,
 * shell, workspace, home and date, with the `aiclient_cwd` / `aiclient_home`
 * prompt variables its text references).
 *
 * Always on in the product bundle (P1-6b part 2): the bridge injects the
 * service and attaches a gate per chat session before it opens the session's
 * agent. A call nothing attached is refused.
 *
 * Two ways in, like the bridge row (decision 011): a source checkout loads
 * `bundle/lib/permissions.js`, a one-line re-export of this file; the packaged
 * host loads the esbuild bundle scripts/build-dsh-host.mjs writes over it.
 */

import { LOOP_GUARD_SERVICE } from '../loopGuard/constants.ts';
import type {
  DshAgentView,
  DshApprovalOutcome,
  DshApprovalRequest,
  DshPostToolDecision,
  DshPreToolDecision,
  DshSessionView,
  DshToolCall,
  DshToolResult,
} from './dshTypes.ts';
import {
  ENVIRONMENT_CWD_VARIABLE,
  ENVIRONMENT_HOME_VARIABLE,
  ENVIRONMENT_PROMPT_CONTEXT,
  ENVIRONMENT_PROMPT_CONTEXT_BEFORE,
  ENVIRONMENT_PROMPT_CONTEXT_GAP,
  environmentPromptText,
  hostEnvironmentFacts,
} from './environmentContext.ts';
import { PERMISSION_HOST_SERVICE, PermissionHost } from './permissionHost.ts';
import { PERMISSION_PROMPT_CONTEXT, PERMISSION_PROMPT_CONTEXT_AFTER } from './promptContext.ts';
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
  /** A service this row reads without injecting it; `undefined` when absent. */
  get?(name: string): unknown;
  /**
   * Cordis `inject`: runs `callback` on a scope holding `deps` once they are
   * up (and again when they come back). Absent in a context without it.
   */
  inject?(deps: string[], callback: (scope: PromptRowScope) => void): unknown;
}

/** What a prompt context's text and a prompt variable's provider are given. */
export interface PromptAssemblyView {
  agent?: DshAgentView;
}

/** The slice of `ctx.systemPrompt` (dsh-system-prompt) the prompt contexts need. */
export interface PromptRowScope {
  systemPrompt: {
    context(context: {
      name: string;
      order: number;
      text: (assembly: PromptAssemblyView) => string;
    }): () => void;
    getContextOrder(
      name: typeof PERMISSION_PROMPT_CONTEXT_AFTER | typeof ENVIRONMENT_PROMPT_CONTEXT_BEFORE
    ): number;
    /** `{{name}}` in prompt text; a provider may return undefined when nothing references it. */
    variable(
      name: string,
      provider: (assembly: PromptAssemblyView) => string | undefined
    ): () => void;
  };
}

/** The slice of `ctx.aiclientLoopGuard` (P1-8) read here. */
interface LoopGuardView {
  refusalFor(exec: DshToolCall): string | undefined;
}

export function apply(ctx: PermissionRowContext): void {
  const environment = hostEnvironmentFacts();
  const host = new PermissionHost({
    loadParser: loadBashParser,
    // Decision 081 rule 2: looked up per call, not injected, so neither row
    // waits on the other and a host without the loop guard still gates.
    refusalFor: (exec) =>
      (ctx.get?.(LOOP_GUARD_SERVICE) as LoopGuardView | undefined)?.refusalFor(exec),
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
  // P1-6b: the posture, for the model. Not in `inject`: the gate must not
  // wait on prompt assembly, and a host without it still judges every call.
  // Decision 164: the environment beside it, on the same scope, so both go
  // away with it. Paths reach the text as variables, never spliced in.
  ctx.inject?.(['systemPrompt'], (scope) => {
    scope.systemPrompt.variable(
      ENVIRONMENT_CWD_VARIABLE,
      (assembly) => assembly.agent?.session?.header?.cwd
    );
    scope.systemPrompt.variable(ENVIRONMENT_HOME_VARIABLE, () => environment.homedir || undefined);
    scope.systemPrompt.context({
      name: ENVIRONMENT_PROMPT_CONTEXT,
      order:
        scope.systemPrompt.getContextOrder(ENVIRONMENT_PROMPT_CONTEXT_BEFORE) -
        ENVIRONMENT_PROMPT_CONTEXT_GAP,
      text: (assembly) => environmentPromptText(environment, assembly.agent),
    });
    scope.systemPrompt.context({
      name: PERMISSION_PROMPT_CONTEXT,
      order: scope.systemPrompt.getContextOrder(PERMISSION_PROMPT_CONTEXT_AFTER) + 1,
      text: (assembly) => host.promptContext(assembly.agent),
    });
  });
  ctx.provide(PERMISSION_HOST_SERVICE, host.api);
}
