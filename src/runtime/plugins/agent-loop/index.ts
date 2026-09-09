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
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { Context } from 'cordis';
import { Service } from 'cordis';
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
import { CONTEXT_SERVICE } from '../context/index.ts';
import type { ComposedPrompt } from '../prompt/segments.ts';
import { PERMISSIONS_ENTRY } from '../session/legacy.ts';
import { interruptedToolResults } from '../session/recovery.ts';

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
  /** Sent when a caller does not name one. */
  defaultThinkingLevel: ThinkingLevel;
}

export const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  singleTurn: true,
  defaultThinkingLevel: 'off',
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
        payload: { error: error instanceof Error ? error.message : String(error) },
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
      throw new RuntimeConfigError(
        'catalog_empty',
        'the model catalog is empty, so there is nothing to run against'
      );
    }
    const resolved = adapter.resolve(ref);
    const thinkingLevel =
      request.thinkingLevel ?? snapshot?.thinkingLevel ?? this.config.defaultThinkingLevel;
    let systemPrompt = request.systemPrompt;
    let composed: ComposedPrompt | undefined;
    if (systemPrompt === undefined) {
      composed = await this.ctx.runtimePrompt.compose({ targetPath: request.targetPath });
      systemPrompt = composed.text;
    }
    const trace = this.ctx.runtimeTrace.begin({
      runId: request.runId,
      input: request.prompt,
      model: resolved.model.id,
      provider: resolved.ref.provider,
    });
    const projected = this.ctx.runtimeEvents.startRun(
      request.logicalSessionId ?? snapshot?.id ?? trace.runId,
      trace.runId,
      snapshot?.entries.flatMap((entry) => (entry.type === 'message' ? [entry.message] : [])) ?? [],
      resolved.model.contextWindow
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

    // Optional: P0 and the tool-less smoke lane run without it, and a run with
    // no compaction service behaves exactly as it did before P2-3.
    const context = this.ctx.get(CONTEXT_SERVICE);
    context?.beginRun(snapshot);
    const collected = new TurnCollector();
    const toolCalls = new Set<string>();
    const unsubscribePermissions = this.ctx.get('runtimePermissions')?.onDecision((record) => {
      if (toolCalls.has(record.request.toolCallId))
        trace.note('note', { event: 'permission_decision', ...record });
    });
    let turnCount = 0;
    const agent = new Agent({
      streamFn: (model, context, options) => resolved.models.streamSimple(model, context, options),
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
      prepareNextTurnWithContext: context
        ? async (turn, signal) => {
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
                  context.compactionTool ?? '\u0000'
                ),
              });
            if (!prepared.compaction && !prepared.reminder) return undefined;
            return { context: { ...turn.context, messages: prepared.messages } };
          }
        : undefined,
    });

    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === 'message_end' && session) await session.appendMessage(event.message);
      collected.observe(event);
      projected.observe(event);
      if (event.type === 'tool_execution_start') toolCalls.add(event.toolCallId);
      if (event.type === 'tool_execution_start')
        trace.note('tool', {
          event: event.type,
          tool_call_id: event.toolCallId,
          tool: event.toolName,
          args: event.args,
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
    const onAbort = () => agent.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    let thrown: Error | undefined;
    try {
      request.signal?.throwIfAborted();
      // New input must fit on its own; only the completed history can be
      // compacted before the first request of this run.
      const incomingTokens =
        estimateContextTokens([{ role: 'user', content: request.prompt, timestamp: Date.now() }])
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
          if (prepared.compaction) {
            trace.note('note', { event: 'compaction', ...prepared.compaction });
            const summary = prepared.messages[0];
            if (summary?.role === 'compactionSummary') projected.compaction(summary.summary);
          }
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
      await agent.prompt(request.prompt);
      await agent.waitForIdle();
      await session?.flush();
    } catch (error) {
      // `Agent` encodes provider failures in the stream rather than throwing,
      // so reaching here means something structural (a bad model object, a
      // listener that threw). Recorded as the run's error instead of
      // propagating, because a caller that gets a rejection loses the trace.
      thrown = error instanceof Error ? error : new Error(String(error));
    } finally {
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
    const result: Omit<RuntimeRunResult, 'trace'> = {
      runId: trace.runId,
      success: !error,
      text: collected.text,
      stopReason: aborted ? 'aborted' : (last?.stopReason ?? 'error'),
      usage: sumUsage(collected.turns.map((turn) => turn.usage)),
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
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    });
  }

  get text(): string {
    return this.turns.map((turn) => turn.text).join('');
  }
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
