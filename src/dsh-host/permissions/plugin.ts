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
 * prompt variables its text references). On Windows it also hides the skill
 * DSH's sandbox brings for a sandbox this app keeps off (decision 189).
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
  inject?(deps: string[], callback: (scope: RowScope) => void): unknown;
}

/** The services this row injects lazily; a callback reads only the ones it asked for. */
export type RowScope = PromptRowScope & SkillRowScope;

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

/** The slice of `ctx.skills` (dsh-skill) used to hide the sandbox's skills. */
export interface SkillRowScope {
  skills: {
    register(skill: {
      name: string;
      description: string;
      content: string;
      source: string;
      invocation: { modelInvocable: boolean; userInvocable: boolean };
    }): () => void;
  };
}

/** The slice of `ctx.aiclientLoopGuard` (P1-8) read here. */
interface LoopGuardView {
  refusalFor(exec: DshToolCall): string | undefined;
}

/**
 * Decision 189: skills dsh-sandbox-local brings for DSH's own sandbox, which
 * this app keeps off (decisions 044, 045). 0.2.0 registers the first one on
 * Windows; its script rewrites folder permissions to repair sandbox denials.
 */
export const HIDDEN_SANDBOX_SKILLS: readonly string[] = ['diagnose-windows-sandbox-acl'];

/**
 * Hides {@link HIDDEN_SANDBOX_SKILLS} where DSH registers them (Windows): a
 * runtime skill outranks a bundled one of the same name (dsh-skill ranks 250
 * and 600), and this one is invocable by neither the model nor the user, so
 * no catalog lists it and no load reaches DSH's copy. Elsewhere there is
 * nothing to hide, and an extra entry would change the bridge's skill count.
 */
export function hideSandboxSkills(
  ctx: PermissionRowContext,
  platform: string = process.platform
): void {
  if (platform !== 'win32') return;
  ctx.inject?.(['skills'], (scope) => {
    for (const name of HIDDEN_SANDBOX_SKILLS) {
      scope.skills.register({
        name,
        description: 'Unavailable: the DSH sandbox it repairs is off in this app.',
        content: '',
        source: 'runtime',
        invocation: { modelInvocable: false, userInvocable: false },
      });
    }
  });
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
  // glob's spill (tool-fs-search's, registered by aiclient-fs-search since
  // decision 190), which runs after every earlier-activated row.
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
  hideSandboxSkills(ctx);
  ctx.provide(PERMISSION_HOST_SERVICE, host.api);
}
