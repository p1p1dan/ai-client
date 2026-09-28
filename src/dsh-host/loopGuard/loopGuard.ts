/**
 * The `aiclient-loop-guard` row's wiring, free of Cordis and of DSH imports
 * (dsh-rebase P1-8; decisions 065, 066). `plugin.ts` hands it the row's
 * context and the two dsh-llm functions it needs.
 *
 *   llm/stream                   rule B around every agent-loop request
 *                                (`repetition.ts`); title, compaction and
 *                                other one-shot requests pass untouched
 *   agent/request-error (prepend) a cut reply is never retried, whatever the
 *                                route's retry policy
 *   agent/pre-step (prepend)     rule C (`stepCeiling.ts`)
 *   tools/pre-execute (prepend)  rule C's refusal inside the wrap-up step
 *   session/event                rule C's step count and wrap-up stop
 *   agent/disposed               forget the agent's count
 *
 * `AICLIENT_RUNTIME_LOOP_GUARD=0` turns both rules off: nothing is registered
 * but the query service, which then refuses nothing.
 */

import {
  DEFAULT_STEP_CEILING,
  LOOP_GUARD_ENV,
  LOOP_GUARD_SERVICE,
  TOOL_CALL_REPETITION,
} from './constants.ts';
import type {
  DshAgentView,
  DshPreStepDecision,
  DshPreStepPayload,
  DshPreToolDecision,
  DshRequestErrorAction,
  DshRequestErrorPayload,
  DshSessionEvent,
  DshStreamChunk,
  DshToolCall,
} from './dshTypes.ts';
import { describeRepetition, guardReplyStream } from './repetition.ts';
import { type CreateUserMessage, StepCeiling } from './stepCeiling.ts';

type Listener = (...args: never[]) => unknown;

/** The slice of the row's Cordis context used here. */
export interface LoopGuardRowContext {
  on(name: string, listener: Listener, options?: { prepend?: boolean }): () => boolean;
  provide(name: string, value: unknown): () => void;
}

export interface LoopGuardDeps {
  /** dsh-llm `isAgentLoopRequest`: the request object was built by the agent loop. */
  isAgentLoopRequest(request: unknown): boolean;
  /** dsh-llm `createUserMessage`. */
  createUserMessage: CreateUserMessage;
  log?: (line: string) => void;
}

export interface LoopGuardSettings {
  enabled: boolean;
  stepCeiling: number;
}

/** What other rows see as `ctx.aiclientLoopGuard`. */
export interface DshLoopGuard {
  readonly enabled: boolean;
  readonly stepCeiling: number;
  /**
   * Why a tool call may not run, before any permission question: set only for
   * the calls of a wrap-up step. P1-6b's gate can ask this before `authorize()`
   * instead of relying on listener order.
   */
  refusalFor(exec: Pick<DshToolCall, 'agent'>): string | undefined;
}

/**
 * The row's settings: its `stepCeiling` config (default 500; anything but a
 * positive integer falls back to it, so a bad patch cannot switch the guard
 * off) and the kill switch, read once.
 */
export function resolveLoopGuardSettings(
  config: unknown,
  env: Record<string, string | undefined>,
  warn: (line: string) => void = () => {}
): LoopGuardSettings {
  const raw = (config as { stepCeiling?: unknown } | null | undefined)?.stepCeiling;
  let stepCeiling = DEFAULT_STEP_CEILING;
  if (raw !== undefined) {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) stepCeiling = raw;
    else warn(`ignoring stepCeiling ${JSON.stringify(raw)}; using ${DEFAULT_STEP_CEILING}`);
  }
  return { enabled: env[LOOP_GUARD_ENV] !== '0', stepCeiling };
}

export function installLoopGuard(
  ctx: LoopGuardRowContext,
  settings: LoopGuardSettings,
  deps: LoopGuardDeps
): DshLoopGuard {
  const log = deps.log ?? (() => {});
  if (!settings.enabled) {
    log(`disabled by ${LOOP_GUARD_ENV}=0: replies are not cut and steps are not capped`);
    const inert: DshLoopGuard = {
      enabled: false,
      stepCeiling: settings.stepCeiling,
      refusalFor: () => undefined,
    };
    ctx.provide(LOOP_GUARD_SERVICE, inert);
    return inert;
  }

  const ceiling = new StepCeiling({
    ceiling: settings.stepCeiling,
    createUserMessage: deps.createUserMessage,
    log,
  });

  ctx.on(
    'llm/stream',
    (
      options: { sessionId?: unknown },
      next: () => AsyncIterable<DshStreamChunk>
    ): AsyncIterable<DshStreamChunk> => {
      if (!deps.isAgentLoopRequest(options)) return next();
      return guardReplyStream(next(), {
        onTrip: (verdict) =>
          log(
            `cut a reply of ${String(options.sessionId)}: ${verdict.rule}, ${verdict.occurrences}x ${JSON.stringify(verdict.signature.slice(0, 200))}, ${verdict.delegationCalls} family calls, ${verdict.toolCalls} tool calls — ${describeRepetition(verdict)}`
          ),
      });
    }
  );

  ctx.on(
    'agent/request-error',
    (
      payload: DshRequestErrorPayload,
      next: () => Promise<DshRequestErrorAction>
    ): Promise<DshRequestErrorAction> =>
      payload.failure?.code === TOOL_CALL_REPETITION ? Promise.resolve(undefined) : next(),
    { prepend: true }
  );

  ctx.on(
    'agent/pre-step',
    (payload: DshPreStepPayload, next: () => Promise<DshPreStepDecision>) =>
      ceiling.preStep(payload, next),
    { prepend: true }
  );

  ctx.on(
    'tools/pre-execute',
    (exec: DshToolCall, next: () => Promise<DshPreToolDecision>) => ceiling.preExecute(exec, next),
    { prepend: true }
  );

  ctx.on('session/event', (session: { id: string } | undefined, event: DshSessionEvent) =>
    ceiling.onSessionEvent(session, event)
  );

  ctx.on('agent/disposed', (payload: { agent?: DshAgentView } | undefined) =>
    ceiling.onAgentDisposed(payload?.agent)
  );

  const api: DshLoopGuard = {
    enabled: true,
    stepCeiling: settings.stepCeiling,
    refusalFor: (exec) => ceiling.refusalFor(exec),
  };
  ctx.provide(LOOP_GUARD_SERVICE, api);
  return api;
}
