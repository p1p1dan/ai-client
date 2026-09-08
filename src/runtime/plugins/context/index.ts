/**
 * P2-3 execution + P1-9/P2-8 pairing: the service that owns one run's context
 * window — when it is warned, when it is rolled over, and who asked.
 *
 * ## Why this service exists now
 *
 * `budget.ts` decides *whether* to compact and `compaction.ts` decides *what
 * the next window holds*, but neither can be reached by the model: a tool that
 * queues an intent nobody consumes is worse than no tool, because the model is
 * told it can steer compaction and then nothing happens. The plan board makes
 * that explicit — P1-9 (`new_context`) and P2-8 (the reminder that names it)
 * ship as a pair, and a pair needs a consumer. This is the consumer: it
 * registers the tool, claims the reminders, and performs the rollover at the
 * turn boundary the agent loop hands it.
 *
 * ## What is deliberately still missing
 *
 * The checkpoint lives in memory for the length of a run. Writing it as a
 * durable compaction record — so a resumed session shows the boundary and a
 * later compaction can update the previous summary across runs — is P2-4 on
 * top of P3's session store. The record's fields are already the ones a
 * `CompactionEntry` needs (`summary` / `tokensBefore` / `retainedTail` /
 * `usage` / `details`), so P2-4 persists this shape rather than replacing it.
 *
 * The transcript itself is never truncated: compaction replaces the *request*
 * context, and `Agent.state.messages` keeps every message. That split is what
 * lets P3 write a full session while the provider sees a compacted window.
 */

import {
  type AgentMessage,
  type CompactionEntry,
  type CompactionPreparation,
  type CompactResult,
  compact,
  createCompactionSummaryMessage,
  type Entry,
  estimateContextTokens,
  prepareCompaction,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { Api, Model, Models, Usage } from '@earendil-works/pi-ai';
import { type Context, Service } from 'cordis';
import { RuntimeHostError } from '../../host/errors.ts';
import { TOOLS_SERVICE } from '../tools/index.ts';
import {
  type CompactionFamily,
  NEW_CONTEXT_TOOL_NAME,
  newContextTool,
} from '../tools/new-context.ts';
import {
  compactionNeeded,
  contextBudget,
  NO_REMINDERS_CLAIMED,
  type ReminderState,
  type ReminderTier,
  retainedUserMessageBudget,
  selectReminder,
} from './budget.ts';
import {
  CONTEXT_ROLLOVER_SUMMARY,
  type RetentionMode,
  shapeForCheckpoint,
  toMessageEntries,
} from './compaction.ts';

export const CONTEXT_SERVICE = 'runtimeContext';

export interface ContextConfig {
  /** ARD D9's safety guard. Off leaves the loop exactly as P0 ran it. */
  enabled?: boolean;
  /**
   * Which compaction family the model's request and the hard limit produce.
   *
   * Not a user-facing setting — PI-Desktop does not expose it either, and a
   * user cannot judge the trade-off from the UI. `summary` spends one provider
   * request on a structured summary; `fresh_window` rolls over without one.
   */
  family?: CompactionFamily;
}

export interface CompactionOutcome {
  reason: 'model_requested' | 'hard_limit';
  family: CompactionFamily;
  tokensBefore: number;
  tokensAfter: number;
  /** Messages carried past the boundary, summary message excluded. */
  retained: number;
  summaryBytes: number;
  /** Provider usage the summary request itself cost, absent for a rollover. */
  usage?: Usage;
}

export interface TurnReminder {
  tier: ReminderTier;
  text: string;
}

export interface TurnPreparation {
  /** Messages for the next provider request. Same array contents when nothing changed. */
  messages: AgentMessage[];
  compaction?: CompactionOutcome;
  reminder?: TurnReminder;
  /**
   * A compaction that was asked for but could not run, below the hard limit.
   *
   * Not an error: nothing is over the boundary, so the run continues on the
   * uncompacted context. At the hard limit the same condition throws instead.
   */
  skipped?: { code: string; message: string };
}

export interface PrepareTurnRequest {
  messages: readonly AgentMessage[];
  /** Active model: its window sets every threshold, and it generates the summary. */
  model: Model<Api>;
  /** Provider registry scoped to that model, for the summary request. */
  models: Models;
  thinkingLevel?: ThinkingLevel;
  /** True while the model is mid-turn (tool results pending), which changes retention. */
  retention?: RetentionMode;
  signal?: AbortSignal;
}

export interface RuntimeContextService {
  readonly enabled: boolean;
  readonly family: CompactionFamily;
  /** Name of the registered compaction tool, or `undefined` when none is registered. */
  readonly compactionTool: string | undefined;
  /** True once the model called `new_context` and the intent has not been consumed. */
  readonly pendingNewWindow: boolean;
  /** The tool's callback. Records an intent only; nothing happens until the turn boundary. */
  requestNewWindow(): void;
  /** Clears intent, reminder claims and the in-memory checkpoint. Called per run. */
  beginRun(): void;
  prepareTurn(request: PrepareTurnRequest): Promise<TurnPreparation>;
}

declare module 'cordis' {
  interface Context {
    runtimeContext: RuntimeContextService;
  }
}

export class ContextPlugin extends Service implements RuntimeContextService {
  readonly enabled: boolean;
  readonly family: CompactionFamily;
  private toolName: string | undefined;
  private pending = false;
  private reminders: ReminderState = NO_REMINDERS_CLAIMED;
  /** Last checkpoint of this run, kept so the next one updates its summary. */
  private checkpoint: CompactionEntry | undefined;
  /** Identity anchor: the summary message this service put at the head of the context. */
  private summaryMessage: AgentMessage | undefined;

  constructor(ctx: Context, config: ContextConfig = {}) {
    super(ctx, CONTEXT_SERVICE);
    this.enabled = config.enabled ?? true;
    this.family = config.family ?? 'summary';
    // Registered here rather than in `bootstrap.ts` so the tool cannot exist
    // without the consumer that honours it: whoever registers the intent is
    // the one that resolves it.
    const tools = ctx.get(TOOLS_SERVICE);
    if (this.enabled && tools) {
      tools.register(
        newContextTool({ family: this.family, request: () => this.requestNewWindow() }),
        'read'
      );
      this.toolName = NEW_CONTEXT_TOOL_NAME;
    }
    ctx.effect(() => () => {
      this.pending = false;
      this.checkpoint = undefined;
      this.summaryMessage = undefined;
    });
  }

  get compactionTool(): string | undefined {
    return this.toolName;
  }

  get pendingNewWindow(): boolean {
    return this.pending;
  }

  requestNewWindow(): void {
    if (this.enabled) this.pending = true;
  }

  beginRun(): void {
    this.pending = false;
    this.reminders = NO_REMINDERS_CLAIMED;
    this.checkpoint = undefined;
    this.summaryMessage = undefined;
  }

  async prepareTurn(request: PrepareTurnRequest): Promise<TurnPreparation> {
    const messages = [...request.messages];
    if (!this.enabled) {
      this.pending = false;
      return { messages };
    }
    const budget = contextBudget(request.model, estimateContextTokens(messages).tokens);
    const hardLimit = compactionNeeded(budget);
    // Read and clear together: an intent that survived its own boundary would
    // compact a second time on the next turn for no reason.
    const modelRequested = this.pending;
    this.pending = false;
    if (!hardLimit && !modelRequested) {
      const decision = selectReminder(budget, this.reminders, { compactionTool: this.toolName });
      if (!decision) return { messages };
      this.reminders = decision.state;
      // Carried as a trailing message, not a system-prompt append: the system
      // prompt is the cached prefix ARD D9 gates on, and Codex puts its own
      // reminders in conversation history for the same reason.
      return {
        messages: [...messages, reminderMessage(decision.text)],
        reminder: { tier: decision.tier, text: decision.text },
      };
    }
    return await this.compactNow({
      request,
      messages,
      budget,
      reason: hardLimit ? 'hard_limit' : 'model_requested',
    });
  }

  private async compactNow(input: {
    request: PrepareTurnRequest;
    messages: AgentMessage[];
    budget: ReturnType<typeof contextBudget>;
    reason: CompactionOutcome['reason'];
  }): Promise<TurnPreparation> {
    const { request, messages, budget, reason } = input;
    const prepared = prepareCompaction(this.entriesFor(messages), {
      enabled: true,
      reserveTokens: budget.requestHeadroom,
      keepRecentTokens: budget.keepRecentTokens,
    });
    if (!prepared.ok) {
      return this.giveUp(reason, messages, 'compaction_prepare_failed', prepared.error.message);
    }
    if (!prepared.value) {
      return this.giveUp(
        reason,
        messages,
        'compaction_empty_range',
        'there is nothing between the last checkpoint and now to compact'
      );
    }
    const preparation = shapeForCheckpoint(
      prepared.value,
      retainedUserMessageBudget(budget),
      request.retention ?? 'completed_turn'
    );
    let result: CompactResult;
    if (this.family === 'fresh_window') {
      result = {
        summary: CONTEXT_ROLLOVER_SUMMARY,
        tokensBefore: preparation.tokensBefore,
        retainedTail: preparation.retainedTail,
      };
    } else {
      const summarized = await this.summarize(preparation, request);
      if (!summarized.ok) {
        return this.giveUp(reason, messages, 'compaction_summary_failed', summarized.message);
      }
      result = summarized.value;
    }
    const next = this.installCheckpoint(result);
    const tokensAfter = estimateContextTokens(next).tokens;
    if (reason === 'hard_limit' && tokensAfter >= budget.hardLimit) {
      // Continuing would issue exactly the request this guard exists to
      // prevent, so this one is fatal even though the checkpoint was built.
      throw new RuntimeHostError(
        'context_compaction_failed',
        'the checkpoint stayed above the safe model context budget'
      );
    }
    return {
      messages: next,
      compaction: {
        reason,
        family: this.family,
        tokensBefore: result.tokensBefore,
        tokensAfter,
        retained: result.retainedTail.length,
        summaryBytes: Buffer.byteLength(result.summary, 'utf8'),
        ...(result.usage ? { usage: result.usage } : {}),
      },
    };
  }

  private async summarize(
    preparation: CompactionPreparation,
    request: PrepareTurnRequest
  ): Promise<{ ok: true; value: CompactResult } | { ok: false; message: string }> {
    try {
      const summarized = await compact(
        preparation,
        request.models,
        request.model,
        undefined,
        request.signal,
        request.thinkingLevel
      );
      return summarized.ok
        ? { ok: true, value: summarized.value }
        : { ok: false, message: summarized.error.message };
    } catch (error) {
      // `compact` reports provider failures through its Result, so reaching
      // here is structural. Treated the same way: below the hard limit the run
      // continues uncompacted rather than dying on a summary.
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Replace the request context with the checkpoint, and remember it for the next one. */
  private installCheckpoint(result: CompactResult): AgentMessage[] {
    const timestamp = Date.now();
    const seq = (this.checkpoint?.seq ?? -1) + 1;
    this.checkpoint = {
      type: 'compaction',
      id: `checkpoint:${seq}`,
      seq,
      parentId: this.checkpoint?.id ?? null,
      timestamp,
      summary: result.summary,
      retainedTail: result.retainedTail,
      tokensBefore: result.tokensBefore,
      ...(result.details === undefined ? {} : { details: result.details }),
      ...(result.usage ? { usage: result.usage } : {}),
    };
    this.summaryMessage = createCompactionSummaryMessage(
      result.summary,
      result.tokensBefore,
      timestamp
    );
    // Exactly what pi's own `buildSessionContext` produces from a compaction
    // entry, so P3 replaying a persisted checkpoint rebuilds this same window.
    return [this.summaryMessage, ...result.retainedTail];
  }

  /**
   * Project the live context onto entries `prepareCompaction` understands.
   *
   * When the head of the context is still the summary message this service
   * installed, the previous checkpoint is handed back as a real compaction
   * entry: pi then updates that summary instead of summarizing it again, and
   * replays its retained tail itself — so those messages are skipped here to
   * avoid counting them twice.
   */
  private entriesFor(messages: AgentMessage[]): Entry[] {
    const checkpoint = this.checkpoint;
    if (!checkpoint || messages[0] !== this.summaryMessage) return toMessageEntries(messages);
    const rest = messages.slice(1 + checkpoint.retainedTail.length);
    return [
      checkpoint,
      ...toMessageEntries(rest, {
        idPrefix: `${checkpoint.id}:after`,
        startSeq: checkpoint.seq + 1,
        parentId: checkpoint.id,
      }),
    ];
  }

  private giveUp(
    reason: CompactionOutcome['reason'],
    messages: AgentMessage[],
    code: string,
    message: string
  ): TurnPreparation {
    if (reason === 'hard_limit') throw new RuntimeHostError('context_compaction_failed', message);
    return { messages, skipped: { code, message } };
  }
}

function reminderMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}
