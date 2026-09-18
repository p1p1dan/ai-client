/** P0/P1 turn driver: optional native tools, bounded turns, permission audit and raw usage. */

import { randomUUID } from 'node:crypto';
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  convertToLlm,
  estimateContextTokens,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, CacheRetention, Usage } from '@earendil-works/pi-ai';
import type { Context } from 'cordis';
import { Service } from 'cordis';
import { markInternalMessage } from '../../../shared/internalMessage.ts';
import {
  type AgentLoopService,
  EVENTS_SERVICE,
  LOOP_SERVICE,
  MODEL_SERVICE,
  PROMPT_SERVICE,
  RuntimeConfigError,
  type RuntimeRunRequest,
  type RuntimeRunResult,
  SESSION_SERVICE,
  TRACE_SERVICE,
} from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';
import { compactionNeeded, contextBudget } from '../context/budget.ts';
import { CONTEXT_SERVICE, type TurnPreparation } from '../context/index.ts';
import { permissionActivityEvent } from '../permissions/activity.ts';
import type { PermissionActivityRecord } from '../permissions/index.ts';
import { onDemandInstructionsText } from '../prompt/projectInstructions.ts';
import type { ComposedPrompt } from '../prompt/segments.ts';
import { PERMISSIONS_ENTRY } from '../session/legacy.ts';
import { interruptedToolResults } from '../session/recovery.ts';
import { preparePrompt } from './attachments.ts';
import { sanitizeProviderErrorText } from './providerErrors.ts';
import {
  createProviderRetryBudget,
  createProviderRetryStream,
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_TRANSIENT_MAX_RETRIES,
} from './providerRetry.ts';

/**
 * Cap on a permission-activity preview once it reaches the trace.
 *
 * `ToolPermissionRequest.preview` is meant to show a person the content
 * verbatim on the approval card, so `write` sends the whole file (up to 8
 * MiB) and never truncates it there (permissions-12). The trace has no such
 * reason to keep the whole thing — it exists to reconstruct what happened,
 * not to reproduce the file — so this listener caps its own copy before
 * `trace.note`. Matches the MCP bridge's existing preview cap
 * (`plugins/mcp/index.ts`), so an MCP preview that already fits is never
 * truncated a second time more aggressively than it already was.
 */
const MAX_TRACE_PREVIEW_CHARS = 4000;

/**
 * capacity-02 — the same cap, applied to the tool arguments a trace records.
 *
 * `tool_execution_start` used to store `event.args` whole, which for `write`
 * is the entire file the model just produced (schema ceiling 8 MiB). That made
 * the tool step the one place on the trace path with no bound at all, three
 * orders of magnitude past the approval preview sitting next to it: the step
 * array grows for the length of the run before `finish()` can apply the
 * trace's own memory and file budgets, so the bytes are held either way.
 *
 * Strings are truncated where they are found rather than the whole object
 * being replaced, so the SHAPE of the call — which tool, which path, which
 * flags — survives intact, and only the one oversized leaf is cut. Depth is
 * bounded because tool arguments are JSON from a model and nothing guarantees
 * they are shallow.
 */
const MAX_TRACE_ARGS_DEPTH = 6;

export function traceSafeToolArgs(args: unknown, depth = 0): unknown {
  if (typeof args === 'string')
    return args.length <= MAX_TRACE_PREVIEW_CHARS
      ? args
      : `${args.slice(0, MAX_TRACE_PREVIEW_CHARS)}…`;
  if (args === null || typeof args !== 'object') return args;
  if (depth >= MAX_TRACE_ARGS_DEPTH) return `[depth ${MAX_TRACE_ARGS_DEPTH} elided]`;
  if (Array.isArray(args)) return args.map((item) => traceSafeToolArgs(item, depth + 1));
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>))
    safe[key] = traceSafeToolArgs(value, depth + 1);
  return safe;
}

function traceSafeActivity(record: PermissionActivityRecord): PermissionActivityRecord {
  const preview = record.request.preview;
  if (!preview || preview.text.length <= MAX_TRACE_PREVIEW_CHARS) return record;
  return {
    ...record,
    request: {
      ...record.request,
      preview: { ...preview, text: `${preview.text.slice(0, MAX_TRACE_PREVIEW_CHARS)}…` },
    },
  };
}

export interface AgentLoopConfig {
  /**
   * Stop after the first assistant turn (engineering standard §6).
   *
   * True for the whole of P0. With no tools registered the loop would usually
   * stop on its own, but "usually" is not an assertable property: a model that
   * emits a tool call for a tool that does not exist, or a provider that
   * returns `stopReason: "toolUse"` spuriously, would otherwise start a second
   * request that P0 has no way to make useful. Pinning it makes "exactly one
   * turn" a deterministic assertion the smoke case can check (§4).
   *
   * P1 sets this false: multi-turn is what a tool loop IS.
   */
  singleTurn: boolean;
  /**
   * Sent when a caller does not name one.
   *
   * `medium`, matching what the legacy backend ends up with: it never sends a
   * level unless the user picked one, so pi applies its own
   * `DEFAULT_THINKING_LEVEL`. This loop has to name a value, and naming `off`
   * made the same untouched chip mean "no reasoning" on native and "medium" on
   * legacy — a silent behaviour split between the two backends, which the
   * 2026-09-09 field pass ran into while checking EFFORT-1. `off` is still a
   * LEVEL a caller can ask for; it is just no longer what "unspecified" means.
   */
  defaultThinkingLevel: ThinkingLevel;
  /**
   * How long the provider keeps this loop's prompt cache prefix.
   *
   * `long` (Anthropic `cache_control.ttl: "1h"`) because a main conversation is
   * exactly the traffic shape the hour is for: one prefix that grows all session
   * and is re-read on every turn, with human-length gaps between turns that the
   * five-minute default does not survive. pi-ai's own default is `short`, and
   * before this the field was never set at all — so every gap longer than five
   * minutes re-wrote the whole conversation at the 1.25x write premium.
   *
   * Delegates get `short` instead; see `SubagentConfig.cacheRetention`.
   */
  cacheRetention: CacheRetention;
}

export const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  singleTurn: true,
  defaultThinkingLevel: 'medium',
  cacheRetention: 'long',
};

export class AgentLoopPlugin extends Service implements AgentLoopService {
  static inject = [MODEL_SERVICE, TRACE_SERVICE, PROMPT_SERVICE, EVENTS_SERVICE];

  private readonly config: AgentLoopConfig;

  constructor(ctx: Context, config: AgentLoopConfig = DEFAULT_AGENT_LOOP_CONFIG) {
    super(ctx, LOOP_SERVICE);
    this.config = config;
  }

  async run(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
    const runId = request.runId ?? randomUUID();
    try {
      return await this.execute({ ...request, runId });
    } catch (error) {
      const sessionId =
        request.logicalSessionId ?? this.ctx.get(SESSION_SERVICE)?.metadata().id ?? runId;
      this.ctx.runtimeEvents.emit({
        type: 'session.failed',
        sessionId,
        requestId: runId,
        payload: { error: thrownRunErrorText(error) },
      });
      this.ctx.runtimeEvents.emit({
        type: 'session.status',
        sessionId,
        requestId: runId,
        payload: { status: 'idle' },
      });
      throw error;
    }
  }

  private async execute(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
    const session = this.ctx.get(SESSION_SERVICE);
    await session?.flush();
    const snapshot = session?.snapshot();
    const adapter = this.ctx.runtimeModel;
    const saved = snapshot?.model;
    const restoredRef =
      saved &&
      adapter
        .list()
        .find((model) => model.provider === saved.provider && model.id === saved.modelId);
    const ref = request.model ?? restoredRef ?? adapter.defaultRef();
    if (!ref) {
      // cross-06: the drop reasons have exactly one reader — the `run_start`
      // note twenty lines below — and this throw is before `trace.begin()`, so
      // the one run that NEEDS them is the one run that never writes them. They
      // go in the message instead: an empty catalog is almost always an empty
      // catalog BECAUSE of these, and "gateway:no_api_key" is the difference
      // between a fixable config and a mystery.
      const dropped = 'dropped' in adapter.source ? adapter.source.dropped : [];
      throw new RuntimeConfigError(
        'catalog_empty',
        `the model catalog is empty, so there is nothing to run against${
          dropped.length > 0 ? ` (dropped: ${dropped.join(', ')})` : ''
        }`
      );
    }
    const resolved = adapter.resolve(ref);
    const thinkingLevel =
      request.thinkingLevel ?? snapshot?.thinkingLevel ?? this.config.defaultThinkingLevel;
    let systemPrompt = request.systemPrompt;
    let composed: ComposedPrompt | undefined;
    if (systemPrompt === undefined) {
      composed = await this.ctx.runtimePrompt.compose();
      systemPrompt = composed.text;
    }
    // Before the trace and before `startRun`: the text the model is given is the
    // text that belongs in the trace, and the metadata has to reach the
    // projector in time to ride the user echo.
    const prepared = preparePrompt(request.prompt, request.attachments);
    const trace = this.ctx.runtimeTrace.begin({
      runId: request.runId,
      input: prepared.text,
      model: resolved.model.id,
      provider: resolved.ref.provider,
    });
    const sessionId = request.logicalSessionId ?? snapshot?.id ?? trace.runId;
    const projected = this.ctx.runtimeEvents.startRun(
      sessionId,
      trace.runId,
      snapshot?.entries.flatMap((entry) => (entry.type === 'message' ? [entry.message] : [])) ?? [],
      resolved.model.contextWindow,
      {
        ...(request.attemptId ? { attemptId: request.attemptId } : {}),
        ...(prepared.metadata.length ? { attachments: prepared.metadata } : {}),
      }
    );
    trace.note('note', {
      event: 'run_start',
      system_prompt: systemPrompt,
      system_prompt_bytes: Buffer.byteLength(systemPrompt, 'utf8'),
      prompt_source: composed ? 'assembled' : 'override',
      ...(composed
        ? { prompt_segments: composed.segments, static_prefix_bytes: composed.staticPrefixBytes }
        : {}),
      thinking_level: thinkingLevel,
      single_turn: this.config.singleTurn,
      catalog_source: adapter.source,
      mode: this.ctx.get('runtimePermissions')?.mode ?? null,
      permission_gear: this.ctx.get('runtimePermissions')?.gear ?? null,
      compaction_family: this.ctx.get(CONTEXT_SERVICE)?.enabled
        ? this.ctx.get(CONTEXT_SERVICE)?.family
        : null,
      compaction_tool: this.ctx.get(CONTEXT_SERVICE)?.compactionTool ?? null,
    });

    // session-02 — the file this run reads was rewritten at open, with rows no
    // reader could parse dropped (decision 006). Every run for the life of this
    // worker says so, not just the first: the trace is where "why is a turn
    // missing from my conversation?" gets answered, and whichever run gets
    // asked about has to be able to answer it.
    const recovered = session?.recovery;
    if (recovered) {
      trace.note('note', {
        event: 'session_recovered',
        skipped_lines: recovered.skipped.map((row) => row.line),
        skipped_previews: recovered.skipped.map((row) => row.preview),
      });
      // The trace file is not a user surface (rpc-projector-02's point about the
      // retry banner, and the same is true here): a dropped row is a turn the
      // user can no longer see, so the renderer is told too. Line numbers only —
      // the dropped text may be half a prompt.
      projected.recovery({ skippedLines: recovered.skipped.map((row) => row.line) });
    }

    // Looked up by name rather than imported, the way this file already
    // reaches `runtimePermissions`: the subagent plugin imports the retry layer
    // that lives next to this file, and an import back would make the two
    // modules a cycle for the bundler to guess at.
    const subagents = this.ctx.get('runtimeSubagents');

    // subagent-data-02 — the top of a top-level run is where the catalog is
    // re-read, which is what P5-2-1 promised and what `piSubagents.ts`'s module
    // note has always claimed ("an edit lands on the next turn by itself").
    // Before the tools snapshot below, because `Task`'s description carries the
    // menu. Delegates already running keep their own definition object.
    await subagents?.refresh();

    // P5-2-4 — delegations started from here belong to this session and this
    // run. Bound before any tool can fire, because the first thing `Task` does
    // is write a record that has to name both.
    // cross-01/cross-02: the ref actually resolved for this run, not the
    // catalog's default and not a stale config field, is what a delegate
    // without its own pin must inherit.
    subagents?.bindRun({
      sessionId,
      runId: trace.runId,
      model: resolved.ref,
      thinkingLevel,
    });

    // subagent-data-03 / decision 005 — what THIS session's earlier runs'
    // delegates spent, folded in before this run adds to it. Without it a
    // reopened conversation showed the parent's whole history and none of the
    // delegated part of it, which is a total that was never charged.
    const delegatedHistory = subagents?.historyUsage();
    if (delegatedHistory?.usage)
      projected.delegated(delegatedHistory.usage, delegatedHistory.delegations);
    /**
     * Take whatever delegates have settled since the last call, once.
     *
     * `takeUsage()` drains, so calling it per auto-resume pass and once more
     * after `drain()` bills each delegate exactly once while letting the
     * conversation total move while the run is still going — which is the point
     * of folding it here rather than only at the end.
     */
    let subagentUsage: Usage | null = null;
    const foldDelegatedUsage = () => {
      const taken = subagents?.takeUsage();
      if (!taken) return;
      subagentUsage = sumUsage([subagentUsage, taken]);
      projected.delegated(taken);
    };

    // Optional: P0 and the tool-less smoke lane run without it, and a run with
    // no compaction service behaves exactly as it did before P2-3.
    const context = this.ctx.get(CONTEXT_SERVICE);
    context?.beginRun(snapshot);
    /**
     * Every outcome of a `prepareTurn`, written the same way wherever it ran.
     *
     * context-prompt-11: the two call sites had drifted. The pre-run one
     * recorded compactions and nothing else, so a reminder it injected into
     * `agent.state.messages` — where it then rode every later request — left no
     * line explaining where that message came from, and a compaction it asked
     * for and did not get left none at all.
     */
    const noteTurnPreparation = (prepared: TurnPreparation) => {
      if (prepared.compaction) {
        trace.note('note', { event: 'compaction', ...prepared.compaction });
        const summary = prepared.messages[0];
        if (summary?.role === 'compactionSummary') projected.compaction(summary.summary);
      }
      if (prepared.skipped)
        trace.note('note', { event: 'compaction_skipped', ...prepared.skipped });
      if (prepared.reminder)
        trace.note('note', {
          event: 'context_reminder',
          tier: prepared.reminder.tier,
          names_compaction_tool: prepared.reminder.text.includes(
            context?.compactionTool ?? '\u0000'
          ),
        });
    };
    const collected = new TurnCollector();
    const toolCalls = new Set<string>();
    const delegations = this.ctx.get('runtimeSubagents')?.registry;
    const unsubscribePermissions = this.ctx.get('runtimePermissions')?.onActivity((record) => {
      // Gates raised outside this run's tool calls (a probe, a stale session)
      // belong to no message on screen and no line in this trace.
      //
      // A delegate's calls ARE this run's, and `toolCalls` alone cannot see
      // that: a delegate has its own `Agent`, so its tool call ids never reach
      // the subscription below. Filtering on ids alone dropped every gate a
      // subagent passed — including every `policy` auto-allow, whose activity
      // row is the only evidence anywhere that the call was checked at all. So
      // the second arm asks the question the ids cannot: is this delegation one
      // this run started?
      const delegation = record.request.delegation;
      const mine =
        toolCalls.has(record.request.toolCallId) ||
        (delegation !== undefined && delegations?.has(delegation.delegationId) === true);
      if (!mine) return;
      trace.note('note', { event: `permission_${record.phase}`, ...traceSafeActivity(record) });
      this.ctx.runtimeEvents.emit(permissionActivityEvent(sessionId, record));
    });
    let turnCount = 0;
    // One budget per run: a 429 burst and a later gateway fault each get their
    // own bounded allowance, and neither may borrow from the other.
    const retryBudget = createProviderRetryBudget({
      onRetry: ({ error, attempt, delayMs, status }) => {
        trace.note('note', {
          event: 'provider_retry',
          code: error.code,
          attempt,
          delay_ms: delayMs,
          ...(error.details ?? {}),
        });
        // rpc-projector-02: the trace file is not a user surface. The renderer
        // has drawn a retry banner off `session.status.retry` since T-33 and
        // the native backend never sent one, so a run spent its whole backoff
        // looking identical to a slow model.
        projected.retry({
          attempt,
          maxRetries:
            error.code === 'PROVIDER_RATE_LIMITED'
              ? PROVIDER_RATE_LIMIT_MAX_RETRIES
              : PROVIDER_TRANSIENT_MAX_RETRIES,
          delayMs,
          // The banner's own contract: a status means the upstream answered and
          // is named as such; `null` is its sentinel for a transport failure.
          errorStatus: status === undefined ? null : String(status),
          error: error.code,
        });
      },
      onRetrySettled: () => projected.recovered(),
    });
    /**
     * decision 007 — hand the model any instruction file that came into scope
     * since the last check.
     *
     * Queued as a steering message rather than written into the turn context
     * directly, because steering is the one injection path pi emits
     * `message_end` for: that is what puts the message in `agent.state.messages`
     * (so later turns and the delegation resume still see it) and in the
     * session file (so a reopen does). It carries the T005 mark, so the
     * projector draws no user bubble for it and compaction does not mistake it
     * for the user's latest task.
     */
    const flushDiscoveredInstructions = () => {
      const prompt = this.ctx.get(PROMPT_SERVICE);
      const entries = prompt?.takePendingInstructions?.() ?? [];
      const text = onDemandInstructionsText(entries);
      if (!text) return;
      trace.note('note', {
        event: 'project_instructions_loaded',
        sources: entries.map((entry) => entry.source),
        bytes: Buffer.byteLength(text, 'utf8'),
      });
      agent.steer(
        markInternalMessage(
          {
            role: 'user',
            content: [{ type: 'text', text }],
            timestamp: Date.now(),
          } satisfies AgentMessage,
          'project-instructions'
        )
      );
    };
    const agent = new Agent({
      streamFn: (model, context, options) =>
        createProviderRetryStream(
          model,
          context,
          // Applied here rather than inside the retry factory so a retried
          // request carries the same TTL as the one it replaces: a retry that
          // downgraded to the SDK default would write a second, shorter entry
          // for a prefix the first attempt already paid an hour for.
          retryBudget.requestOptions({ ...options, cacheRetention: this.config.cacheRetention }),
          (retryOptions) => resolved.models.streamSimple(model, context, retryOptions),
          retryBudget.controller
        ),
      // Per request rather than captured, so a key rewritten on disk between
      // turns of a long run is picked up. Empty string means "no key" and must
      // become undefined - pi-ai treats an empty key as a configured one.
      getApiKey: async () => resolved.requestKey || undefined,
      convertToLlm,
      initialState: {
        systemPrompt,
        model: resolved.model,
        thinkingLevel,
        tools: [...(this.ctx.get('runtimeTools')?.list() ?? [])],
        messages: snapshot?.messages ?? [],
      },
      shouldStopAfterTurn: () => ++turnCount >= (this.config.singleTurn ? 1 : 64),
      // The turn boundary is where compaction is safe: the batch of tool
      // results that belongs to the turn just finished is already in the
      // context, so a model that asked for a new window mid-batch does not
      // lose results it is still holding.
      //
      // decision 007 — it is also where an instruction file discovered by a
      // tool call gets queued, so the hook is installed even with no compaction
      // service. pi polls the steering queue right after calling this, so a
      // message enqueued here lands in the very next request, after the tool
      // results and before the assistant speaks again.
      prepareNextTurnWithContext: async (turn, signal) => {
        flushDiscoveredInstructions();
        if (!context) return undefined;
        const prepared = await context.prepareTurn({
          messages: turn.context.messages,
          model: resolved.model,
          models: resolved.models,
          thinkingLevel,
          retention:
            turn.toolResults.length > 0 || turn.message.stopReason === 'toolUse'
              ? 'active_turn'
              : 'completed_turn',
          ...(signal ? { signal } : {}),
        });
        noteTurnPreparation(prepared);
        if (prepared.compaction) {
          // context-prompt-01. Replacing only the loop's `currentContext`
          // leaves `agent.state.messages` holding the whole uncompacted
          // history, and every `prompt()` rebuilds its context from THAT.
          // The delegation resume below calls `prompt()` again inside this
          // same run, so the window this compaction just bought was handed
          // straight back: at best one full-size request with a missed
          // cache prefix, at worst the overflow compaction exists to
          // avoid. pi only re-prepares between turns of one `prompt()`
          // call, so nothing downstream would have corrected it.
          agent.state.messages = prepared.messages;
        }
        if (!prepared.compaction && !prepared.reminder) return undefined;
        return { context: { ...turn.context, messages: prepared.messages } };
      },
    });

    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === 'message_end' && session)
        await session.appendMessage(redactedForStorage(event.message));
      collected.observe(event);
      projected.observe(event);
      if (event.type === 'tool_execution_start') toolCalls.add(event.toolCallId);
      if (event.type === 'tool_execution_start')
        trace.note('tool', {
          event: event.type,
          tool_call_id: event.toolCallId,
          tool: event.toolName,
          args: traceSafeToolArgs(event.args),
        });
      if (event.type === 'tool_execution_end')
        trace.note('tool', {
          event: event.type,
          tool_call_id: event.toolCallId,
          tool: event.toolName,
          result: event.result,
          is_error: event.isError,
        });
      request.onEvent?.(event);
    });
    // User Stop and dispose reach the delegates through here. `TaskStop` is the
    // other door; the per-call signal of the `Task` tool is NOT a door at all,
    // because it is finished the moment `Task` returns.
    const onAbort = () => {
      agent.abort();
      this.ctx.get('runtimeSubagents')?.abortAll();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    let thrown: Error | undefined;
    try {
      request.signal?.throwIfAborted();
      // New input must fit on its own; only the completed history can be
      // compacted before the first request of this run.
      const incomingTokens =
        estimateContextTokens([{ role: 'user', content: prepared.text, timestamp: Date.now() }])
          .tokens +
        Math.ceil(systemPrompt.length / 4) +
        Math.ceil(JSON.stringify(agent.state.tools).length / 4);
      if (context?.enabled) {
        if (compactionNeeded(contextBudget(resolved.model, incomingTokens))) {
          throw new RuntimeHostError(
            'context_too_large',
            'the pending prompt exceeds the safe model context budget'
          );
        }
      }
      if (session && snapshot) {
        for (const recovered of interruptedToolResults(snapshot.messages)) {
          await session.appendMessage(recovered);
          agent.state.messages.push(recovered);
        }
        if (context?.enabled && agent.state.messages.length > 0) {
          const prepared = await context.prepareTurn({
            messages: agent.state.messages,
            model: resolved.model,
            models: resolved.models,
            thinkingLevel,
            retention: 'completed_turn',
            additionalTokens: incomingTokens,
            signal: request.signal,
          });
          noteTurnPreparation(prepared);
          agent.state.messages = prepared.messages;
        }
      }
      if (session) {
        if (
          !snapshot?.model ||
          snapshot.model.provider !== resolved.ref.provider ||
          snapshot.model.modelId !== resolved.model.id
        )
          await session.appendEntry({
            type: 'model_change',
            provider: resolved.ref.provider,
            modelId: resolved.model.id,
          });
        if (snapshot?.thinkingLevel !== thinkingLevel)
          await session.appendEntry({ type: 'thinking_level_change', thinkingLevel });
        const permissions = this.ctx.get('runtimePermissions');
        if (
          permissions &&
          (snapshot?.permissions?.mode !== permissions.mode ||
            snapshot.permissions.gear !== permissions.gear)
        )
          await session.appendEntry({
            type: 'custom',
            customType: PERMISSIONS_ENTRY,
            data: { mode: permissions.mode, gear: permissions.gear },
          });
      }
      // decision 007 — a directory discovered by the last tool call of the
      // PREVIOUS run has nothing to ride into the model on, because that run
      // ended before another turn boundary came round. Draining here puts it in
      // this run's first request, right after the user's own message.
      flushDiscoveredInstructions();
      await agent.prompt(prepared.text, prepared.images.length ? prepared.images : undefined);
      await agent.waitForIdle();
      // P5-2-2 — the parent going idle is not the end of the logical run while
      // its delegates are still working. This promise IS the run boundary the
      // worker reports on (`nativeWorkerRuntime.startSend` clears its turn when
      // it resolves), so resolving here would release the slot, emit `idle`,
      // and strand every delegate's report with nobody to read it.
      //
      // The runtime waits, not the model: a parent that simply stopped calling
      // tools still gets its delegates' reports and continues toward the user's
      // original goal, which is the behaviour the reference's D328 settled on.
      if (subagents) {
        while (!request.signal?.aborted) {
          const report = await subagents.collectFinished(request.signal);
          // Folded per pass, not only at the end: a fan-out that settles
          // halfway through a long run should move the conversation total then,
          // not once everything is over.
          foldDelegatedUsage();
          if (report === undefined) break;
          trace.note('note', { event: 'delegation_resume', report_bytes: report.length });
          // Marked, not plain text. pi wraps any prompt as `role: 'user'`, and
          // an unmarked one is indistinguishable from something the person
          // typed: the projector drew it as a user bubble carrying the real
          // send's attemptId and attachments, and the session file kept it as
          // the newest user message. The model still gets the report — that is
          // the point of feeding it back — it just no longer claims to be the
          // user's next instruction.
          await agent.prompt(
            markInternalMessage(
              {
                role: 'user',
                content: [{ type: 'text', text: report }],
                timestamp: Date.now(),
              } satisfies AgentMessage,
              'subagent-report'
            )
          );
          await agent.waitForIdle();
        }
      }
      await session?.flush();
    } catch (error) {
      // `Agent` encodes provider failures in the stream rather than throwing,
      // so reaching here means something structural (a bad model object, a
      // listener that threw). Recorded as the run's error instead of
      // propagating, because a caller that gets a rejection loses the trace.
      thrown = error instanceof Error ? error : new Error(String(error));
    } finally {
      // Whatever ended this run — a Stop, a structural failure, or a normal
      // finish — no delegate of it may outlive it. On the normal path the loop
      // above already emptied the registry and this returns at once; on a Stop
      // it is what makes "the run ended" mean "nothing is still spending".
      await subagents?.drain();
      request.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      unsubscribePermissions?.();
    }

    for (const turn of collected.turns) {
      trace.note('llm', {
        stop_reason: turn.stopReason,
        text_bytes: Buffer.byteLength(turn.text, 'utf8'),
        usage: turn.usage,
        ...(turn.errorMessage ? { error_message: turn.errorMessage } : {}),
      });
    }

    const aborted = request.signal?.aborted === true;
    const last = collected.turns.at(-1);
    const error =
      turnCount >= 64 && last?.stopReason === 'toolUse'
        ? { code: 'turn_limit', message: 'tool loop exceeded 64 assistant turns' }
        : resolveError({ thrown, aborted, last });
    // The last fold: `drain()` settles stragglers, and a run that failed or was
    // stopped never reached the loop above at all. `takeUsage()` drains, so
    // this cannot re-bill what the loop already took.
    foldDelegatedUsage();
    const result: Omit<RuntimeRunResult, 'trace'> = {
      runId: trace.runId,
      success: !error,
      text: collected.text,
      stopReason: aborted ? 'aborted' : (last?.stopReason ?? 'error'),
      usage: sumUsage(collected.turns.map((turn) => turn.usage)),
      ...(subagentUsage ? { subagentUsage } : {}),
      latencyMs: 0,
      turns: collected.turns.length,
      ...(error ? { error } : {}),
    };
    const finished = await trace.finish({
      final_output: result.text,
      usage: result.usage,
      success: result.success,
      ...(error ? { error } : {}),
    });
    projected.finish(result);
    return { ...result, latencyMs: finished.latency_ms, trace: finished };
  }
}

interface CollectedTurn {
  text: string;
  stopReason: string;
  usage: Usage | null;
  errorMessage?: string;
}

/**
 * Folds the agent event stream into per-turn records.
 *
 * Reads `message_end` rather than accumulating `message_update` deltas: the
 * final message is the authoritative one, and rebuilding text from partials
 * would make the recorded output depend on how the provider chunked it - the
 * class of drift `docs/agent-project-engineering.md` A1 exists to prevent.
 */
class TurnCollector {
  readonly turns: CollectedTurn[] = [];

  observe(event: AgentEvent): void {
    if (event.type !== 'message_end') return;
    const message = event.message;
    if (!isAssistant(message)) return;
    this.turns.push({
      text: assistantText(message),
      stopReason: message.stopReason,
      usage: message.usage ?? null,
      // core-host-03: pi-ai folds raw HTTP response bodies into this field
      // (up to 4000 chars, unredacted) before this collector ever sees it.
      // Sanitized once here so both consumers below — the `llm` trace note
      // and `resolveError`'s `RuntimeRunResult.error.message` — get the same
      // redacted, capped text instead of one going through classification
      // and the other bypassing it.
      ...(message.errorMessage
        ? { errorMessage: sanitizeProviderErrorText(message.errorMessage) }
        : {}),
    });
  }

  get text(): string {
    return this.turns.map((turn) => turn.text).join('');
  }
}

/**
 * ah-lib-01 — the copy of a provider error that outlives every other copy.
 *
 * T011 sanitized the record `TurnCollector` builds, which feeds the trace and
 * `RuntimeRunResult`. The session file is written one statement earlier and
 * straight from `event.message`, so `runs.jsonl` came out redacted while the
 * JSONL kept the plaintext — and the JSONL is the file that interoperates with
 * `pi --session`, gets read by import/export, and is the one a user attaches
 * when reporting a bug. Redacting a COPY (never `event.message` itself) keeps
 * the loop's own state and the caller's `onEvent` stream untouched: the model
 * conversation must not be rewritten under pi's feet.
 */
function redactedForStorage(message: AgentMessage): AgentMessage {
  if (!isAssistant(message) || !message.errorMessage) return message;
  return { ...message, errorMessage: sanitizeProviderErrorText(message.errorMessage) };
}

function isAssistant(message: AgentMessage): message is AssistantMessage {
  return (message as { role?: string }).role === 'assistant';
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * The text a run that THREW reaches the renderer as.
 *
 * `session.failed` carries one string, so a failure whose only stable part is
 * its code has to spell that code into the text — the same `${code}: ${message}`
 * shape the worker RPC (`errorPayload`) and the resume path
 * (`encodePiResumeError`) already use. Without it the renderer can only match
 * an English sentence, which is how the "model is not available here" copy
 * stopped firing once the session path started throwing `model_not_in_catalog`
 * instead of the older `Pi model not found` (D19, 2026-09-17 point-check).
 *
 * Only the thrown path. A run that ENDS in failure reports through
 * `RunProjection.finish`, whose message is the provider's own sentence.
 */
function thrownRunErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? `${code}: ${error.message}` : error.message;
}

function resolveError(input: {
  thrown?: Error;
  aborted: boolean;
  last?: CollectedTurn;
}): { code: string; message: string } | undefined {
  if (input.aborted) return { code: 'aborted', message: 'the run was aborted by its caller' };
  if (input.thrown) {
    return {
      code: input.thrown instanceof RuntimeHostError ? input.thrown.code : 'loop_threw',
      message: input.thrown.message,
    };
  }
  if (!input.last) {
    return { code: 'no_assistant_message', message: 'the loop ended without an assistant turn' };
  }
  if (input.last.stopReason === 'error' || input.last.stopReason === 'aborted') {
    return {
      code: `stop_${input.last.stopReason}`,
      message:
        input.last.errorMessage ?? `the turn ended with stopReason "${input.last.stopReason}"`,
    };
  }
  return undefined;
}

function sumUsage(values: (Usage | null)[]): Usage | null {
  const reported = values.filter((usage): usage is Usage => usage !== null);
  if (!reported.length) return null;
  const total: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const usage of reported) {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
      total[key] += usage[key];
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
      total.cost[key] += usage.cost[key];
    if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
    if (usage.cacheWrite1h !== undefined)
      total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
  return total;
}
