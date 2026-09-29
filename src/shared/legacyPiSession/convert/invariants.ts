// New in dsh-rebase P1-9b

/**
 * The seed checker (plan P1-9 shard 03 §1: the product host loads no
 * `dsh-invariants`, so the converter brings its own).
 *
 * Three layers, each rule named in the violation:
 * - `seed/…`: what `dsh-session`'s constructor checks before it accepts a
 *   seed (envelope, lossless JSON, seq from 0, surface markers and
 *   replacements, message shapes, settlement fields; 0.1.7-rc.2
 *   `lib/index.js` `assertSessionEventEnvelope`, `planSurfaceEvent`,
 *   `assertMessageEventShape`);
 * - `invariant/…`: `dsh-session/invariant`'s relational checks, transcribed
 *   (turn and step nesting and numbering, calls answered in their step);
 * - `read/…`: what DSH's reader checks when the log is opened again and the
 *   constructor lets through (`dsh-session-persistence-jsonl` format
 *   validation): a checkpoint that replaces surface nodes sits in a
 *   `compaction/start` → `compaction/summary` → checkpoint → `compaction/end`
 *   transaction of one id and one owner, the summary names the exact surface
 *   span the checkpoint shadows and comes right before it, and no turn
 *   boundary falls inside the transaction (P1-9c experiment E1);
 * - `shape/…`: what this converter promises beyond both — loop-shaped turns
 *   all closed, node 0 the empty system head, every call answered and cited,
 *   calls matching their reply's blocks, message ids unique, ignorable
 *   events only of our own `aiclient/*` kind, and, once bound, no image
 *   still pending.
 */

import { type DshSeedEvent, SYSTEM_PROMPT_SOURCE_KIND } from './types.ts';

export interface SeedViolation {
  seq: number;
  rule: string;
  message: string;
}

export interface SeedCheckOptions {
  /** `bound`: every image block must carry an admitted reference, as `agents.create` needs. */
  images?: 'pending' | 'bound';
}

/** The event types a seed may hold: the loop's own, and ignorable `aiclient/*` records. */
const CORE_TYPES: ReadonlySet<string> = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'system/message',
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
]);
const SURFACE_TYPES: ReadonlySet<string> = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);
const ROLE_BY_TYPE: Record<string, string> = {
  'system/message': 'system',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
};
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'type',
  'seq',
  'time',
  'data',
  'surfaceOp',
  'sourceEventSeqs',
  'ignorable',
]);
const TURN_END_KINDS: ReadonlySet<string> = new Set([
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
  'forked',
]);

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function isSeq(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Where `value` stops being lossless JSON (`snapshotJsonValue`'s rule), or undefined. */
export function jsonFault(value: unknown, path = 'data'): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number')
    return Number.isFinite(value) && !Object.is(value, -0) ? undefined : `${path} is not finite`;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return `${path}[${index}] is a hole`;
      const fault = jsonFault(value[index], `${path}[${index}]`);
      if (fault) return fault;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      return `${path} is not a plain object`;
    for (const [key, item] of Object.entries(value)) {
      const fault = jsonFault(item, `${path}.${key}`);
      if (fault) return fault;
    }
    return undefined;
  }
  return `${path} is ${typeof value}`;
}

function messageOf(event: DshSeedEvent): Row | undefined {
  const data = recordOf(event.data);
  return event.type === 'user/message' ? data : recordOf(data?.message);
}

/** The surface, folded the way `dsh-session` folds it; also the model-visible order. */
export class SeedSurface {
  readonly nodes: number[] = [];

  /** Apply one event; a fault is returned, never thrown. */
  apply(event: DshSeedEvent, known: readonly DshSeedEvent[]): string | undefined {
    if (!SURFACE_TYPES.has(event.type)) return undefined;
    const op = event.surfaceOp;
    if (op === 'append') {
      this.nodes.push(event.seq);
      return undefined;
    }
    if (!op || typeof op !== 'object') return 'invalid surfaceOp';
    const start = this.nodes.indexOf(op.startSeq);
    const end = this.nodes.indexOf(op.endSeq);
    if (start < 0 || end < 0)
      return `replace range ${op.startSeq}..${op.endSeq} is not on the surface`;
    if (start > end) return `replace range ${op.startSeq}..${op.endSeq} runs backwards`;
    const shadowed = this.nodes.slice(start, end + 1);
    const cited = new Set(event.sourceEventSeqs ?? []);
    const missing = shadowed.filter((seq) => !cited.has(seq));
    if (missing.length > 0) return `sourceEventSeqs miss shadowed nodes ${missing.join(', ')}`;
    if (
      start === 0 &&
      known[this.nodes[0] as number]?.type === 'system/message' &&
      (event.type !== 'system/message' || shadowed.length !== 1)
    )
      return 'node 0 holds the system prompt; only a system/message may replace it';
    if (event.type === 'tool/result') return 'tool/result replacements are not produced by seeds';
    this.nodes.splice(start, end - start + 1, event.seq);
    return undefined;
  }
}

/** The model-visible surface of a valid seed, as event seqs in order. */
export function seedSurface(events: readonly DshSeedEvent[]): number[] {
  const surface = new SeedSurface();
  for (const event of events) surface.apply(event, events);
  return surface.nodes;
}

function checkEnvelope(
  event: DshSeedEvent,
  index: number,
  fail: (rule: string, message: string) => void
) {
  for (const key of Object.keys(event))
    if (!ENVELOPE_KEYS.has(key)) fail('seed/envelope', `unexpected envelope key "${key}"`);
  if (typeof event.type !== 'string' || !event.type) fail('seed/envelope', 'type must be a string');
  if (event.seq !== index) fail('seed/seq', `seq ${String(event.seq)} at index ${index}`);
  if (typeof event.time !== 'number' || !Number.isSafeInteger(event.time))
    fail('seed/envelope', 'time must be a safe integer');
  if (event.data === undefined) fail('seed/envelope', 'data is missing');
  if (event.ignorable !== undefined && event.ignorable !== true)
    fail('seed/envelope', 'ignorable may only be true');
  const fault = jsonFault(event.data) ?? jsonFault(event.surfaceOp ?? null, 'surfaceOp');
  if (fault) fail('seed/json', fault);
}

function checkSurfaceMarkers(event: DshSeedEvent, fail: (rule: string, message: string) => void) {
  const known = CORE_TYPES.has(event.type);
  if (!SURFACE_TYPES.has(event.type)) {
    if (!known && event.ignorable === true) return;
    if (event.surfaceOp !== undefined) fail('seed/surface', `${event.type} cannot carry surfaceOp`);
    if (event.sourceEventSeqs !== undefined)
      fail('seed/surface', `${event.type} cannot carry sourceEventSeqs`);
    return;
  }
  const op = event.surfaceOp;
  if (op === undefined) fail('seed/surface', `${event.type} requires surfaceOp`);
  else if (op !== 'append') {
    const replace = recordOf(op);
    if (
      !replace ||
      Object.keys(replace).length !== 3 ||
      replace.op !== 'replace' ||
      !isSeq(replace.startSeq) ||
      !isSeq(replace.endSeq)
    )
      fail('seed/surface', 'invalid replace surfaceOp');
    else if (replace.startSeq >= event.seq || replace.endSeq >= event.seq)
      fail('seed/surface', 'replace must reference earlier events');
  }
  const cited = event.sourceEventSeqs;
  if (cited === undefined) return;
  if (event.type === 'assistant/message')
    fail('seed/surface', 'assistant/message cannot cite sources');
  if (!Array.isArray(cited) || cited.length === 0)
    fail('seed/surface', 'sourceEventSeqs must be a non-empty array');
  else {
    if (!cited.every(isSeq)) fail('seed/surface', 'sourceEventSeqs must be seqs');
    if (new Set(cited).size !== cited.length)
      fail('seed/surface', 'sourceEventSeqs has duplicates');
    if (cited.some((seq) => seq >= event.seq))
      fail('seed/surface', 'sourceEventSeqs must be earlier');
  }
}

function checkMessage(event: DshSeedEvent, fail: (rule: string, message: string) => void) {
  const role = ROLE_BY_TYPE[event.type];
  if (!role) return;
  const message = messageOf(event);
  if (!message || !nonEmpty(message.id)) {
    fail('seed/message', 'message lacks an id');
    return;
  }
  if (message.role !== role) fail('seed/message', `message must have role "${role}"`);
  const source = recordOf(message.source);
  if (!source || !nonEmpty(source.kind)) fail('seed/message', 'message has invalid source');
  if (!Array.isArray(message.content)) fail('seed/message', 'message has invalid content');
  if (event.type === 'system/message' && source?.kind !== SYSTEM_PROMPT_SOURCE_KIND)
    fail('seed/message', 'system/message needs a system-prompt source');
  if (
    event.type === 'assistant/message' &&
    (source?.kind !== 'model' || !nonEmpty(source.provider) || !nonEmpty(source.model))
  )
    fail('seed/message', 'assistant/message needs a model source with provider and model');
  if (event.type === 'tool/result') {
    if (source?.kind !== 'tool' || !nonEmpty(source.callId))
      fail('seed/message', 'tool/result needs a tool source');
    else if (message.toolCallId !== source.callId)
      fail('seed/message', 'tool/result has mismatched call ids');
    const data = recordOf(event.data);
    if (data?.error !== undefined && message.isError !== true)
      fail('seed/message', 'tool/result error requires isError');
  }
}

function checkSettlement(event: DshSeedEvent, fail: (rule: string, message: string) => void) {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return;
  const data = recordOf(event.data);
  if (!isSeq(data?.turn) || !isSeq(data?.step) || !Array.isArray(data?.stream))
    fail('seed/settlement', `${event.type} has invalid settlement fields`);
  if (data?.interrupted !== undefined && data.interrupted !== true)
    fail('seed/settlement', 'interrupted may only be true');
}

function imageFaults(content: unknown, images: 'pending' | 'bound'): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const row = recordOf(block);
    if (row?.type !== 'image') continue;
    const attachment = recordOf(row.attachment);
    if (!attachment) return 'image block without attachment';
    const pending = typeof attachment.pendingImage === 'string';
    if (images === 'bound' && pending) return 'image still pending admission';
    if (!pending && !nonEmpty(attachment.attachmentId)) return 'image without attachment id';
  }
  return undefined;
}

/** The open compaction transaction, as DSH's reader tracks it. */
interface OpenCompaction {
  id: string;
  turn: number | null;
  startSeq: number;
  summary?: { seq: number; start: number; end: number };
  checkpointed: boolean;
}

function isReplacingCheckpoint(event: DshSeedEvent): boolean {
  return (
    event.type === 'user/message' &&
    recordOf(event.surfaceOp) !== undefined &&
    recordOf(recordOf(event.data)?.source)?.kind === 'compact-checkpoint'
  );
}

/**
 * The `read/compaction` rule for one event. `surface` is the surface before
 * the event applies; `openTurn` the turn open before it. Returns the
 * transaction as it stands after the event.
 */
function checkCompaction(
  event: DshSeedEvent,
  next: DshSeedEvent | undefined,
  open: OpenCompaction | null,
  surface: readonly number[],
  openTurn: number | null,
  fail: (rule: string, message: string) => void
): OpenCompaction | null {
  const bad = (message: string) => fail('read/compaction', message);
  const data = recordOf(event.data) ?? {};
  if ((event.type === 'turn/start' || event.type === 'turn/end') && open)
    bad(`${event.type} crosses compaction ${open.id}`);
  switch (event.type) {
    case 'compaction/start': {
      if (open) bad(`compaction/start while ${open.id} is open`);
      if (!nonEmpty(data.compactionId)) bad('compaction/start needs a compactionId');
      if (data.turn !== openTurn)
        bad(`compaction/start owner ${String(data.turn)} is not the open turn ${String(openTurn)}`);
      return {
        id: String(data.compactionId),
        turn: openTurn,
        startSeq: event.seq,
        checkpointed: false,
      };
    }
    case 'compaction/summary': {
      if (!open || open.id !== data.compactionId) {
        bad('compaction/summary has no matching compaction/start');
        return open;
      }
      if (open.summary) bad('compaction/summary repeats');
      const range = recordOf(data.shadowedRange);
      const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [];
      const from = surface.indexOf(Number(range?.start));
      const to = surface.indexOf(Number(range?.end));
      const span = from < 0 || to < from ? [] : surface.slice(from, to + 1);
      if (
        seqs.length === 0 ||
        span.length !== seqs.length ||
        span.some((seq, index) => seq !== seqs[index])
      )
        bad('compaction/summary shadowedSeqs do not name an exact current surface span');
      if (surface.length > 0 && seqs.includes(surface[0]))
        bad('compaction/summary shadows the system head');
      if (!Array.isArray(data.summary)) bad('compaction/summary needs summary blocks');
      if (!isSeq(data.shadowedTokenCount))
        bad('compaction/summary needs a non-negative shadowedTokenCount');
      if (!nonEmpty(data.provider) || !nonEmpty(data.model))
        bad('compaction/summary needs provider and model');
      const checkpoint = next && isReplacingCheckpoint(next) ? recordOf(next.surfaceOp) : undefined;
      if (checkpoint?.startSeq !== range?.start || checkpoint?.endSeq !== range?.end)
        bad('compaction/summary must come right before the checkpoint replacing its span');
      return {
        ...open,
        summary: { seq: event.seq, start: Number(range?.start), end: Number(range?.end) },
      };
    }
    case 'compaction/end':
      if (!open || open.id !== data.compactionId) {
        bad('compaction/end has no matching compaction/start');
        return open;
      }
      if (data.turn !== open.turn) bad('compaction/end changes its owner turn');
      if (!open.checkpointed) bad('compaction/end before its checkpoint');
      return null;
    default:
      break;
  }
  if (!isReplacingCheckpoint(event)) return open;
  const source = recordOf(recordOf(event.data)?.source);
  if (!open || open.id !== source?.compactionId || !open.summary) {
    bad('compaction checkpoint has no matching compaction/start and summary');
    return open;
  }
  if (open.checkpointed) bad(`compaction ${open.id} replaces twice`);
  const cited = event.sourceEventSeqs ?? [];
  if (cited[0] !== open.startSeq || cited[1] !== open.summary.seq)
    bad('compaction checkpoint must cite its compaction/start and compaction/summary first');
  return { ...open, checkpointed: true };
}

/** Every rule the seed breaks; empty when `agents.create` should accept it. */
export function checkSeed(
  events: readonly DshSeedEvent[],
  options: SeedCheckOptions = {}
): SeedViolation[] {
  const violations: SeedViolation[] = [];
  const surface = new SeedSurface();
  const messageIds = new Set<string>();
  let openTurn: number | null = null;
  let openStep: number | null = null;
  let nextTurn = 1;
  let nextStep = 1;
  /** Calls of the open step: id → seq of its `tool/call`. */
  const pending = new Map<string, number>();
  /** Tool-call blocks of the open step's reply, still waiting for their `tool/call`. */
  let expectedCalls: { id: string; name: string; arguments: string }[] = [];
  let systemMessages = 0;
  let surfaceEvents = 0;
  let compaction: OpenCompaction | null = null;

  events.forEach((event, index) => {
    const seq = typeof event?.seq === 'number' ? event.seq : index;
    const fail = (rule: string, message: string) => violations.push({ seq, rule, message });
    if (!recordOf(event)) {
      fail('seed/envelope', 'event is not an object');
      return;
    }
    checkEnvelope(event, index, fail);
    const known = CORE_TYPES.has(event.type);
    if (event.type === 'session/end-seed')
      fail('shape/end-seed', 'the constructor appends session/end-seed');
    else if (!known && event.ignorable !== true)
      fail('seed/type', `unknown required event ${event.type}`);
    if (event.ignorable === true && !(event.type.startsWith('aiclient/') && !known))
      fail('shape/ignorable', `only aiclient/* records are ignorable, not ${event.type}`);
    if (event.type.startsWith('aiclient/') && event.ignorable !== true)
      fail('shape/ignorable', `${event.type} must be ignorable`);
    checkSurfaceMarkers(event, fail);
    checkMessage(event, fail);
    checkSettlement(event, fail);

    const message = messageOf(event);
    if (ROLE_BY_TYPE[event.type] && nonEmpty(message?.id)) {
      if (messageIds.has(message.id)) fail('shape/message-id', `message id ${message.id} repeats`);
      messageIds.add(message.id);
      const fault = imageFaults(message.content, options.images ?? 'pending');
      if (fault) fail('shape/image', fault);
    }

    compaction = checkCompaction(
      event,
      events[index + 1],
      compaction,
      surface.nodes,
      openTurn,
      fail
    );
    const surfaceFault = surface.apply(event, events);
    if (surfaceFault) fail('seed/surface-replace', surfaceFault);
    if (event.type === 'system/message') {
      systemMessages += 1;
      if (
        surface.nodes[0] !== event.seq ||
        !Array.isArray(message?.content) ||
        message.content.length > 0
      )
        fail('shape/system-head', 'the only system/message is the empty surface node 0');
    } else if (SURFACE_TYPES.has(event.type) && systemMessages === 0) {
      fail('shape/system-head', `${event.type} before the system head`);
    }
    if (SURFACE_TYPES.has(event.type)) surfaceEvents += 1;

    const data = recordOf(event.data) ?? {};
    const turn = data.turn;
    const step = data.step;
    const inStep = (kind: string) => {
      if (openTurn !== turn || openStep !== step)
        fail(
          'invariant/step',
          `${kind} names turn ${String(turn)}/step ${String(step)} but open is ${String(openTurn)}/${String(openStep)}`
        );
    };
    switch (event.type) {
      case 'turn/start':
        if (openTurn !== null) fail('invariant/turn', `turn/start while turn ${openTurn} is open`);
        if (turn !== nextTurn) fail('invariant/turn', `turn/start expected turn ${nextTurn}`);
        openTurn = typeof turn === 'number' ? turn : null;
        nextStep = 1;
        break;
      case 'turn/end': {
        if (openTurn !== turn)
          fail('invariant/turn', `turn/end ${String(turn)} does not match ${String(openTurn)}`);
        if (openStep !== null) fail('invariant/turn', `turn/end while step ${openStep} is open`);
        const reason = recordOf(data.reason);
        if (!reason || !TURN_END_KINDS.has(String(reason.kind)))
          fail('shape/turn-end', 'turn/end needs a known reason');
        openTurn = null;
        nextTurn += 1;
        break;
      }
      case 'step/start':
        if (openTurn !== turn)
          fail(
            'invariant/step',
            `step/start in turn ${String(turn)} but open is ${String(openTurn)}`
          );
        if (openStep !== null) fail('invariant/step', `step/start while step ${openStep} is open`);
        if (step !== nextStep) fail('invariant/step', `step/start expected step ${nextStep}`);
        openStep = typeof step === 'number' ? step : null;
        expectedCalls = [];
        break;
      case 'step/end':
        inStep('step/end');
        for (const callId of pending.keys())
          fail('shape/tool-pairing', `call ${callId} left without a result`);
        if (expectedCalls.length > 0)
          fail(
            'shape/tool-pairing',
            `reply calls ${expectedCalls.map((call) => call.id).join(', ')} never recorded`
          );
        pending.clear();
        expectedCalls = [];
        openStep = null;
        nextStep += 1;
        break;
      case 'system/message':
      case 'assistant/attempt':
        inStep(event.type);
        break;
      case 'assistant/message': {
        inStep(event.type);
        if (expectedCalls.length > 0 || pending.size > 0)
          fail('shape/step', 'a step holds one reply');
        const content = Array.isArray(message?.content) ? message.content : [];
        expectedCalls = content.flatMap((block) => {
          const row = recordOf(block);
          return row?.type === 'tool-call'
            ? [{ id: String(row.id), name: String(row.name), arguments: String(row.arguments) }]
            : [];
        });
        if (data.interrupted === true && expectedCalls.length > 0)
          fail('shape/interrupted', 'an interrupted reply keeps no tool calls');
        break;
      }
      case 'tool/call': {
        inStep('tool/call');
        const expected = expectedCalls.shift();
        if (
          !expected ||
          expected.id !== data.callId ||
          expected.name !== data.name ||
          expected.arguments !== data.arguments
        )
          fail('shape/tool-pairing', `tool/call ${String(data.callId)} does not match its reply`);
        if (!nonEmpty(data.callId)) fail('invariant/tool', 'tool/call needs a call id');
        else if (pending.has(data.callId))
          fail('shape/tool-pairing', `call ${data.callId} repeats in its step`);
        else pending.set(data.callId, event.seq);
        break;
      }
      case 'tool/result': {
        inStep('tool/result');
        const callId = String(recordOf(message?.source)?.callId);
        const callSeq = pending.get(callId);
        if (callSeq === undefined)
          fail('invariant/tool', `tool/result for ${callId} with no prior tool/call in this step`);
        else if (event.sourceEventSeqs?.length !== 1 || event.sourceEventSeqs[0] !== callSeq)
          fail('shape/tool-pairing', `tool/result for ${callId} must cite its tool/call`);
        pending.delete(callId);
        break;
      }
      default:
        break;
    }
  });
  const last = events.length - 1;
  if (openStep !== null)
    violations.push({ seq: last, rule: 'shape/balanced', message: `step ${openStep} left open` });
  if (openTurn !== null)
    violations.push({ seq: last, rule: 'shape/balanced', message: `turn ${openTurn} left open` });
  if (compaction !== null)
    violations.push({
      seq: last,
      rule: 'read/compaction',
      message: `compaction ${(compaction as OpenCompaction).id} left open`,
    });
  if (surfaceEvents > 0 && systemMessages !== 1)
    violations.push({
      seq: last,
      rule: 'shape/system-head',
      message: `${systemMessages} system messages`,
    });
  return violations;
}
