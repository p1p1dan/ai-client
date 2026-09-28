/**
 * The `aiclient-permissions` row's behaviour, free of Cordis (dsh-rebase
 * decisions 042, 047, 048; P1-6b).
 *
 *   tools/pre-execute (prepend)  route the call to its chat session's gate,
 *                                judge it there, then `next()`; a refusal is
 *                                `deny`, a cancelled card is `cancel`
 *                                (ABORTED_BEFORE_DISPATCH, experiment E5)
 *   guard                        refuse every call this row did not allow, so
 *                                a listener that answers before it and skips
 *                                `next()` cannot bypass the gate (E2)
 *   tools/post-execute (prepend) drop denied entries from glob / grep values;
 *                                returns without `next()` when it filtered,
 *                                because tool-fs-search, which runs after this
 *                                row (E3), would spill the unfiltered list
 *   approval/request             answer DSH's own asks for attached sessions:
 *                                at most one card per call id; the card
 *                                offers allow / deny, and an escalation says
 *                                so (`escalate_sandbox`)
 *   session/created, /disposed   register subagent / workflow children (E1)
 *   systemPrompt context         `aiclient:permission`: the mode and gear of
 *                                the calling session's gate (`promptContext`)
 *
 * Gates are attached per chat session by the bridge (`attachGate`); this row
 * never builds one.
 */

import { realpathSync } from 'node:fs';
import { opendir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { analyzeBash, type BashParser } from '../../shared/permissions/bashWalker.ts';
import { errorCode } from '../../shared/permissions/errors.ts';
import {
  denialSource,
  type PermissionGateService,
  type ToolPermissionRequest,
} from '../../shared/permissions/gate.ts';
import type { PermissionFileSystem } from '../../shared/permissions/shellPaths.ts';
import { TURN_CEILING_REFUSAL_CODE } from '../loopGuard/constants.ts';
import { classifyTool } from './classification.ts';
import type {
  DshAgentView,
  DshApprovalOutcome,
  DshApprovalRequest,
  DshPostToolDecision,
  DshPreToolDecision,
  DshSessionView,
  DshToolCall,
  DshToolErrorInfo,
  DshToolResult,
} from './dshTypes.ts';
import { permissionPromptText } from './promptContext.ts';
import { authorizeCall } from './requestBuilder.ts';
import { PermissionRouter } from './router.ts';
import { filterSearchValue } from './searchFilter.ts';

/** The Cordis service name the bridge injects to reach `attachGate`. */
export const PERMISSION_HOST_SERVICE = 'aiclientPermissions';

/**
 * The gate surface this row uses; `PermissionGate` fits as is. `mode` and
 * `gear` feed the prompt context; a gate without them contributes none.
 */
export type AttachableGate = Pick<
  PermissionGateService,
  'authorize' | 'canTraverse' | 'onActivity'
> &
  Partial<Pick<PermissionGateService, 'mode' | 'gear'>>;

export interface AttachGateOptions {
  /** The chat session's root DSH session id; its delegates join it from `session/created`. */
  dshSessionId: string;
  gate: AttachableGate;
  /** Fallback workspace when a calling session's header carries no cwd. */
  cwd?: string;
  /** What bash analysis expands `$HOME` and friends against; defaults to the host's environment. */
  env?: Record<string, string>;
}

export interface AttachedGate {
  readonly channelId: string;
  readonly dshSessionId: string;
  /** Same as `detachGate(channelId)`, but only while this attachment is current. */
  detach(): void;
}

/** What the bridge sees (`ctx.aiclientPermissions`). */
export interface DshPermissionHost {
  /**
   * Route every call of `options.dshSessionId` (and its delegates) to
   * `options.gate`. Calling it again for the same channel re-points it: a new
   * DSH id (rewind) keeps the old id resolving to the channel.
   */
  attachGate(channelId: string, options: AttachGateOptions): AttachedGate;
  /** Stop routing a channel; its calls are refused from now on. False when it was not attached. */
  detachGate(channelId: string): boolean;
  isAttached(channelId: string): boolean;
}

export interface PermissionHostOptions {
  fs?: PermissionFileSystem;
  /** The tree-sitter bash parser, loaded on the first bash call. */
  loadParser: () => Promise<BashParser>;
  env?: Record<string, string>;
  /** Paths the host wrote for the model to read (spill files). Defaults to `$TMPDIR/dsh-spill-*`. */
  isTrustedPath?: (path: string) => boolean;
  /** Ledger bound: call ids whose result never arrived are forgotten oldest first. */
  maxTrackedCalls?: number;
  /**
   * Why a call may not run at all, asked before the gate (decision 081 rule 2):
   * the loop guard's `refusalFor`, so a call of a wrap-up step is refused
   * without a card whatever order the rows' listeners run in.
   */
  refusalFor?: (exec: DshToolCall) => string | undefined;
  log?: (...args: unknown[]) => void;
}

interface Attachment {
  gate: AttachableGate;
  cwd?: string;
  env?: Record<string, string>;
  release: () => void;
}

/** What the gate did for one call id, for the approval answerer. */
interface CallRecord {
  prompted: boolean;
  verdict?: 'allow' | 'deny';
}

const DENIAL_NAME = 'PermissionDenial';
const NOT_ATTACHED = 'permission gate not attached';
const GUARD_REASON = 'permission gate did not run';

/** How dsh-sandbox's `approveEscalation` words the reason of an escalation it asks for. */
const SANDBOX_ESCALATION = /^escalate sandbox to /;

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
}

const nodeFs: PermissionFileSystem = {
  realpath: (path) => realpath(path),
  readDirectory: (path) =>
    (async function* () {
      yield* await opendir(path);
    })(),
};

/** `$TMPDIR/dsh-spill-*`, dsh-spill-local's private per-process roots. */
export function isSpillPath(path: string, root: string = spillParent()): boolean {
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return rel.split(sep)[0].startsWith('dsh-spill-');
}

let tmpRoot: string | undefined;
function spillParent(): string {
  if (tmpRoot === undefined) {
    try {
      tmpRoot = realpathSync(tmpdir());
    } catch {
      tmpRoot = tmpdir();
    }
  }
  return tmpRoot;
}

function info(code: string, reason?: string): DshToolErrorInfo {
  return { name: DENIAL_NAME, code, ...(reason ? { reason } : {}) };
}

/** A refusal in DSH's shape; the reason text is the 1.0.x wording the model already knows. */
export function denialDecision(error: unknown): DshPreToolDecision {
  const message = error instanceof Error ? error.message : String(error);
  const source = denialSource(error);
  if (source) return { kind: 'deny', reason: message, info: info('tool_denied', source) };
  const code = errorCode(error);
  if (code === 'tool_denied')
    return { kind: 'deny', reason: message, info: info('tool_denied', 'policy-deny') };
  if (code) return { kind: 'deny', reason: message, info: info(code) };
  return {
    kind: 'deny',
    reason: `permission check failed: ${message}`,
    info: info('permission_error'),
  };
}

export class PermissionHost {
  readonly api: DshPermissionHost;
  private readonly router = new PermissionRouter<Attachment>();
  /** Executions this row allowed; the guard refuses the rest. */
  private readonly allowed = new WeakSet<object>();
  private readonly calls = new Map<string, CallRecord>();
  private readonly fs: PermissionFileSystem;
  private readonly env: Record<string, string>;
  private readonly isTrustedPath: (path: string) => boolean;
  private readonly maxTrackedCalls: number;
  private readonly options: PermissionHostOptions;
  private syntheticIds = 0;

  constructor(options: PermissionHostOptions) {
    this.options = options;
    this.fs = options.fs ?? nodeFs;
    this.env = options.env ?? processEnv();
    this.isTrustedPath = options.isTrustedPath ?? ((path) => isSpillPath(path));
    this.maxTrackedCalls = options.maxTrackedCalls ?? 4096;
    this.api = {
      attachGate: (channelId, attach) => this.attachGate(channelId, attach),
      detachGate: (channelId) => this.detachGate(channelId),
      isAttached: (channelId) => this.router.channel(channelId) !== undefined,
    };
  }

  // ---- attachment -------------------------------------------------------------

  attachGate(channelId: string, options: AttachGateOptions): AttachedGate {
    const previous = this.router.channel(channelId);
    const unsubscribe = options.gate.onActivity((record) => {
      if (record.phase !== 'prompt') return;
      const call = this.calls.get(record.request.toolCallId);
      if (call) call.prompted = true;
    });
    const gate: Attachment = {
      gate: options.gate,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      release: unsubscribe,
    };
    try {
      this.router.attach({ channelId, dshSessionId: options.dshSessionId, gate });
    } catch (error) {
      unsubscribe();
      throw error;
    }
    if (previous && previous.gate !== gate) previous.gate.release();
    return {
      channelId,
      dshSessionId: options.dshSessionId,
      detach: () => {
        if (this.router.channel(channelId)?.gate === gate) this.detachGate(channelId);
      },
    };
  }

  detachGate(channelId: string): boolean {
    const target = this.router.detach(channelId);
    target?.gate.release();
    return target !== undefined;
  }

  // ---- sessions -----------------------------------------------------------------

  onSessionCreated(session: DshSessionView | undefined): void {
    this.router.noteSession(session?.header);
  }

  onSessionDisposed(session: DshSessionView | undefined): void {
    if (session?.id) this.router.forgetSession(session.id);
  }

  /**
   * The `aiclient:permission` context for the agent a prompt is assembled
   * for: the mode and gear of its chat session's gate (a delegate shares its
   * root's). Empty for an agent no gate owns, which contributes nothing.
   */
  promptContext(agent: DshAgentView | undefined): string {
    const gate = this.routeOf(agent)?.gate.gate;
    if (!gate?.mode || !gate.gear) return '';
    return permissionPromptText(gate.mode, gate.gear);
  }

  // ---- tools ------------------------------------------------------------------------

  private routeOf(agent: DshToolCall['agent']) {
    return this.router.resolve(agent?.id, agent?.session?.header);
  }

  async preExecute(
    exec: DshToolCall,
    next: () => Promise<DshPreToolDecision>
  ): Promise<DshPreToolDecision> {
    const route = this.routeOf(exec.agent);
    if (!route)
      return { kind: 'deny', reason: NOT_ATTACHED, info: info('tool_denied', 'unattached') };
    // Before any question: a call the loop guard refuses never raises a card.
    const refusal = this.options.refusalFor?.(exec);
    if (refusal !== undefined)
      return {
        kind: 'deny',
        reason: refusal,
        info: { name: 'LoopGuard', code: TURN_CEILING_REFUSAL_CODE },
      };
    if (classifyTool(exec.name) === 'internal') {
      this.allowed.add(exec);
      return next();
    }
    const cwd = exec.agent?.session?.header?.cwd ?? route.gate.cwd;
    if (!cwd)
      return {
        kind: 'deny',
        reason: 'the calling session has no workspace',
        info: info('tool_denied', 'error'),
      };
    const record: CallRecord = { prompted: false };
    this.track(exec.callId, record);
    const env = route.gate.env ?? this.env;
    try {
      await authorizeCall(
        { name: exec.name, callId: exec.callId, arguments: exec.arguments, signal: exec.signal },
        {
          gate: route.gate.gate,
          cwd,
          fs: this.fs,
          analyzeBash: async (command, workdir) =>
            analyzeBash(await this.options.loadParser(), command, workdir, env),
          isTrustedPath: this.isTrustedPath,
          ...(route.delegate
            ? {
                delegation: {
                  delegationId: route.delegate.sessionId,
                  agentName: route.delegate.agentPreset ?? 'subagent',
                },
              }
            : {}),
        }
      );
    } catch (error) {
      record.verdict = 'deny';
      if (exec.signal.aborted || denialSource(error) === 'cancelled') return { kind: 'cancel' };
      return denialDecision(error);
    }
    record.verdict = 'allow';
    this.allowed.add(exec);
    return next();
  }

  guard(exec: object): string | undefined {
    return this.allowed.has(exec) ? undefined : GUARD_REASON;
  }

  async postExecute(
    exec: DshToolCall,
    result: DshToolResult,
    next: () => Promise<DshPostToolDecision>
  ): Promise<DshPostToolDecision> {
    if (classifyTool(exec.name) !== 'search' || result.isError || result.value === undefined)
      return next();
    const route = this.routeOf(exec.agent);
    const cwd = exec.agent?.session?.header?.cwd ?? route?.gate.cwd;
    if (!route || !cwd) return next();
    const filtered = filterSearchValue(exec.name, exec.callId, result.value, cwd, route.gate.gate);
    if (!filtered) return next();
    // Deliberately no next(): the listeners after this one include
    // tool-fs-search's spill, which would write the unfiltered list to disk.
    return { kind: 'accept', value: filtered.value };
  }

  onToolResult(exec: { callId?: string } | undefined): void {
    if (exec?.callId) this.calls.delete(exec.callId);
  }

  // ---- DSH's own asks -------------------------------------------------------------

  async answerApproval(
    request: DshApprovalRequest,
    next: () => Promise<DshApprovalOutcome>
  ): Promise<DshApprovalOutcome> {
    const route = this.routeOf(request.agent);
    if (!route) return next();
    const callId = request.callId ?? `dsh-approval-${++this.syntheticIds}`;
    const record = request.callId ? this.calls.get(request.callId) : undefined;
    // One card per call: the user already answered this call's card.
    if (record?.verdict === 'deny') return 'rejected';
    if (record?.verdict === 'allow' && record.prompted) return 'allowed-once';
    const cwd = request.agent?.session?.header?.cwd ?? route.gate.cwd ?? '.';
    const reason = request.displayReason?.en ?? request.reason;
    const ask: ToolPermissionRequest = {
      tool: request.toolName,
      toolCallId: callId,
      path: cwd,
      // An escalation cannot be judged from arguments this row never sees.
      unresolvedPaths: true,
      // One answer for one call: DSH has no "for this session".
      hostAsk: { sandbox: SANDBOX_ESCALATION.test(request.reason ?? '') },
      ...(reason ? { preview: { label: 'Reason', text: reason } } : {}),
      ...(route.delegate
        ? {
            delegation: {
              delegationId: route.delegate.sessionId,
              agentName: route.delegate.agentPreset ?? 'subagent',
            },
          }
        : {}),
    };
    try {
      await route.gate.gate.authorize(ask, request.signal);
      return 'allowed-once';
    } catch (error) {
      if (request.signal?.aborted || denialSource(error) === 'cancelled') return 'cancelled';
      if (denialSource(error)) return 'rejected';
      this.options.log?.('[aiclient-permissions] approval answer failed', error);
      return 'unavailable';
    }
  }

  private track(callId: string, record: CallRecord): void {
    this.calls.delete(callId);
    this.calls.set(callId, record);
    while (this.calls.size > this.maxTrackedCalls) {
      const oldest = this.calls.keys().next().value;
      if (oldest === undefined) break;
      this.calls.delete(oldest);
    }
  }
}
