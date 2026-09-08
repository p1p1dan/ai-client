/**
 * P0-5 - plugin-agent-loop, the minimal turn driver.
 *
 * This is the plugin that answers ARD risk R1 ("pi-agent-core's Agent class is
 * opaque"): if `Agent` + `pi-ai` can carry one prompt to a complete streamed
 * reply, ARD D3's layering holds and P1/P2/P3 can be built on it in parallel.
 * The wiring below is deliberately the same shape PI-Desktop uses in
 * `subagent.ts` - `streamFn` delegating to `models.streamSimple`, `getApiKey`
 * returning the provider key, `convertToLlm` taken from pi-agent-core - because
 * that shape is the part already proven in production.
 *
 * ## What is NOT here, and why
 *
 * No tools, no permission hook, no compaction, no retry ladder. Each of those
 * is a later phase with its own contract in `contracts.ts`, and a placeholder
 * version of any of them would be an empty shell of exactly the kind
 * `docs/agent-project-engineering.md` A3 rules out. The one thing that IS
 * pinned here is the single-turn boundary, and it is a flag rather than an
 * omission so that P1 flips a documented switch instead of discovering an
 * implicit assumption.
 */

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  convertToLlm,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { Context } from 'cordis';
import { Service } from 'cordis';
import {
  type AgentLoopService,
  LOOP_SERVICE,
  MODEL_SERVICE,
  RuntimeConfigError,
  type RuntimeRunRequest,
  type RuntimeRunResult,
  TRACE_SERVICE,
} from '../../contracts.ts';

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
  static inject = [MODEL_SERVICE, TRACE_SERVICE];

  private readonly config: AgentLoopConfig;

  constructor(ctx: Context, config: AgentLoopConfig = DEFAULT_AGENT_LOOP_CONFIG) {
    super(ctx, LOOP_SERVICE);
    this.config = config;
  }

  async run(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
    const adapter = this.ctx.runtimeModel;
    const ref = request.model ?? adapter.defaultRef();
    if (!ref) {
      throw new RuntimeConfigError(
        'catalog_empty',
        'the model catalog is empty, so there is nothing to run against'
      );
    }
    const resolved = adapter.resolve(ref);
    const trace = this.ctx.runtimeTrace.begin({
      runId: request.runId,
      input: request.prompt,
      model: resolved.model.id,
      provider: resolved.ref.provider,
    });
    trace.note('note', {
      event: 'run_start',
      system_prompt_bytes: Buffer.byteLength(request.systemPrompt, 'utf8'),
      thinking_level: request.thinkingLevel ?? this.config.defaultThinkingLevel,
      single_turn: this.config.singleTurn,
      catalog_source: adapter.source,
    });

    const collected = new TurnCollector();
    const agent = new Agent({
      streamFn: (model, context, options) => resolved.models.streamSimple(model, context, options),
      // Per request rather than captured, so a key rewritten on disk between
      // turns of a long run is picked up. Empty string means "no key" and must
      // become undefined - pi-ai treats an empty key as a configured one.
      getApiKey: async () => resolved.requestKey || undefined,
      convertToLlm,
      initialState: {
        systemPrompt: request.systemPrompt,
        model: resolved.model,
        thinkingLevel: request.thinkingLevel ?? this.config.defaultThinkingLevel,
        tools: [],
        messages: [],
      },
      ...(this.config.singleTurn ? { shouldStopAfterTurn: () => true } : {}),
    });

    const unsubscribe = agent.subscribe((event) => {
      collected.observe(event);
      request.onEvent?.(event);
    });
    const onAbort = () => agent.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    let thrown: Error | undefined;
    try {
      await agent.prompt(request.prompt);
      await agent.waitForIdle();
    } catch (error) {
      // `Agent` encodes provider failures in the stream rather than throwing,
      // so reaching here means something structural (a bad model object, a
      // listener that threw). Recorded as the run's error instead of
      // propagating, because a caller that gets a rejection loses the trace.
      thrown = error instanceof Error ? error : new Error(String(error));
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
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
    const error = resolveError({ thrown, aborted, last });
    const result: Omit<RuntimeRunResult, 'trace'> = {
      runId: trace.runId,
      success: !error,
      text: collected.text,
      stopReason: aborted ? 'aborted' : (last?.stopReason ?? 'error'),
      usage: last?.usage ?? null,
      latencyMs: 0,
      turns: collected.turns.length,
      ...(error ? { error } : {}),
    };
    const finished = trace.finish({
      final_output: result.text,
      usage: result.usage,
      success: result.success,
      ...(error ? { error } : {}),
    });
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
  if (input.thrown) return { code: 'loop_threw', message: input.thrown.message };
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
