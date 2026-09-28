/**
 * Rule C (decision 066): at most `ceiling` DSH steps per agent between two
 * epoch-opening messages, then one tool-less wrap-up step and a stop. The
 * port of 1.0.x's 500-turn ceiling (runtime-hardening decision 040).
 *
 *   step/start (session/event)    count the step for its session's agent
 *   agent/pre-step (prepend)      a claimed user / retry / goal message opens
 *                                 a new count; at the ceiling, the step that
 *                                 would run next gets 1.0.x's wrap-up
 *                                 instruction appended to its messages
 *   tools/pre-execute (prepend)   every call of the wrap-up step is refused,
 *                                 before the permission gate can ask
 *   step/end (session/event)      the wrap-up step's end cancels the turn
 *                                 with `{kind:'hook', reason:
 *                                 'aiclient-turn-ceiling'}`, inbox kept; the
 *                                 bridge reports it as `turn_limit`
 *
 * The count survives job notices and subagent reports (decision 040's
 * "reports count against the same run"), so a background wake-up chain
 * cannot outrun it. Past the ceiling and until the next epoch, every step
 * such a notice starts is itself a wrap-up step. State lives in memory: a
 * host restart starts every count from zero.
 */

import {
  EPOCH_SOURCE_KINDS,
  LOOP_GUARD_SOURCE_KIND,
  TURN_CEILING_CANCEL_REASON,
  TURN_CEILING_REFUSAL_CODE,
  TURN_CEILING_TOOL_REFUSAL,
  turnCeilingPrompt,
} from './constants.ts';
import type {
  DshAgentView,
  DshMessageSource,
  DshPreStepDecision,
  DshPreStepPayload,
  DshPreToolDecision,
  DshSessionEvent,
  DshToolCall,
  DshUserMessage,
} from './dshTypes.ts';

/** dsh-llm `createUserMessage`, injected so this file imports no DSH package. */
export type CreateUserMessage = (input: {
  content: Array<{ type: 'text'; text: string }>;
  source: DshMessageSource;
}) => DshUserMessage;

export interface StepCeilingOptions {
  ceiling: number;
  createUserMessage: CreateUserMessage;
  log?: (line: string) => void;
}

interface AgentCount {
  agent: DshAgentView;
  /** Steps entered since the epoch opened. */
  steps: number;
  /** The wrap-up step still running, whose `step/end` ends the turn. */
  wrapUp?: { turn: number; step: number };
}

function sessionKey(agent: { id: string; session?: { id: string } }): string {
  return agent.session?.id ?? agent.id;
}

export function opensEpoch(message: DshUserMessage): boolean {
  return EPOCH_SOURCE_KINDS.includes(message.source?.kind);
}

export class StepCeiling {
  private readonly counts = new Map<string, AgentCount>();
  private readonly options: StepCeilingOptions;

  constructor(options: StepCeilingOptions) {
    this.options = options;
  }

  get ceiling(): number {
    return this.options.ceiling;
  }

  /** Steps counted for a session in its current epoch (tests and diagnostics). */
  stepsOf(sessionId: string): number | undefined {
    return this.counts.get(sessionId)?.steps;
  }

  async preStep(
    payload: DshPreStepPayload,
    next: () => Promise<DshPreStepDecision>
  ): Promise<DshPreStepDecision> {
    const count = this.countFor(payload.agent);
    if (payload.messages.some(opensEpoch)) {
      count.steps = 0;
      count.wrapUp = undefined;
    }
    const decision = await next();
    if (decision.kind !== 'enter' || count.steps < this.options.ceiling) return decision;
    // An empty first step never runs: the loop closes the turn without a request.
    if (payload.step === 1 && decision.messages.length === 0) return decision;
    count.wrapUp = { turn: payload.turn, step: payload.step };
    const withReports = payload.messages.some(
      (message) => !opensEpoch(message) && message.source?.kind !== LOOP_GUARD_SOURCE_KIND
    );
    const instruction = this.options.createUserMessage({
      content: [{ type: 'text', text: turnCeilingPrompt(this.options.ceiling, withReports) }],
      source: {
        kind: LOOP_GUARD_SOURCE_KIND,
        form: 'notice',
        summary: `Step ceiling ${this.options.ceiling} reached; wrap-up requested`,
      },
    });
    this.options.log?.(
      `step ceiling ${this.options.ceiling} reached for ${sessionKey(payload.agent)}; turn ${payload.turn} step ${payload.step} is the wrap-up`
    );
    return { ...decision, messages: [...decision.messages, instruction] };
  }

  /** Why `exec` may not run: set only for calls of a wrap-up step. */
  refusalFor(exec: Pick<DshToolCall, 'agent'>): string | undefined {
    if (!exec.agent) return undefined;
    return this.counts.get(sessionKey(exec.agent))?.wrapUp ? TURN_CEILING_TOOL_REFUSAL : undefined;
  }

  async preExecute(
    exec: DshToolCall,
    next: () => Promise<DshPreToolDecision>
  ): Promise<DshPreToolDecision> {
    const refusal = this.refusalFor(exec);
    if (refusal === undefined) return next();
    return {
      kind: 'deny',
      reason: refusal,
      info: { name: 'LoopGuard', code: TURN_CEILING_REFUSAL_CODE },
    };
  }

  onSessionEvent(session: { id: string } | undefined, event: DshSessionEvent): void {
    if (!session) return;
    const count = this.counts.get(session.id);
    if (!count) return;
    if (event.type === 'step/start') {
      count.steps += 1;
      return;
    }
    if (event.type === 'turn/end') {
      count.wrapUp = undefined;
      return;
    }
    if (event.type !== 'step/end' || !count.wrapUp) return;
    if (event.data?.turn !== count.wrapUp.turn || event.data?.step !== count.wrapUp.step) return;
    count.wrapUp = undefined;
    // Synchronous on purpose: the loop checks its signal right after appending
    // `step/end`, before it claims anything for a next step.
    count.agent.cancel({ kind: 'hook', reason: TURN_CEILING_CANCEL_REASON }, { keepInbox: true });
  }

  onAgentDisposed(agent: DshAgentView | undefined): void {
    if (agent) this.counts.delete(sessionKey(agent));
  }

  private countFor(agent: DshAgentView): AgentCount {
    const key = sessionKey(agent);
    let count = this.counts.get(key);
    if (!count) {
      count = { agent, steps: 0 };
      this.counts.set(key, count);
    }
    count.agent = agent;
    return count;
  }
}
