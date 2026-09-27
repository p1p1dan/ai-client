// New in dsh-rebase P1-9b

/**
 * A pi-ai assistant message, as the DSH `assistant/message` the pi-ai adapter
 * would have written for it (plan P1-9 shard 02 §1, shard 03 §3).
 *
 * - Blocks: `text` → `text`, `thinking` → `reasoning`, `toolCall` →
 *   `tool-call` with the arguments as a JSON string. Anything else (an
 *   assistant image, a block of unknown type) is dropped, as the adapter
 *   would refuse it.
 * - `replayState` is computed the way `dsh-llm-pi-ai`'s `toPiReplayState`
 *   computes it from the same pi-ai message, so signatures, `responseId` and
 *   the thinking level replay natively. When the blocks no longer line up one
 *   to one, it is left out and the adapter replays the message as foreign
 *   history, which it does without failing.
 * - `usage` follows the adapter's `mapUsage`; pi's `cost` is dropped.
 * - Decision 055: an `aborted` reply with visible text becomes an
 *   `interrupted` message holding only its non-blank text and reasoning, as
 *   DSH records its own Stop (`BlockAssembler.interruptedBlocks`), without
 *   `replayState` (a cut stream has no finish record, and pi never sent the
 *   partial signatures); `error`, `deferred` and a text-less `aborted` become
 *   attempts that never reach the model.
 */

import type { AssistantMessage } from '../types.ts';
import type {
  IrAssistant,
  IrAssistantEnd,
  IrBlock,
  IrToolCall,
  SeedJson,
  SeedTokenUsage,
} from './types.ts';

/** The provider the 1.0.x import writer (and a direct import) names; its turns cost this app nothing. */
export const LEGACY_IMPORT_PROVIDER = 'legacy-import';

const ENDS: ReadonlySet<string> = new Set([
  'stop',
  'length',
  'toolUse',
  'error',
  'aborted',
  'deferred',
]);
/** Stop reasons `dsh-llm-pi-ai`'s `readReplayState` accepts. */
const REPLAY_STOP_REASONS: ReadonlySet<string> = new Set([
  'stop',
  'length',
  'toolUse',
  'error',
  'aborted',
]);

export interface AssistantCounts {
  droppedBlocks: number;
  strippedToolCalls: number;
  errorReplyBodies: number;
  interruptedReplies: number;
  replayStateOmitted: number;
}

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** JSON text of a call's arguments; a string is kept as the model wrote it. */
export function toolArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {}) ?? '{}';
  } catch {
    return '{}';
  }
}

/** `dsh-llm-pi-ai`'s `mapUsage`; undefined when pi recorded no usable counts. */
export function mapUsage(value: unknown): SeedTokenUsage | undefined {
  const usage = recordOf(value);
  const input = finite(usage?.input);
  const output = finite(usage?.output);
  if (input === undefined || output === undefined) return undefined;
  const total = finite(usage?.totalTokens);
  const cacheRead = finite(usage?.cacheRead) ?? 0;
  const cacheWrite = finite(usage?.cacheWrite) ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function isBody(block: IrBlock): boolean {
  return (block.type === 'text' || block.type === 'reasoning') && block.text.trim() !== '';
}

/**
 * Map one pi assistant message. `id` is its entry id (decision 054), used to
 * name a call the provider left without an id the way the pi projection does.
 */
export function piAssistant(
  message: AssistantMessage,
  id: string,
  time: number,
  counts: AssistantCounts
): IrAssistant {
  const stop = typeof message.stopReason === 'string' ? message.stopReason : '';
  const ends: IrAssistantEnd = ENDS.has(stop) ? (stop as IrAssistantEnd) : 'other';
  const provider = nonEmpty(message.provider);
  const model = nonEmpty(message.model);
  const imported = provider === LEGACY_IMPORT_PROVIDER;

  const content: IrBlock[] = [];
  const replay: { [key: string]: SeedJson }[] = [];
  const calls: IrToolCall[] = [];
  let aligned = true;
  const parts: unknown[] = Array.isArray(message.content) ? message.content : [];
  parts.forEach((part, index) => {
    const block = recordOf(part);
    if (block?.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text });
      replay.push({
        type: 'text',
        ...(typeof block.textSignature === 'string' ? { textSignature: block.textSignature } : {}),
      });
      return;
    }
    if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      content.push({ type: 'reasoning', text: block.thinking });
      replay.push({
        type: 'reasoning',
        ...(typeof block.thinkingSignature === 'string'
          ? { thinkingSignature: block.thinkingSignature }
          : {}),
        ...(typeof block.redacted === 'boolean' ? { redacted: block.redacted } : {}),
      });
      return;
    }
    if (block?.type === 'toolCall') {
      // Same fallbacks as `projectPiSessionHistory`, so the call keeps its row id.
      const call: IrToolCall = {
        id: nonEmpty(block.id) ?? `${id}-${index}`,
        name: nonEmpty(block.name) ?? 'tool',
        arguments: toolArguments(block.arguments),
      };
      content.push({ type: 'tool-call', ...call });
      calls.push(call);
      replay.push({
        type: 'tool-call',
        ...(typeof block.thoughtSignature === 'string'
          ? { thoughtSignature: block.thoughtSignature }
          : {}),
      });
      return;
    }
    aligned = false;
    counts.droppedBlocks += 1;
  });

  const base = {
    kind: 'assistant' as const,
    id,
    time,
    ends,
    provider: provider ?? 'legacy',
    model: model ?? 'legacy',
    ...(typeof message.errorMessage === 'string' && message.errorMessage
      ? { errorMessage: message.errorMessage }
      : {}),
  };
  const usage = imported ? undefined : mapUsage(message.usage);

  if (ends === 'error' || ends === 'deferred') {
    if (ends === 'error' && content.some(isBody)) counts.errorReplyBodies += 1;
    counts.strippedToolCalls += calls.length;
    return { ...base, outcome: 'attempt', content: [], calls: [] };
  }
  if (ends === 'aborted') {
    counts.strippedToolCalls += calls.length;
    const kept = content.filter(isBody);
    if (kept.length === 0) return { ...base, outcome: 'attempt', content: [], calls: [] };
    counts.interruptedReplies += 1;
    return {
      ...base,
      outcome: 'interrupted',
      content: kept,
      calls: [],
      ...(usage ? { usage } : {}),
    };
  }

  const api = nonEmpty(message.api);
  const replayable =
    !imported &&
    aligned &&
    api !== undefined &&
    provider !== undefined &&
    model !== undefined &&
    REPLAY_STOP_REASONS.has(stop);
  if (!replayable && !imported) counts.replayStateOmitted += 1;
  const raw = message as unknown as Row;
  const replayState: SeedJson | undefined = replayable
    ? {
        response: {
          kind: 'pi-ai',
          version: 2,
          api,
          provider,
          model,
          ...(typeof raw.responseModel === 'string' ? { responseModel: raw.responseModel } : {}),
          ...(typeof message.responseId === 'string' ? { responseId: message.responseId } : {}),
          ...(typeof raw.providerThinkingLevel === 'string'
            ? { providerThinkingLevel: raw.providerThinkingLevel }
            : {}),
          stopReason: stop,
        },
        blocks: replay,
      }
    : undefined;
  return {
    ...base,
    outcome: 'message',
    content,
    calls,
    ...(replayState !== undefined ? { replayState } : {}),
    ...(usage ? { usage } : {}),
  };
}
