import type { PermissionDetail } from '../shared/types/runtimeEvents.ts';
import {
  type CodexBlock,
  type CodexItemMapping,
  mapCodexItem,
  readCodexItemId,
  readCodexItemType,
  toPermissionFileChanges,
} from './codexItemMapper.ts';
import type { EmitFn, LogFn } from './eventNormalizer.ts';

/**
 * Codex notification stream -> AiClient runtime events. The turn loop.
 *
 * ## Why this file exists at all
 *
 * The S2 slice table (`0 → 1 → 2 → {3,4},5`) had NO owner for the turn loop:
 * slice 3 is the question bridge, 4 the approval bridge, 5 history. But codex
 * only ever asks a question or requests an approval IN THE MIDDLE OF A TURN —
 * with no turn loop, 3 and 4 could only ever be accepted against fixture
 * replay, i.e. they would land green and be dead code in production. This is
 * that missing piece, and it is deliberately scheduled BEFORE slice 3.
 *
 * ## Division of labour — the one rule that must not be broken
 *
 * This class never emits the session-status event. `codexStatus.ts` +
 * `codexRuntime.onStatusChanged` own it outright (S2 C10 rule 3): the server's
 * `thread/status/changed` is a full snapshot, so any second derivation here
 * would immediately be a laggier competing truth — exactly the defect the
 * Claude-side `questionBridge.peerHasPending` patch had to work around. The
 * ban is enforced mechanically: `codexNormalizer.test.ts` reads this file's own
 * source and asserts the literal never appears in it.
 *
 * ## Turn isolation
 *
 * All mutable state hangs off one `TurnState` that is REPLACED whenever a new
 * turnId appears, so nothing from turn N can address a block, message or tool
 * row of turn N+1. Frames without a turnId (e.g. `item/started` for a `plan`
 * item, whose params carry only `item` [实测]) join the current turn rather
 * than opening a phantom one.
 *
 * ## Method spellings
 *
 * Every method string below comes from
 * `__tests__/fixtures/codex/codex-method-contract.json` (the binary's own
 * inventory) and the test pins each one against it. A guessed notification name
 * is not a compile error and not a runtime error — it is silence, which is the
 * most expensive failure mode available here.
 */

/** Notifications this class turns into runtime events. Pinned against the contract. */
export const CODEX_NORMALIZER_METHODS = {
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningSummaryPartAdded: 'item/reasoning/summaryPartAdded',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  commandExecutionOutputDelta: 'item/commandExecution/outputDelta',
  fileChangeOutputDelta: 'item/fileChange/outputDelta',
  mcpToolCallProgress: 'item/mcpToolCall/progress',
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  rateLimitsUpdated: 'account/rateLimits/updated',
} as const;

/**
 * Notifications we receive and deliberately do NOT act on, with the reason.
 *
 * Kept as data rather than as a `default:` fallthrough so that "we decided to
 * drop this" and "we have never heard of this" stay distinguishable in the
 * counters: the first is a design decision, the second is a codex upgrade we
 * need to hear about. Entries whose owner is another module are listed here so
 * that routing every notification through `ingest()` is safe.
 */
export const CODEX_IGNORED_NOTIFICATIONS: Readonly<Record<string, string>> = {
  'thread/status/changed': 'owned by codexStatus.ts + codexRuntime — the single status truth (C10)',
  'serverRequest/resolved': 'owned by the pending table: it settles a request, it is not content',
  'thread/started': 'thread lifecycle; codexRuntime owns session.created',
  'turn/plan/updated': 'plan items are not rendered this round (see CODEX_ITEM_RULES.plan)',
  'item/plan/delta': 'plan items are not rendered this round (see CODEX_ITEM_RULES.plan)',
  'turn/diff/updated':
    'cumulative turn diff; the per-item fileChange rows already carry every patch',
};

/**
 * Cap on `tool.updated` pings forwarded per item.
 *
 * Output deltas are unbounded by nature (one `npm install` produces thousands),
 * and the ping carries no body — after a few the renderer learns nothing new
 * while every extra one costs an IPC round trip. The real output arrives whole
 * on `item/completed`.
 */
export const CODEX_TOOL_PROGRESS_MAX_PER_ITEM = 20;

/**
 * Cap on remembered fileChange diffs.
 *
 * The cache exists for slice 4's correlator: the diff arrives on `item/started`
 * ~1ms BEFORE the approval request that needs it [实测]. Bounded because a long
 * session must not accumulate every patch it ever produced.
 */
export const CODEX_FILE_CHANGE_CACHE_MAX = 64;

export interface CodexNormalizerOptions {
  emit: EmitFn;
  sessionId: string;
  log?: LogFn;
  /**
   * One session ≡ one thread (C12). When set, frames carrying a different
   * threadId are dropped and counted rather than projected onto this session.
   */
  threadId?: string;
}

export interface CodexNormalizerStats {
  /** Turns observed, including ones synthesized from the first turn-scoped frame. */
  turnsStarted: number;
  turnsCompleted: number;
  /** Notifications outside both the handled set and the ignore table. */
  unknownNotifications: number;
  /** Item types outside the pinned 18. */
  unknownItems: number;
  /** Item frames that were not items at all. */
  malformedItems: number;
  /** Frames belonging to another thread. */
  foreignThreadFrames: number;
  /** Notifications dropped on purpose (see `CODEX_IGNORED_NOTIFICATIONS`). */
  ignoredNotifications: number;
  /** Items whose rule says "not rendered this round". */
  skippedItems: number;
}

interface TurnState {
  turnId: string | null;
  /** Assistant envelope, minted lazily on the first assistant-side output. */
  assistantMessageId: string | null;
  /** itemIds whose stream already produced text/thinking, so completion must not repeat it. */
  streamedItems: Set<string>;
  /** itemIds with an open thinking block, closed at item completion or turn end. */
  openThinking: Set<string>;
  /** itemIds that already emitted a tool row. */
  startedTools: Set<string>;
  /** itemIds whose tool row already settled. */
  settledTools: Set<string>;
  /** itemId -> forwarded progress pings. */
  progressCount: Map<string, number>;
  /** itemId -> highest reasoning summary part index seen. */
  reasoningPart: Map<string, number>;
}

function newTurnState(turnId: string | null): TurnState {
  return {
    turnId,
    assistantMessageId: null,
    streamedItems: new Set(),
    openThinking: new Set(),
    startedTools: new Set(),
    settledTools: new Set(),
    progressCount: new Map(),
    reasoningPart: new Map(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The turnId a frame belongs to.
 *
 * `params.turnId` on every item frame [实测]; `params.turn.id` on
 * `turn/completed` [实测]. `turn/started`'s own body has no recorded frame, so
 * both spellings are accepted.
 */
function readTurnId(params: unknown): string | null {
  if (!isRecord(params)) return null;
  const direct = str(params.turnId);
  if (direct) return direct;
  const turn = params.turn;
  return isRecord(turn) ? str(turn.id) : null;
}

/**
 * A streamed text fragment.
 *
 * `delta` is [实测] on `item/reasoning/summaryTextDelta`; the other delta
 * notifications have no recorded frame, so the alternatives are tried in turn.
 * Reading the wrong key would show an empty bubble, so the fallbacks are worth
 * their three lines.
 */
function readDelta(params: unknown): string {
  if (!isRecord(params)) return '';
  const candidates = [params.delta, params.text, params.chunk, params.output];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return '';
}

function readItemId(params: unknown): string | null {
  return isRecord(params) ? str(params.itemId) : null;
}

export class CodexNormalizer {
  private readonly emit: EmitFn;
  private readonly sessionId: string;
  private readonly log: LogFn;
  private readonly expectedThreadId: string | null;

  private turn: TurnState = newTurnState(null);
  /** Monotonic within this instance — keeps message ids unique across turns. */
  private turnSeq = 0;
  private readonly fileChanges = new Map<string, PermissionDetail>();
  private readonly stat: CodexNormalizerStats = {
    turnsStarted: 0,
    turnsCompleted: 0,
    unknownNotifications: 0,
    unknownItems: 0,
    malformedItems: 0,
    foreignThreadFrames: 0,
    ignoredNotifications: 0,
    skippedItems: 0,
  };
  /** Unknown method names seen, deduplicated — one WARN per name, not per frame. */
  private readonly unknownMethods = new Set<string>();

  constructor(options: CodexNormalizerOptions) {
    this.emit = options.emit;
    this.sessionId = options.sessionId;
    this.log = options.log ?? (() => undefined);
    this.expectedThreadId = options.threadId ?? null;
  }

  stats(): Readonly<CodexNormalizerStats> {
    return { ...this.stat };
  }

  /** Turn currently open, `null` before the first turn-scoped frame. */
  currentTurnId(): string | null {
    return this.turn.turnId;
  }

  /**
   * The patch that arrived on `item/started`, for slice 4's approval card.
   *
   * `undefined` means it has not arrived — never a reason to delay the reply
   * (hard constraint 7): a card without a diff is a degraded card, a turn that
   * hangs waiting for one is a broken session.
   */
  getFileChangeDetail(itemId: string): PermissionDetail | undefined {
    return this.fileChanges.get(itemId);
  }

  /**
   * Route one notification.
   *
   * Never throws: a malformed frame is a logged incident, not the end of the
   * session. An unhandled exception here would kill the turn loop and leave
   * every pending card unanswered.
   */
  ingest(method: string, params: unknown): void {
    try {
      if (!this.acceptsThread(params)) {
        this.stat.foreignThreadFrames += 1;
        this.log('WARN codex notification for a foreign thread, ignored', {
          sessionId: this.sessionId,
          method,
        });
        return;
      }

      const M = CODEX_NORMALIZER_METHODS;
      switch (method) {
        case M.turnStarted:
          this.onTurnStarted(params);
          return;
        case M.turnCompleted:
          this.onTurnCompleted(params);
          return;
        case M.itemStarted:
          this.onItemStarted(params);
          return;
        case M.itemCompleted:
          this.onItemCompleted(params);
          return;
        case M.agentMessageDelta:
          this.onAgentMessageDelta(params);
          return;
        case M.reasoningSummaryPartAdded:
          this.onReasoningPartAdded(params);
          return;
        case M.reasoningSummaryTextDelta:
        case M.reasoningTextDelta:
          this.onReasoningDelta(params);
          return;
        case M.commandExecutionOutputDelta:
        case M.fileChangeOutputDelta:
        case M.mcpToolCallProgress:
          this.onToolProgress(params);
          return;
        case M.tokenUsageUpdated:
          this.onTokenUsage(params);
          return;
        case M.rateLimitsUpdated:
          this.onRateLimits(params);
          return;
        default:
          this.onUnhandled(method);
      }
    } catch (err) {
      this.log('codex normalizer error', { sessionId: this.sessionId, method, err });
      this.emit({
        type: 'host.error',
        sessionId: this.sessionId,
        payload: {
          code: 'codex_normalize_error',
          message: err instanceof Error ? err.message : String(err),
          fatal: false,
        },
      });
    }
  }

  /**
   * Close the open turn from outside the notification stream.
   *
   * Used by teardown paths (interrupt, process exit): without it, an aborted
   * turn leaves an assistant message and a thinking block that the renderer
   * shows as still streaming, forever.
   */
  closeTurn(outcome: 'completed' | 'failed' | 'stopped', error?: string): void {
    this.finishOpenBlocks();
    this.emit({
      type: outcome === 'completed' ? 'session.completed' : `session.${outcome}`,
      sessionId: this.sessionId,
      payload: error ? { error } : undefined,
    });
    if (outcome === 'completed') this.stat.turnsCompleted += 1;
    this.turn = newTurnState(null);
  }

  // ---------------------------------------------------------------------------
  // Routing helpers
  // ---------------------------------------------------------------------------

  private acceptsThread(params: unknown): boolean {
    if (!this.expectedThreadId) return true;
    const threadId = isRecord(params) ? str(params.threadId) : null;
    // Absent is accepted: `item/started` for a `plan` item carries only `item`
    // [实测], and dropping those would lose real content over a missing key.
    return threadId === null || threadId === this.expectedThreadId;
  }

  private onUnhandled(method: string): void {
    const ignoredReason = Object.hasOwn(CODEX_IGNORED_NOTIFICATIONS, method)
      ? CODEX_IGNORED_NOTIFICATIONS[method]
      : undefined;
    if (ignoredReason !== undefined) {
      this.stat.ignoredNotifications += 1;
      this.log('codex notification ignored by design', {
        sessionId: this.sessionId,
        method,
        reason: ignoredReason,
      });
      return;
    }
    this.stat.unknownNotifications += 1;
    if (!this.unknownMethods.has(method)) {
      this.unknownMethods.add(method);
      // codex is marked [experimental] upstream, so new notifications are a
      // certainty rather than a risk. One WARN per NAME: a per-frame WARN on a
      // chatty new delta would drown the log it is supposed to inform.
      this.log('WARN codex notification not handled by this build', {
        sessionId: this.sessionId,
        method,
      });
    }
  }

  /**
   * Adopt the frame's turn, replacing all per-turn state when it changed.
   *
   * The previous turn's open blocks are closed first — a turn that was
   * superseded without a `turn/completed` (interrupt, error) would otherwise
   * leave a message the renderer renders as still streaming.
   */
  private ensureTurn(params: unknown): void {
    const turnId = readTurnId(params);
    if (turnId === null) return;
    if (this.turn.turnId === turnId) return;
    if (this.turn.turnId !== null) {
      this.finishOpenBlocks();
      this.log('codex turn superseded without a completion frame', {
        sessionId: this.sessionId,
        previous: this.turn.turnId,
        next: turnId,
      });
    }
    this.turnSeq += 1;
    this.turn = newTurnState(turnId);
    this.stat.turnsStarted += 1;
  }

  // ---------------------------------------------------------------------------
  // Emitters
  // ---------------------------------------------------------------------------

  /**
   * Mint the assistant envelope on demand.
   *
   * Lazy, exactly like the Claude normalizer's `ensureAssistant`: minting it at
   * turn start would leave an empty assistant bubble on a turn that produced
   * nothing but a refusal.
   */
  private ensureAssistant(): string {
    if (this.turn.assistantMessageId) return this.turn.assistantMessageId;
    const messageId = `codex-asst-${this.sessionId}-${this.turn.turnId ?? `t${this.turnSeq}`}`;
    this.turn.assistantMessageId = messageId;
    this.emit({
      type: 'message.started',
      sessionId: this.sessionId,
      payload: { messageId, role: 'assistant' },
    });
    return messageId;
  }

  private emitText(blockId: string, text: string): void {
    if (!text) return;
    const messageId = this.ensureAssistant();
    this.emit({
      type: 'message.delta',
      sessionId: this.sessionId,
      payload: { messageId, blockId, text },
    });
  }

  private emitThinking(itemId: string, text: string): void {
    if (!text) return;
    const messageId = this.ensureAssistant();
    const blockId = `${itemId}:reasoning`;
    if (!this.turn.openThinking.has(itemId)) {
      this.turn.openThinking.add(itemId);
      this.emit({
        type: 'thinking.started',
        sessionId: this.sessionId,
        payload: { messageId, blockId },
      });
    }
    this.emit({
      type: 'thinking.delta',
      sessionId: this.sessionId,
      payload: { messageId, blockId, text },
    });
  }

  private closeThinking(itemId: string): void {
    if (!this.turn.openThinking.delete(itemId)) return;
    const messageId = this.turn.assistantMessageId;
    if (!messageId) return;
    this.emit({
      type: 'thinking.completed',
      sessionId: this.sessionId,
      payload: { messageId, blockId: `${itemId}:reasoning` },
    });
  }

  /** Close everything the current turn left open. Idempotent. */
  private finishOpenBlocks(): void {
    for (const itemId of [...this.turn.openThinking]) this.closeThinking(itemId);
    if (this.turn.assistantMessageId) {
      this.emit({
        type: 'message.completed',
        sessionId: this.sessionId,
        payload: { messageId: this.turn.assistantMessageId },
      });
      this.turn.assistantMessageId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Notification handlers
  // ---------------------------------------------------------------------------

  private onTurnStarted(params: unknown): void {
    const turnId = readTurnId(params);
    if (turnId === null) {
      // A turn we cannot name still starts a turn: reset state so nothing from
      // the previous one leaks in, and let the next frame with an id adopt it.
      this.finishOpenBlocks();
      this.turnSeq += 1;
      this.turn = newTurnState(null);
      this.stat.turnsStarted += 1;
      return;
    }
    this.ensureTurn(params);
  }

  private onTurnCompleted(params: unknown): void {
    this.ensureTurn(params);
    const turn = isRecord(params) && isRecord(params.turn) ? params.turn : null;
    const status = turn ? str(turn.status) : null;
    const error = turn && turn.error != null ? String(turn.error) : null;
    // `status:'completed'` with `error:null` is the recorded shape [实测]; the
    // turn that produced it had its patch DECLINED, so "completed" means the
    // loop ended, not that the agent got what it wanted. Anything else is a
    // failed turn.
    const failed = (status !== null && status !== 'completed') || error !== null;

    this.finishOpenBlocks();
    this.emit({
      type: failed ? 'session.failed' : 'session.completed',
      sessionId: this.sessionId,
      payload: failed ? { error: error ?? `turn ${status ?? 'ended abnormally'}` } : undefined,
    });
    this.stat.turnsCompleted += 1;
    this.turn = newTurnState(null);
  }

  private onItemStarted(params: unknown): void {
    this.ensureTurn(params);
    const item = isRecord(params) ? params.item : undefined;
    const itemType = readCodexItemType(item);
    const itemId = readCodexItemId(item);

    // Cache the patch BEFORE anything else can fail: this frame is the only
    // place the diff appears, and it lands ~1ms before the approval request
    // that renders it [实测].
    if (itemType === 'fileChange' && itemId) {
      const detail = toPermissionFileChanges(item);
      if (detail) this.rememberFileChange(itemId, detail);
    }

    const mapping = mapCodexItem(item);
    this.countMapping(mapping);
    // Only tool rows are emitted on start — a tool that is running is worth
    // showing. Text and reasoning start empty on the wire (`text: ""` [实测]);
    // their content arrives via deltas or on completion.
    if (mapping.mode === 'tool') this.startTool(mapping);
  }

  private onItemCompleted(params: unknown): void {
    this.ensureTurn(params);
    const item = isRecord(params) ? params.item : undefined;
    const mapping = mapCodexItem(item);
    this.countMapping(mapping);
    if (mapping.outcome !== 'rendered') return;

    const itemId = mapping.itemId ?? mapping.itemType ?? 'unknown';
    switch (mapping.mode) {
      case 'user_message':
        this.emitUserEcho(itemId, mapping.blocks);
        return;
      case 'agent_message': {
        // Deltas already streamed this item's text; re-emitting the completed
        // body would duplicate the whole message in the bubble.
        if (this.turn.streamedItems.has(itemId)) return;
        const text = textOf(mapping.blocks, 'text');
        this.emitText(`${itemId}:text`, text);
        return;
      }
      case 'reasoning': {
        if (!this.turn.streamedItems.has(itemId)) {
          this.emitThinking(itemId, textOf(mapping.blocks, 'thinking'));
        }
        this.closeThinking(itemId);
        return;
      }
      case 'tool':
        this.startTool(mapping);
        this.settleTool(mapping);
        return;
      default:
        return;
    }
  }

  private onAgentMessageDelta(params: unknown): void {
    this.ensureTurn(params);
    const itemId = readItemId(params);
    const text = readDelta(params);
    if (!itemId || !text) return;
    this.turn.streamedItems.add(itemId);
    this.emitText(`${itemId}:text`, text);
  }

  private onReasoningDelta(params: unknown): void {
    this.ensureTurn(params);
    const itemId = readItemId(params);
    const text = readDelta(params);
    if (!itemId || !text) return;
    this.turn.streamedItems.add(itemId);
    this.emitThinking(itemId, text);
  }

  /**
   * A new reasoning summary part began.
   *
   * The parts are separate paragraphs of the model's summary and the wire sends
   * no separator with them [实测: `{summaryIndex}` and nothing else], so without
   * this the second part is glued onto the tail of the first mid-sentence.
   */
  private onReasoningPartAdded(params: unknown): void {
    this.ensureTurn(params);
    const itemId = readItemId(params);
    if (!itemId) return;
    const index =
      isRecord(params) && typeof params.summaryIndex === 'number' ? params.summaryIndex : 0;
    const previous = this.turn.reasoningPart.get(itemId);
    this.turn.reasoningPart.set(itemId, index);
    if (previous === undefined || index <= previous) return;
    this.turn.streamedItems.add(itemId);
    this.emitThinking(itemId, '\n\n');
  }

  /**
   * Streamed tool output.
   *
   * Forwarded as a bodyless `tool.updated` ping because the protocol has no
   * field for streaming tool output — `ToolUpdatedEvent.payload` carries only
   * `input`. Same treatment the Claude normalizer gives `tool_progress`. The
   * output itself arrives whole on `item/completed`.
   */
  private onToolProgress(params: unknown): void {
    this.ensureTurn(params);
    const itemId = readItemId(params);
    if (!itemId) return;
    const seen = this.turn.progressCount.get(itemId) ?? 0;
    if (seen >= CODEX_TOOL_PROGRESS_MAX_PER_ITEM) return;
    this.turn.progressCount.set(itemId, seen + 1);
    const messageId = this.turn.assistantMessageId;
    // No envelope yet means no tool row yet either; minting one for a ping
    // would create an assistant bubble out of a progress tick.
    if (!messageId) return;
    this.emit({
      type: 'tool.updated',
      sessionId: this.sessionId,
      payload: { messageId, toolCallId: itemId },
    });
  }

  /**
   * `thread/tokenUsage/updated` -> usage passthrough.
   *
   * `params` is forwarded VERBATIM. Our usage payload is a
   * `Record<string, unknown>` by design, and S1 measured codex sending
   * total+last counters plus `modelContextWindow` — six times the density of
   * the ACP path. Projecting it into a narrower shape here would throw away
   * fields for no gain, and any reshaping would be a guess about field names we
   * have no recorded frame for.
   */
  private onTokenUsage(params: unknown): void {
    if (!isRecord(params)) return;
    this.emit({ type: 'usage.updated', sessionId: this.sessionId, payload: { ...params } });
  }

  /**
   * `account/rateLimits/updated` -> namespaced usage passthrough.
   *
   * Namespaced under `codexRateLimits` on purpose: on this machine every field
   * of it measured NULL (third-party proxy + API-key auth, S1 §6.2 C1), so a
   * consumer that treated it like the token counters would render an empty or
   * zeroed usage bar and present it as fact. Forwarded because the data is real
   * on other setups; kept in its own key so nothing renders it by accident.
   */
  private onRateLimits(params: unknown): void {
    if (!isRecord(params)) return;
    const body = isRecord(params.rateLimits) ? params.rateLimits : params;
    this.emit({
      type: 'usage.updated',
      sessionId: this.sessionId,
      payload: { codexRateLimits: body },
    });
  }

  // ---------------------------------------------------------------------------
  // Item helpers
  // ---------------------------------------------------------------------------

  private countMapping(mapping: CodexItemMapping): void {
    switch (mapping.outcome) {
      case 'unknown':
        this.stat.unknownItems += 1;
        this.log('WARN codex item type outside the pinned contract', {
          sessionId: this.sessionId,
          itemType: mapping.itemType,
          note: mapping.note,
        });
        return;
      case 'malformed':
        this.stat.malformedItems += 1;
        this.log('WARN codex item frame malformed', {
          sessionId: this.sessionId,
          note: mapping.note,
        });
        return;
      case 'skipped':
        this.stat.skippedItems += 1;
        this.log('codex item not rendered this round', {
          sessionId: this.sessionId,
          itemType: mapping.itemType,
          reason: mapping.skipReason,
          note: mapping.note,
        });
        return;
      default:
        return;
    }
  }

  private emitUserEcho(itemId: string, blocks: readonly CodexBlock[]): void {
    const messageId = `codex-user-${itemId}`;
    this.emit({
      type: 'message.started',
      sessionId: this.sessionId,
      payload: { messageId, role: 'user' },
    });
    this.emit({
      type: 'message.delta',
      sessionId: this.sessionId,
      payload: { messageId, blockId: `${itemId}:text`, text: textOf(blocks, 'text') },
    });
    this.emit({
      type: 'message.completed',
      sessionId: this.sessionId,
      payload: { messageId },
    });
  }

  private startTool(mapping: CodexItemMapping): void {
    const call = mapping.blocks.find((block) => block.type === 'tool_call');
    if (!call || call.type !== 'tool_call') return;
    if (this.turn.startedTools.has(call.toolCallId)) return;
    this.turn.startedTools.add(call.toolCallId);
    const messageId = this.ensureAssistant();
    this.emit({
      type: 'tool.started',
      sessionId: this.sessionId,
      payload: {
        messageId,
        toolCallId: call.toolCallId,
        name: call.name,
        input: call.input,
      },
    });
  }

  private settleTool(mapping: CodexItemMapping): void {
    const result = mapping.blocks.find((block) => block.type === 'tool_result');
    if (!result || result.type !== 'tool_result') return;
    // A duplicate `item/completed` (never observed, but replay-merge in slice 5b
    // will feed this function twice by design) must not settle the row twice.
    if (this.turn.settledTools.has(result.toolCallId)) return;
    this.turn.settledTools.add(result.toolCallId);
    const messageId = this.ensureAssistant();
    this.emit({
      type: 'tool.completed',
      sessionId: this.sessionId,
      payload: {
        messageId,
        toolCallId: result.toolCallId,
        ok: result.ok,
        output: result.output,
        error: result.error,
      },
    });
  }

  private rememberFileChange(itemId: string, detail: PermissionDetail): void {
    if (this.fileChanges.size >= CODEX_FILE_CHANGE_CACHE_MAX) {
      // Insertion-ordered: the oldest key is the first one. Dropping the oldest
      // is safe because an approval is answered within the turn that raised it.
      const oldest = this.fileChanges.keys().next();
      if (!oldest.done) this.fileChanges.delete(oldest.value);
    }
    this.fileChanges.set(itemId, detail);
  }
}

/** First block of `kind`'s text, or `''`. */
function textOf(blocks: readonly CodexBlock[], kind: 'text' | 'thinking'): string {
  for (const block of blocks) {
    if (block.type === kind) return block.text;
  }
  return '';
}
