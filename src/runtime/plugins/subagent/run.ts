/**
 * P5-2-2 — one delegate execution.
 *
 * Provenance: `SubagentRun` from PI-Desktop `packages/agent-runtime/src/subagent.ts`
 * at `948ee676`. A delegate is a second pi `Agent` in this same process, with
 * its own system prompt, its own (possibly pinned) model, and only the tools
 * its definition declares. It shares the session's IO, exec and permission
 * exits, so every call it makes takes the exact path a parent call takes.
 *
 * Two boundaries define it, and both are load-bearing:
 *
 * - **Events do not escape.** `turn_end`, `agent_end` and error events stay
 *   inside this class. The parent's projector ends a run on those, and a
 *   delegate finishing must never end the parent's run. Only message and tool
 *   events are forwarded, for the transcript.
 * - **The report is the only thing the parent's model context gains.** Child
 *   messages and tool rows are emitted for display and persistence; they are
 *   not fed to the parent model.
 *
 * Adaptations from the reference, all forced rather than chosen:
 *
 * 1. **`maxTurns` is evaluated per tool call.** The P5-2-0 probe measured that
 *    0.84.4 only honours `terminate` when EVERY finalized result in the batch
 *    sets it, so a cap evaluated once per batch would not stop a two-call
 *    batch at all.
 * 2. **The watchdog fields are gone, not disabled.** The reference kept dead
 *    `startWatchdogs()` / `armIdleTimer()` members after withdrawing them (its
 *    D328). Carrying dead timer code that reads `idleTimeoutSeconds` into a new
 *    file would be an invitation to "fix" it back on. The definition fields are
 *    still parsed; nothing here arms a timer.
 * 3. **The context budget is a GUARD, not compaction.** context-prompt-17: a
 *    delegate had no window management at all, so an explore-shaped delegation
 *    reading its way through a directory simply ran into the provider's context
 *    limit and came back as one line of failure. It now shares the parent's
 *    thresholds (`plugins/context/budget.ts`) and the parent's two-tier
 *    reminder wording, and stops itself at the hard limit instead of issuing
 *    the request that cannot be served. It does NOT compact: a checkpoint is a
 *    session-level object (it is persisted, it owns a summary identity, the
 *    next run replays it) and a delegate has no session of its own, so giving
 *    it `ContextPlugin` would write the parent's checkpoint chain from a
 *    conversation the parent never sees. The remaining gap is recorded on the
 *    plan board rather than papered over here.
 * 4. **Retry reuses the parent's budget layer** (`agent-loop/providerRetry.ts`),
 *    which is itself the port of the reference's `provider-retry.ts`. Our ladder
 *    is 3s/10s/30s with three retries per budget, per the 2026-09-11 user
 *    ruling — deliberately not the reference's 5/4, because that ruling
 *    postdates the contract text and applies to every provider call we make.
 *    Both phases draw on ONE budget per delegate: `createProviderRetryStream`
 *    covers a request that never started, `agent-loop/streamRecovery.ts` covers
 *    a stream that died after it did, and neither can spend the other's
 *    allowance. A recovery re-asks the failed request and never replays a tool
 *    that already ran. The recovery used to be a private method here and is now
 *    shared with the parent loop (T093 / decision 029 clause 4).
 */

import {
  type AfterToolCallContext,
  type AfterToolCallResult,
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  convertToLlm,
  createCustomMessage,
  estimateContextTokens,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, CacheRetention, Usage } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import type { SubagentDefinition } from '../../../shared/subagentDefinition.ts';
import type { ResolvedModel } from '../../contracts.ts';
import {
  createProviderRetryBudget,
  createProviderRetryStream,
  type ProviderRetryBudget,
  type ProviderRetryController,
} from '../agent-loop/providerRetry.ts';
import {
  claimStreamRetry,
  type PendingStreamRetry,
  recoverPendingStream,
} from '../agent-loop/streamRecovery.ts';
import {
  CONTEXT_BUDGET_CHANNEL,
  compactionNeeded,
  contextBudget,
  NO_REMINDERS_CLAIMED,
  type ReminderState,
  selectReminder,
} from '../context/budget.ts';

/**
 * The report is the only thing that enters the parent's context; keep it from
 * becoming the context problem delegation was supposed to avoid.
 */
export const MAX_SUBAGENT_REPORT_CHARS = 12_000;

/**
 * What a delegate asks for when nothing configured it.
 *
 * `short` is also pi-ai's own default, so this constant does not CHANGE
 * behaviour — it pins it, so that raising the parent loop to `long` cannot drag
 * delegates along with it by accident.
 */
export const DEFAULT_SUBAGENT_CACHE_RETENTION: CacheRetention = 'short';

/**
 * Lifecycle states a delegate can settle in.
 *
 * `stopped` and `truncated` are kept distinct from `failed` on purpose: "the
 * user stopped it", "it ran out of turns" and "it broke" are three different
 * things to a person reading a transcript, and collapsing them into `failed`
 * is the specific regression the P5-2 contract names.
 */
export type SubagentRunStatus =
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'stopped'
  | 'truncated'
  | 'timed_out';

/** What ran out: the delegate's turn allowance, or its context window. */
type TruncationReason = 'turns' | 'context';

export interface SubagentRunResult {
  agentName: string;
  status: SubagentRunStatus;
  /** Text handed back to the parent model. */
  report: string;
  /** Provider requests the delegate spent. */
  turns: number;
  toolCalls: number;
  usage?: Usage;
  error?: { code: string; message: string };
}

/** One transcript-bound event from a delegate, already attributed. */
export interface SubagentEventEnvelope {
  delegationId: string;
  agentName: string;
  parentToolCallId: string;
  event: AgentEvent;
}

export interface SubagentRunOptions {
  definition: SubagentDefinition;
  delegationId: string;
  /** The `Task` call that owns this delegate. */
  parentToolCallId: string;
  /** The delegated instruction, written by the parent model. */
  task: string;
  /** Fully composed child system prompt. */
  systemPrompt: string;
  /** Model this delegate runs on, already resolved against the catalog. */
  model: ResolvedModel;
  thinkingLevel: ThinkingLevel;
  /**
   * Prompt cache lifetime for THIS delegate's requests.
   *
   * Required rather than optional so a new call site has to state which side of
   * the parent/delegate split it is on: the whole point of the field is that a
   * delegate must not silently inherit the parent's hour.
   */
  cacheRetention: CacheRetention;
  /**
   * The per-request wall clock, in milliseconds — the parent loop's number.
   *
   * A delegate is a provider request like any other, and before T093 it sent no
   * timeout at all, so a delegate was capable of holding the whole parent run
   * open for the SDK's 600-second default while the parent waited for its
   * report. "Off" arrives here as max int32, never as 0.
   */
  providerTimeoutMs: number;
  /** Host-backed tools, so a delegate's calls take the parent's exact path. */
  tools: readonly AgentTool<TSchema, unknown>[];
  onEvent?: (envelope: SubagentEventEnvelope) => void;
  /**
   * decision 029 clause 8 — this delegate is waiting out a provider backoff.
   *
   * The delegate budget used to be built with `createProviderRetryBudget()` and
   * no callbacks whatsoever, so a fan-out sitting in a gateway outage was
   * indistinguishable from a fan-out that had silently stopped: the parent's
   * banner never moved, the trace recorded nothing, and the only evidence was
   * the delegate eventually reporting a failure 43 seconds later. The plugin
   * turns these into the same `session.status` rider the parent's own retries
   * use, tagged with the delegation id.
   */
  onRetry?: ProviderRetryController['onRetry'];
  onRetrySettled?: ProviderRetryController['onRetrySettled'];
  /**
   * The session's own `afterToolCall` bookkeeping, so a host failure inside a
   * delegate reaches its tool-error channel the way it reaches the parent's.
   */
  resolveToolOutcome?: (
    context: AfterToolCallContext
  ) => { isError?: boolean; terminate?: boolean } | undefined;
  /**
   * Lifetime signal. This is the delegation's own controller — never the
   * signal of the `Task` tool call that started it, which is finished the
   * moment `Task` returns.
   */
  signal?: AbortSignal;
  /**
   * Why this delegate was cancelled, asked once its loop has actually closed.
   *
   * An `AbortSignal` carries no reason anyone here can read, so without this
   * every cancellation settles as `aborted` — and the registry then has to
   * rewrite the STATUS while the report text still says "was aborted", which is
   * how a stopped delegate ended up described two contradictory ways at once.
   * Returning undefined means "cancelled by something that did not say why".
   */
  cancelReason?: () => SubagentRunStatus | undefined;
}

function boundedReport(value: string): string {
  const text = value.trim();
  if (text.length <= MAX_SUBAGENT_REPORT_CHARS) return text;
  const marker = '\n\n[subagent report truncated]\n\n';
  const available = MAX_SUBAGENT_REPORT_CHARS - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function isAssistant(message: { role?: string }): message is AssistantMessage {
  return message.role === 'assistant';
}

/** Add up per-message usage the way the parent loop does, so one delegate's
 * spend is one number the session can settle exactly once. */
export function addUsage(
  left: Usage | undefined,
  right: Usage | null | undefined
): Usage | undefined {
  if (!right) return left;
  if (!left) return { ...right, cost: { ...right.cost } };
  const total: Usage = { ...left, cost: { ...left.cost } };
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
    total[key] += right[key];
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
    total.cost[key] += right.cost[key];
  if (right.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + right.reasoning;
  if (right.cacheWrite1h !== undefined)
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + right.cacheWrite1h;
  return total;
}

/** One delegate execution. Instances are single-use. */
export class SubagentRun {
  private readonly agent: Agent;
  private readonly options: SubagentRunOptions;
  private lastReportText = '';
  private turns = 0;
  private toolCalls = 0;
  private usage?: Usage;
  /** Set once something stopped the delegate early; decides what the report says. */
  private truncationReason?: TruncationReason;
  /** This delegate's own claims. Never the parent's: they are different windows. */
  private reminders: ReminderState = NO_REMINDERS_CLAIMED;
  private streamError?: { code: string; message: string };
  /** A stream failure that claimed a retry and is waiting to be re-asked. */
  private pendingRetry?: PendingStreamRetry;
  private readonly retryBudget: ProviderRetryBudget;

  constructor(options: SubagentRunOptions) {
    this.options = options;
    const { model } = options;
    // One budget per delegate, shared by BOTH phases: a request that never
    // started and a stream that died halfway draw from the same allowance, so a
    // delegate cannot spend twice the parent's budget by failing in two
    // different places. A 429 burst inside one delegate may not spend another
    // delegate's allowance, nor the parent's.
    const retryBudget = createProviderRetryBudget({
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
      ...(options.onRetrySettled ? { onRetrySettled: options.onRetrySettled } : {}),
    });
    this.retryBudget = retryBudget;
    this.agent = new Agent({
      streamFn: (requestModel, context, streamOptions) =>
        createProviderRetryStream(
          requestModel,
          context,
          // Same placement as the parent loop: on the options the retry factory
          // clones, so attempt 2 asks for the same TTL attempt 1 did.
          retryBudget.requestOptions({
            ...streamOptions,
            cacheRetention: options.cacheRetention,
            timeoutMs: options.providerTimeoutMs,
          }),
          (retryOptions) => model.models.streamSimple(requestModel, context, retryOptions),
          retryBudget.controller
        ),
      // Per request rather than captured, matching the parent loop: a key
      // rewritten on disk mid-run is picked up. Empty means "no key".
      getApiKey: async () => model.requestKey || undefined,
      convertToLlm,
      afterToolCall: async (context) => this.afterToolCall(context),
      initialState: {
        systemPrompt: options.systemPrompt,
        model: model.model,
        thinkingLevel: options.thinkingLevel,
        tools: [...options.tools],
        messages: [],
      },
      // A delegate is a worker, not a fan-out point: its own tool calls run one
      // at a time, and it has no Task tool to nest further.
      toolExecution: 'sequential',
      // The same place the parent loop reads the window: after the completed
      // turn's tool results are in, before the next request is built.
      prepareNextTurnWithContext: async (turn) => {
        const reminder = this.budgetReminder(turn.context.messages);
        if (!reminder) return undefined;
        return { context: { ...turn.context, messages: [...turn.context.messages, reminder] } };
      },
    });
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  async run(): Promise<SubagentRunResult> {
    const { signal } = this.options;
    if (signal?.aborted) return this.result(this.cancelStatus(), this.lastReportText);
    const onAbort = () => this.agent.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let thrown: Error | undefined;
    try {
      await this.agent.prompt(this.options.task);
      await this.agent.waitForIdle();
      // Stream-phase recovery. `createProviderRetryStream` only covers a
      // request that never produced a `start` event; a stream that died after
      // one arrives as an assistant message with `stopReason: "error"`, and
      // recovering from THAT needs the loop's message state, which only this
      // class has.
      while (this.pendingRetry && !signal?.aborted) await this.retryPendingStream();
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    // Checked after `waitForIdle`, not at abort time: the P5-2-0 probe measured
    // that aborting an in-flight tool costs one more provider request before
    // the loop closes, so "aborted" is only true once the loop is actually done.
    // Whatever partial text the delegate did produce goes back with it: the
    // parent has to decide whether to redo this work, and half an answer is
    // more use than a status word.
    if (signal?.aborted) return this.result(this.cancelStatus(), this.lastReportText);
    if (thrown)
      return this.result('failed', '', { code: 'delegate_threw', message: thrown.message });
    if (this.streamError) return this.result('failed', '', this.streamError);
    if (this.truncationReason) return this.result('truncated', this.lastReportText);
    if (!this.lastReportText.trim()) {
      // A delegate that produced no text did not do the job, whatever its stop
      // reason says: the report IS the deliverable.
      return this.result('failed', '', {
        code: 'subagent_no_report',
        message: 'the subagent finished without writing a report',
      });
    }
    return this.result('completed', this.lastReportText);
  }

  /**
   * Re-ask the failed request without re-running anything that already ran.
   *
   * The body of this used to live here; T093 moved it to
   * `agent-loop/streamRecovery.ts` so the main conversation gets the same
   * capability (decision 029 clause 4). What stays here is the delegate's own
   * bookkeeping: a recovery that cannot be attempted settles this delegate as
   * failed, which the parent loop expresses differently.
   */
  private async retryPendingStream(): Promise<void> {
    const pending = this.pendingRetry;
    if (!pending) return;
    this.pendingRetry = undefined;
    const outcome = await recoverPendingStream({
      agent: this.agent,
      pending,
      controller: this.retryBudget.controller,
      ...(this.options.signal ? { signal: this.options.signal } : {}),
    });
    if (outcome.failure) this.streamError = outcome.failure;
  }

  /**
   * Parent bookkeeping first, then this delegate's own turn cap.
   *
   * Evaluated on every call rather than once per batch — see adaptation 1 in
   * the module note.
   */
  private async afterToolCall(
    context: AfterToolCallContext
  ): Promise<AfterToolCallResult | undefined> {
    const parent = this.options.resolveToolOutcome?.(context);
    const { maxTurns } = this.options.definition;
    const capped = maxTurns !== undefined && this.turns >= maxTurns;
    if (capped) this.truncationReason ??= 'turns';
    // The hard limit is checked HERE rather than at the turn boundary because
    // this is the only hook that can stop the loop: `prepareNextTurnWithContext`
    // can rewrite the next request but cannot decline to make it, and the
    // request it would make at this point is the one the provider refuses. The
    // result about to be appended is counted in, since it is the growth that
    // usually crosses the line.
    if (!this.truncationReason && this.overHardLimit(context)) this.truncationReason = 'context';
    const terminate = parent?.terminate === true || this.truncationReason !== undefined;
    if (!parent?.isError && !terminate) return undefined;
    return {
      ...(parent?.isError ? { isError: true } : {}),
      ...(terminate ? { terminate: true } : {}),
    };
  }

  /** Would the next request be built on a context already past the safe limit? */
  private overHardLimit(context: AfterToolCallContext): boolean {
    const pending = estimateContextTokens([
      ...context.context.messages,
      { role: 'toolResult', content: context.result.content, timestamp: Date.now() },
    ] as AgentMessage[]).tokens;
    return compactionNeeded(contextBudget(this.options.model.model, pending));
  }

  /**
   * The parent's two-tier warning, claimed per delegate.
   *
   * Carried as a trailing message and never written into `state.messages`, for
   * the reason the parent loop has: the reminder is about THIS request, and a
   * copy that outlived it would ride every later one.
   */
  private budgetReminder(messages: readonly AgentMessage[]): AgentMessage | undefined {
    const budget = contextBudget(
      this.options.model.model,
      estimateContextTokens([...messages]).tokens
    );
    const decision = selectReminder(budget, this.reminders);
    if (!decision) return undefined;
    this.reminders = decision.state;
    return createCustomMessage(CONTEXT_BUDGET_CHANNEL, decision.text, false, undefined, Date.now());
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.({
      delegationId: this.options.delegationId,
      agentName: this.options.definition.name,
      parentToolCallId: this.options.parentToolCallId,
      event,
    });
  }

  /**
   * Fold delegate events into counters and the report, and forward the ones the
   * transcript needs.
   *
   * `turn_end`, `agent_end` and `agent_start` are NOT forwarded: the parent's
   * projector treats those as run boundaries. `turn_start` IS forwarded, for
   * counting only — see the case below.
   */
  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.turns += 1;
        // subagent-data-16 — forwarded, and only so the registry can count it.
        // `noteActivity` has always had a `turn_start` arm, but nothing ever
        // reached it: `record.turns` stayed 0 for the whole run, so every
        // `TaskList` / `TaskWait` heartbeat dropped the turn column (its
        // `if (turns > 0)` guard) and a parent asking "is this delegate stuck?"
        // was answered without the one number that says. `activityForEvent`
        // returns nothing for this type, so no extra event reaches the panel.
        this.emit(event);
        return;
      case 'message_start':
      case 'message_update':
        this.emit(event);
        return;
      case 'message_end': {
        const { message } = event;
        if (isAssistant(message)) {
          const text = assistantText(message);
          const failed = message.stopReason === 'error';
          if (failed) {
            const verdict = claimStreamRetry(message, this.retryBudget.controller);
            // Budget spent, or an error re-sending cannot fix: the delegate
            // fails now rather than looping on it.
            if (verdict.failure) this.streamError = verdict.failure;
            this.pendingRetry = verdict.pending;
          }
          this.usage = addUsage(this.usage, message.usage);
          // The report is the last assistant TEXT. A turn that only called
          // tools has none and must not clear what an earlier turn produced.
          if (!failed && text.trim()) this.lastReportText = text;
        }
        this.emit(event);
        return;
      }
      case 'tool_execution_start':
        this.toolCalls += 1;
        this.emit(event);
        return;
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.emit(event);
        return;
      default:
        return;
    }
  }

  /** The terminal status a cancellation should settle in; see `cancelReason`. */
  private cancelStatus(): SubagentRunStatus {
    return this.options.cancelReason?.() ?? 'aborted';
  }

  private result(
    status: SubagentRunStatus,
    report: string,
    error?: { code: string; message: string }
  ): SubagentRunResult {
    const name = this.options.definition.name;
    const body = report.trim();
    const text = describeOutcome(
      name,
      status,
      body,
      this.turns,
      this.options.definition.maxTurns,
      error,
      this.truncationReason
    );
    return {
      agentName: name,
      status,
      report: boundedReport(text),
      turns: this.turns,
      toolCalls: this.toolCalls,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(error ? { error } : {}),
    };
  }
}

/**
 * What the parent model is told about a delegate that did not simply finish.
 *
 * A non-completed delegate still returns TEXT, not an empty string: the parent
 * has to be able to decide whether to retry, work around it, or give up, and it
 * can only do that if it is told what happened and what partial work exists.
 */
function describeOutcome(
  name: string,
  status: SubagentRunStatus,
  body: string,
  turns: number,
  maxTurns: number | undefined,
  error?: { code: string; message: string },
  truncation?: TruncationReason
): string {
  if (status === 'completed') return body;
  const withBody = (lead: string, label: string): string =>
    [lead, ...(body ? [label, body] : [])].join('\n\n');
  switch (status) {
    case 'truncated':
      return withBody(
        truncation === 'context'
          ? `The ${name} subagent ran out of context window after ${turns} turn(s) and was stopped before finishing. Delegating a narrower task is more likely to succeed than repeating this one.`
          : `The ${name} subagent hit its ${maxTurns ?? 'configured'}-turn limit before finishing.`,
        'Its last report was:'
      );
    case 'aborted':
      return withBody(
        `The ${name} subagent was aborted after ${turns} turn(s).`,
        'Its last output was:'
      );
    case 'stopped':
      return withBody(
        `The ${name} subagent was stopped after ${turns} turn(s).`,
        'Its last output was:'
      );
    case 'timed_out':
      return withBody(
        `The ${name} subagent timed out after ${turns} turn(s).`,
        'Its last output was:'
      );
    default:
      return withBody(
        `The ${name} subagent failed after ${turns} turn(s): ${error?.message ?? 'unknown error'}.`,
        'Its last output was:'
      );
  }
}
