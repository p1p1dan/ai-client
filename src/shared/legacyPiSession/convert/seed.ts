// New in dsh-rebase P1-9b

/**
 * Seed items → DSH seed events, in the shape `dsh-agent-loop` writes a log
 * (plan P1-9 shard 02 §2, shard 03 §2):
 *
 *   turn/start → step/start → [system/message, first step only] → user/message…
 *     → assistant/message | assistant/attempt → tool/call… → tool/result…
 *     → step/end → … → turn/end
 *
 * Cutting (one run = one turn, one reply = one step):
 * - A human prompt or a delegation report opens a turn, unless the open turn
 *   has no reply yet (the loop would have claimed both prompts together).
 * - Other user-role input (internal messages, extension messages, `!bash`,
 *   branch summaries) joins the next step of a run still in progress, and
 *   opens a turn after a run that already ended.
 * - `aiclient.runStop` ends its run where it stands.
 * - A result joins the step whose call it answers; one with no open call is
 *   kept as an ignorable record instead of breaking the step.
 * - A step closes when the next reply or turn begins; a call still without a
 *   result then gets DSH's own `TOOL_OUTCOME_UNKNOWN` closer.
 *
 * The first step holds an empty `system/message`, so surface node 0 is the
 * system head DSH rewrites in place on the first real request.
 */

import { createHash } from 'node:crypto';
import { AICLIENT_INTERJECT_REASON, DSH_TOOL_OUTCOME_UNKNOWN } from '../../dshHistory/types.ts';
import {
  type DshSeedEvent,
  type IrAssistant,
  type IrAssistantEnd,
  type IrBlock,
  type IrCheckpoint,
  type IrIgnorable,
  type IrInput,
  type IrItem,
  type IrResult,
  SEED_SOURCE_KIND,
  type SeedContentBlock,
  type SeedImage,
  type SeedJson,
  type SeedSurfaceOp,
  SYSTEM_PROMPT_SOURCE_KIND,
} from './types.ts';

/** `dsh-compaction-basic`'s framing of a checkpoint node, so DSH reads it as a prior checkpoint. */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';
export const SUMMARY_OPEN_TAG = '<compacted-summary>';
export const SUMMARY_CLOSE_TAG = '</compacted-summary>';

/** `dsh-session`'s wording for a recorded call whose result never was (crash closer). */
export const OUTCOME_UNKNOWN_TEXT =
  'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.';
export const OUTCOME_UNKNOWN_ERROR_NAME = 'ToolOutcomeUnknownError';

export interface SeedBuildOptions {
  /**
   * Read a run that stops mid-way (no reply to its last input, a call without
   * a result, tools answered and no reply after them) as a crash: the turn
   * ends `interrupted`. A direct import records no failures, so it is off.
   */
  inferInterruptions: boolean;
}

export interface SeedBuildCounts {
  turns: number;
  steps: number;
  turnEnds: Record<string, number>;
  imageBlocks: number;
  keptOriginals: number;
  retainedCopies: number;
  summaryOnly: number;
  appended: number;
  compactionAnchorsMissing: number;
  compactionTailMismatch: number;
  danglingCalls: number;
  orphanResults: number;
  turnsWithoutPrompt: number;
  crashedRuns: number;
  strayStops: number;
}

export interface SeedBuild {
  events: DshSeedEvent[];
  images: SeedImage[];
  counts: SeedBuildCounts;
}

interface Reply {
  id: string;
  ends: IrAssistantEnd;
  hasCalls: boolean;
  errorMessage?: string;
}

interface StepState {
  no: number;
  reply?: Reply;
  /** Call id → seq of its `tool/call`, until a result answers it. */
  pending: Map<string, number>;
  lastTime: number;
  dangling: number;
  /** A prompt or a runtime message in this step was waiting for the model. */
  awaitsReply: boolean;
}

interface TurnState {
  no: number;
  steps: number;
  hasReply: boolean;
  anyLength: boolean;
  lastStep?: { reply?: Reply; dangling: number; awaitsReply: boolean };
  lastTime: number;
}

const COMPLETED = { kind: 'completed' } as const;
const INTERRUPTED = { kind: 'interrupted' } as const;
const MAX_TOKENS = { kind: 'max-tokens' } as const;

/** One key per distinct (bytes, name): the store dedups bytes, names stay per image. */
class ImageTable {
  readonly images: SeedImage[] = [];
  private readonly keys = new Map<string, string>();

  keyOf(data: string, mediaType: string, name: string | undefined): string {
    const identity = JSON.stringify([data, mediaType, name ?? null]);
    const known = this.keys.get(identity);
    if (known) return known;
    const digest = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    const key = `img-${this.images.length + 1}-${digest}`;
    this.keys.set(identity, key);
    this.images.push({ key, mediaType, data, ...(name ? { name } : {}) });
    return key;
  }
}

class SeedBuilder {
  readonly events: DshSeedEvent[] = [];
  readonly counts: SeedBuildCounts = {
    turns: 0,
    steps: 0,
    turnEnds: {},
    imageBlocks: 0,
    keptOriginals: 0,
    retainedCopies: 0,
    summaryOnly: 0,
    appended: 0,
    compactionAnchorsMissing: 0,
    compactionTailMismatch: 0,
    danglingCalls: 0,
    orphanResults: 0,
    turnsWithoutPrompt: 0,
    crashedRuns: 0,
    strayStops: 0,
  };
  readonly imageTable = new ImageTable();
  private readonly options: SeedBuildOptions;
  /** Surface node seqs in model-visible order; node 0 is the system head once emitted. */
  private readonly nodes: number[] = [];
  /** Message id → seq of the event that appended it. */
  private readonly nodeOf = new Map<string, number>();
  private turn: TurnState | null = null;
  private step: StepState | null = null;
  private lastTime = 0;
  private lastTurnEnd: string | undefined;

  constructor(options: SeedBuildOptions) {
    this.options = options;
  }

  private emit(
    type: string,
    time: number,
    data: unknown,
    extra: { surfaceOp?: SeedSurfaceOp; sourceEventSeqs?: number[]; ignorable?: true } = {}
  ): number {
    const seq = this.events.length;
    this.events.push({ type, seq, time, data, ...extra });
    this.lastTime = time;
    if (this.turn) this.turn.lastTime = time;
    if (this.step) this.step.lastTime = time;
    return seq;
  }

  /** Append a message-producing event to the surface tail. */
  private appendNode(type: string, time: number, id: string, data: unknown, extra = {}): number {
    const seq = this.emit(type, time, data, { surfaceOp: 'append', ...extra });
    this.nodes.push(seq);
    this.nodeOf.set(id, seq);
    return seq;
  }

  private blocks(blocks: readonly IrBlock[]): SeedContentBlock[] {
    return blocks.map((block): SeedContentBlock => {
      if (block.type !== 'image') return block;
      if (block.data === undefined) {
        // Nothing to admit: say so where the image was, as admission failure does.
        return { type: 'text', text: `[image not migrated: ${block.mediaType}]` };
      }
      this.counts.imageBlocks += 1;
      return {
        type: 'image',
        attachment: {
          pendingImage: this.imageTable.keyOf(block.data, block.mediaType, block.name),
          mediaType: block.mediaType,
          ...(block.name ? { name: block.name } : {}),
        },
      };
    });
  }

  // ---- turns and steps --------------------------------------------------------

  private openTurn(time: number): TurnState {
    this.counts.turns += 1;
    const turn: TurnState = {
      no: this.counts.turns,
      steps: 0,
      hasReply: false,
      anyLength: false,
      lastTime: time,
    };
    this.turn = turn;
    this.emit('turn/start', time, { turn: turn.no });
    return turn;
  }

  private openStep(openerId: string, time: number): StepState {
    const turn = this.turn ?? this.openTurn(time);
    turn.steps += 1;
    this.counts.steps += 1;
    const step: StepState = {
      no: turn.steps,
      pending: new Map(),
      lastTime: time,
      dangling: 0,
      awaitsReply: false,
    };
    this.step = step;
    this.emit('step/start', time, { turn: turn.no, step: step.no });
    if (this.nodes.length === 0) {
      this.appendNode('system/message', time, `${openerId}:sys0`, {
        turn: turn.no,
        step: step.no,
        message: {
          id: `${openerId}:sys0`,
          role: 'system',
          content: [],
          source: { kind: SYSTEM_PROMPT_SOURCE_KIND },
        },
      });
    }
    return step;
  }

  private closeStep(): void {
    const step = this.step;
    const turn = this.turn;
    if (!step || !turn) return;
    for (const [callId, callSeq] of step.pending) {
      const id = `${step.reply?.id ?? `turn-${turn.no}-step-${step.no}`}:unknown-result:${callId}`;
      this.appendNode(
        'tool/result',
        step.lastTime,
        id,
        {
          turn: turn.no,
          step: step.no,
          message: {
            id,
            role: 'tool',
            content: [{ type: 'text', text: OUTCOME_UNKNOWN_TEXT }],
            source: { kind: 'tool', callId },
            toolCallId: callId,
            isError: true,
          },
          error: { name: OUTCOME_UNKNOWN_ERROR_NAME, code: DSH_TOOL_OUTCOME_UNKNOWN },
        },
        { sourceEventSeqs: [callSeq] }
      );
      step.dangling += 1;
      this.counts.danglingCalls += 1;
    }
    step.pending.clear();
    this.emit('step/end', step.lastTime, { turn: turn.no, step: step.no });
    turn.lastStep = {
      ...(step.reply ? { reply: step.reply } : {}),
      dangling: step.dangling,
      awaitsReply: step.awaitsReply,
    };
    this.step = null;
  }

  private reasonFor(turn: TurnState, stop?: 'user_stop' | 'interjected'): SeedJson {
    if (stop === 'user_stop') return { kind: 'aborted', reason: { kind: 'user' } };
    if (stop === 'interjected')
      return { kind: 'aborted', reason: { kind: 'hook', reason: AICLIENT_INTERJECT_REASON } };
    const infer = this.options.inferInterruptions;
    const settled = turn.anyLength ? MAX_TOKENS : COMPLETED;
    const last = turn.lastStep;
    const reply = last?.reply;
    // Context alone (a `!bash`, an extension note, a branch summary) asks nothing.
    if (!reply) return infer && last?.awaitsReply ? INTERRUPTED : settled;
    if (reply.ends === 'error')
      return {
        kind: 'error',
        error: { message: reply.errorMessage ?? 'Legacy run failed', code: 'UNKNOWN' },
      };
    if (reply.ends === 'aborted') return { kind: 'aborted', reason: { kind: 'legacy' } };
    if (
      infer &&
      (reply.ends === 'deferred' ||
        (last?.dangling ?? 0) > 0 ||
        (reply.hasCalls && reply.ends === 'toolUse'))
    )
      return INTERRUPTED;
    return settled;
  }

  private closeTurn(stop?: { time: number; cause: 'user_stop' | 'interjected' }): void {
    const turn = this.turn;
    if (!turn) return;
    this.closeStep();
    const reason = this.reasonFor(turn, stop?.cause) as { kind: string; reason?: { kind: string } };
    this.emit('turn/end', stop?.time ?? turn.lastTime, { turn: turn.no, reason });
    const key = reason.reason ? `${reason.kind}:${reason.reason.kind}` : reason.kind;
    this.counts.turnEnds[key] = (this.counts.turnEnds[key] ?? 0) + 1;
    this.lastTurnEnd = reason.kind;
    this.turn = null;
  }

  /** The run is over: its latest reply asked for nothing more. */
  private finished(turn: TurnState): boolean {
    const reply = this.step ? this.step.reply : turn.lastStep?.reply;
    return reply !== undefined && !reply.hasCalls;
  }

  // ---- items --------------------------------------------------------------------

  input(item: IrInput): void {
    const turn = this.turn;
    if (turn && (item.opensTurn ? turn.hasReply : this.finished(turn))) this.closeTurn();
    // A reply still waiting on results keeps its step: pi delivered this input
    // between them, and the model saw it there.
    if (this.step?.reply && this.step.pending.size === 0) this.closeStep();
    const step = this.step ?? this.openStep(item.id, item.time);
    if (item.opensTurn || item.source.kind === SEED_SOURCE_KIND.piInternal) step.awaitsReply = true;
    this.appendNode('user/message', item.time, item.id, {
      id: item.id,
      role: 'user',
      content: this.blocks(item.content),
      source: item.source,
    });
  }

  assistant(item: IrAssistant): void {
    if (!this.turn) {
      this.openTurn(item.time);
      this.counts.turnsWithoutPrompt += 1;
    }
    if (this.step?.reply) this.closeStep();
    const step = this.step ?? this.openStep(item.id, item.time);
    const turn = this.turn as TurnState;
    if (item.outcome === 'attempt') {
      this.emit('assistant/attempt', item.time, { turn: turn.no, step: step.no, stream: [] });
    } else {
      this.appendNode('assistant/message', item.time, item.id, {
        turn: turn.no,
        step: step.no,
        message: {
          id: item.id,
          role: 'assistant',
          content: this.blocks(item.content),
          source: {
            kind: 'model',
            provider: item.provider,
            model: item.model,
            ...(item.replayState !== undefined ? { replayState: item.replayState } : {}),
          },
        },
        stream: [],
        ...(item.usage ? { usage: item.usage } : {}),
        ...(item.outcome === 'interrupted' ? { interrupted: true } : {}),
      });
      for (const call of item.calls) {
        const seq = this.emit('tool/call', item.time, {
          turn: turn.no,
          step: step.no,
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        });
        step.pending.set(call.id, seq);
      }
    }
    step.reply = {
      id: item.id,
      ends: item.ends,
      hasCalls: item.outcome === 'message' && item.calls.length > 0,
      ...(item.errorMessage ? { errorMessage: item.errorMessage } : {}),
    };
    turn.hasReply = true;
    if (item.outcome === 'message' && item.ends === 'length') turn.anyLength = true;
  }

  result(item: IrResult): void {
    const step = this.step;
    const turn = this.turn;
    const callSeq = item.callId ? step?.pending.get(item.callId) : undefined;
    if (!step || !turn || callSeq === undefined) {
      this.counts.orphanResults += 1;
      this.ignorable(item.orphan);
      return;
    }
    step.pending.delete(item.callId);
    this.appendNode(
      'tool/result',
      item.time,
      item.id,
      {
        turn: turn.no,
        step: step.no,
        message: {
          id: item.id,
          role: 'tool',
          content: this.blocks(item.content),
          source: { kind: 'tool', callId: item.callId },
          toolCallId: item.callId,
          isError: item.isError,
        },
        ...(item.error && item.isError ? { error: item.error } : {}),
        ...(item.meta !== undefined ? { meta: item.meta } : {}),
      },
      { sourceEventSeqs: [callSeq] }
    );
  }

  ignorable(item: IrIgnorable): void {
    this.emit(item.type, item.time, item.data, { ignorable: true });
  }

  stop(item: { time: number; cause: 'user_stop' | 'interjected' }): void {
    if (!this.turn) {
      this.counts.strayStops += 1;
      return;
    }
    this.closeTurn(item);
  }

  /**
   * A pi compaction as DSH's replacement node (`compact-checkpoint`),
   * shadowing the surface from the first node after the system head.
   *
   * What follows it matches pi's context after the compaction:
   * - pi's retained tail is the surface from some node on (CLI, v1–v3,
   *   PI-Desktop): that node is kept with everything after it, originals
   *   rather than pi's copies;
   * - pi kept user messages only (1.0.x keeps the latest prompt, possibly
   *   truncated, and summarizes the rest of the turn): everything is
   *   shadowed and the copies pi kept are appended after the checkpoint,
   *   model-visible and off the timeline;
   * - otherwise the kept tail starts at the anchor if there is one, and pi's
   *   degradation applies if not: the summary alone.
   */
  checkpoint(item: IrCheckpoint, next: IrItem | undefined): void {
    if (this.step?.reply && this.step.pending.size === 0) this.closeStep();
    // Between runs (the run has ended and what follows starts another one),
    // DSH compacts outside any turn.
    const between =
      next === undefined ||
      next.kind === 'input' ||
      next.kind === 'checkpoint' ||
      next.kind === 'crash';
    if (this.turn && !this.step && this.finished(this.turn) && between) this.closeTurn();
    if (this.nodes.length === 0) this.openStep(item.id, item.time);
    const body = this.nodes.slice(1);
    const anchorSeq = item.anchors
      .map((id) => this.nodeOf.get(id))
      .find((seq): seq is number => seq !== undefined && body.includes(seq));
    const kept = anchorSeq === undefined ? 0 : body.length - body.indexOf(anchorSeq);
    let shadowed: number[];
    let copies: IrBlock[][] = [];
    if (item.retainedCount === 0) {
      shadowed = body;
      this.counts.summaryOnly += 1;
    } else if (anchorSeq !== undefined && kept === item.retainedCount) {
      shadowed = body.slice(0, body.indexOf(anchorSeq));
      this.counts.keptOriginals += 1;
    } else if (item.retainedUserCopies) {
      shadowed = body;
      copies = item.retainedUserCopies;
      this.counts.retainedCopies += 1;
    } else if (anchorSeq !== undefined) {
      shadowed = body.slice(0, body.indexOf(anchorSeq));
      this.counts.keptOriginals += 1;
      this.counts.compactionTailMismatch += 1;
    } else {
      shadowed = body;
      this.counts.summaryOnly += 1;
      this.counts.compactionAnchorsMissing += 1;
    }
    const message = {
      id: item.id,
      role: 'user',
      content: [
        { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
        { type: 'text', text: item.summary },
        { type: 'text', text: SUMMARY_CLOSE_TAG },
      ],
      source: { kind: SEED_SOURCE_KIND.checkpoint, compactionId: item.id },
    };
    if (shadowed.length === 0) {
      // Nothing on the surface to stand in for: the checkpoint joins the tail.
      this.counts.appended += 1;
      this.appendNode('user/message', item.time, item.id, message);
    } else {
      const seq = this.emit('user/message', item.time, message, {
        surfaceOp: {
          op: 'replace',
          startSeq: shadowed[0] as number,
          endSeq: shadowed[shadowed.length - 1] as number,
        },
        sourceEventSeqs: shadowed,
      });
      this.nodes.splice(1, shadowed.length, seq);
      this.nodeOf.set(item.id, seq);
    }
    copies.forEach((content, index) => {
      const id = `${item.id}:retained:${index}`;
      this.appendNode('user/message', item.time, id, {
        id,
        role: 'user',
        content: this.blocks(content),
        source: { kind: SEED_SOURCE_KIND.piRetained, compactionId: item.id },
      });
    });
  }

  finish(crashed: boolean): void {
    this.closeTurn();
    if (crashed && this.options.inferInterruptions && this.lastTurnEnd !== 'interrupted') {
      // The run left nothing behind but its start: an empty turn DSH itself
      // would close as `interrupted` on resume.
      const turn = this.openTurn(this.lastTime);
      this.emit('turn/end', this.lastTime, { turn: turn.no, reason: INTERRUPTED });
      this.counts.turnEnds.interrupted = (this.counts.turnEnds.interrupted ?? 0) + 1;
      this.counts.crashedRuns += 1;
      this.turn = null;
    }
  }
}

/** Build a seed from items in source order. Pure: the same items give the same events. */
export function buildSeed(items: readonly IrItem[], options: SeedBuildOptions): SeedBuild {
  const builder = new SeedBuilder(options);
  let crashed = false;
  items.forEach((item, index) => {
    switch (item.kind) {
      case 'input':
        builder.input(item);
        return;
      case 'assistant':
        builder.assistant(item);
        return;
      case 'result':
        builder.result(item);
        return;
      case 'checkpoint':
        builder.checkpoint(
          item,
          items.slice(index + 1).find((later) => later.kind !== 'ignorable')
        );
        return;
      case 'ignorable':
        builder.ignorable(item);
        return;
      case 'stop':
        builder.stop(item);
        return;
      case 'crash':
        crashed = true;
        return;
    }
  });
  builder.finish(crashed);
  return { events: builder.events, images: builder.imageTable.images, counts: builder.counts };
}
