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
 * 3. **Retry reuses the parent's budget layer** (`agent-loop/providerRetry.ts`),
 *    which is itself the port of the reference's `provider-retry.ts`. Our ladder
 *    is 3s/10s/30s with three retries per budget, per the 2026-09-11 user
 *    ruling — deliberately not the reference's 5/4, because that ruling
 *    postdates the contract text and applies to every provider call we make.
 *    Stream-phase recovery (rewind + `continue()`) is P5-2-3's line item, and
 *    is the one place this class is knowingly not yet at parity.
 */

import {
  type AfterToolCallContext,
  type AfterToolCallResult,
  Agent,
  type AgentEvent,
  type AgentTool,
  convertToLlm,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import type { ResolvedModel } from '../../contracts.ts';
import {
  createProviderRetryBudget,
  createProviderRetryStream,
} from '../agent-loop/providerRetry.ts';
import type { SubagentDefinition } from './definition.ts';

/**
 * The report is the only thing that enters the parent's context; keep it from
 * becoming the context problem delegation was supposed to avoid.
 */
export const MAX_SUBAGENT_REPORT_CHARS = 12_000;

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
  /** Host-backed tools, so a delegate's calls take the parent's exact path. */
  tools: readonly AgentTool<TSchema, unknown>[];
  onEvent?: (envelope: SubagentEventEnvelope) => void;
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
  private cappedTurns = false;
  private streamError?: { code: string; message: string };

  constructor(options: SubagentRunOptions) {
    this.options = options;
    const { model } = options;
    // One budget per delegate: a 429 burst inside one delegate may not spend
    // another delegate's allowance, nor the parent's.
    const retryBudget = createProviderRetryBudget();
    this.agent = new Agent({
      streamFn: (requestModel, context, streamOptions) =>
        createProviderRetryStream(
          requestModel,
          context,
          retryBudget.requestOptions(streamOptions),
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
    });
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  async run(): Promise<SubagentRunResult> {
    const { signal } = this.options;
    if (signal?.aborted)
      return this.result('aborted', 'The delegated task was aborted before it started.');
    const onAbort = () => this.agent.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let thrown: Error | undefined;
    try {
      await this.agent.prompt(this.options.task);
      await this.agent.waitForIdle();
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    // Checked after `waitForIdle`, not at abort time: the P5-2-0 probe measured
    // that aborting an in-flight tool costs one more provider request before
    // the loop closes, so "aborted" is only true once the loop is actually done.
    if (signal?.aborted) return this.result('aborted', 'The delegated task was aborted.');
    if (thrown)
      return this.result('failed', '', { code: 'delegate_threw', message: thrown.message });
    if (this.streamError) return this.result('failed', '', this.streamError);
    if (this.cappedTurns) return this.result('truncated', this.lastReportText);
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
    if (capped) this.cappedTurns = true;
    const terminate = parent?.terminate === true || capped;
    if (!parent?.isError && !terminate) return undefined;
    return {
      ...(parent?.isError ? { isError: true } : {}),
      ...(terminate ? { terminate: true } : {}),
    };
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
   * projector treats those as run boundaries.
   */
  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.turns += 1;
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
            this.streamError = {
              code: 'provider_stream_failed',
              message: message.errorMessage ?? 'the provider stream failed',
            };
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
      error
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
  error?: { code: string; message: string }
): string {
  if (status === 'completed') return body;
  const withBody = (lead: string, label: string): string =>
    [lead, ...(body ? [label, body] : [])].join('\n\n');
  switch (status) {
    case 'truncated':
      return withBody(
        `The ${name} subagent hit its ${maxTurns ?? 'configured'}-turn limit before finishing.`,
        'Its last report was:'
      );
    case 'aborted':
      return `The ${name} subagent was aborted after ${turns} turn(s).`;
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
