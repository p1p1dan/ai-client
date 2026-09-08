/**
 * P2-3 — the mechanical half of a compaction: what the next context window
 * holds once the boundary is crossed. Pure by construction: no provider call,
 * no disk, no pi-agent-core state. The provider call (the summary itself) and
 * the durable record stay outside, in `index.ts` and P2-4 respectively.
 *
 * Provenance (AGENTS.md requires stating it): ported from PI-Desktop's
 * `packages/agent-runtime/src/runtime.ts` — `codexShapedPreparation`
 * (`runtime.ts:4048`), `selectRetainedUserMessages` (`:1010`),
 * `truncateUserMessageForCheckpoint` (`:991`) and the rollover summary at
 * `:509`. Their shape is Codex's `build_compacted_history_with_limit`.
 *
 * ## Why the retained tail is rebuilt instead of kept
 *
 * pi's own `prepareCompaction` hands back a `retainedTail` cut at a valid
 * boundary, and keeping it would be the obvious thing to do. Codex — and
 * PI-Desktop after it — drops that tail and rebuilds it from the latest user
 * message instead, for two reasons this port keeps:
 *
 * 1. Buying back the window is the point. A tail sized by `keepRecentTokens`
 *    carries the same content the summary just described.
 * 2. Dropping assistant messages drops their `toolCall` blocks, and their
 *    results go in the same pass. Nothing can reach a provider as an orphaned
 *    tool call, which is a request-level error rather than a quality problem.
 *
 * The messages pi split across `messagesToSummarize`, `turnPrefixMessages` and
 * `retainedTail` are contiguous and ordered, so concatenating them into one
 * summarized range loses nothing: no message leaves the context without the
 * summary covering it.
 */

import type { MessageEntry } from '@earendil-works/pi-agent-core';
import {
  type AgentMessage,
  type CompactionPreparation,
  estimateTokens,
} from '@earendil-works/pi-agent-core';
import type { UserMessage } from '@earendil-works/pi-ai';

/**
 * Stands in for the summary a rollover deliberately does not generate.
 *
 * A silent placeholder would leave the model guessing why its context changed,
 * so the rollover says so — and says the environment is untouched, because the
 * `new_context` tool description makes that promise to the model.
 */
export const CONTEXT_ROLLOVER_SUMMARY = [
  '[context rollover: a new context window was started without summarizing conversation history]',
  'Earlier messages in this session are not part of this request. The complete transcript is still available to the user, and the environment is unchanged.',
  'Ask before assuming anything about work that is not visible here.',
].join('\n\n');

export const CHECKPOINT_TRUNCATION_MARKER =
  '\n\n[... truncated for the context checkpoint ...]\n\n';

/** Whether the boundary falls inside a turn the model is still working through. */
export type RetentionMode = 'active_turn' | 'completed_turn';

/** Keep the head and a smaller tail, so both the instruction and its ending survive. */
export function truncateTextForCheckpoint(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= CHECKPOINT_TRUNCATION_MARKER.length) {
    return CHECKPOINT_TRUNCATION_MARKER.trim().slice(0, maxChars);
  }
  const retainedChars = maxChars - CHECKPOINT_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(retainedChars * 0.75);
  const tailChars = retainedChars - headChars;
  return `${text.slice(0, headChars)}${CHECKPOINT_TRUNCATION_MARKER}${
    tailChars > 0 ? text.slice(-tailChars) : ''
  }`;
}

/**
 * Flatten a user message to plain text so it can be truncated at a token
 * budget. Images and other non-text blocks are named rather than kept: a
 * checkpoint that carried them would spend its whole budget on one of them.
 */
export function userMessageTextForCheckpoint(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) =>
      block.type === 'text' ? block.text : `[${block.type} content omitted from checkpoint]`
    )
    .join('\n');
}

function truncateUserMessageForCheckpoint(message: UserMessage, tokenBudget: number): UserMessage {
  return {
    ...message,
    content: truncateTextForCheckpoint(
      userMessageTextForCheckpoint(message),
      Math.max(1, tokenBudget) * 4
    ),
  };
}

/**
 * Choose the user messages that survive the boundary: newest first up to
 * `maxTokens`, truncating the one that crosses the budget instead of dropping
 * it, then restored to chronological order.
 */
export function selectRetainedUserMessages(
  candidates: readonly UserMessage[],
  maxTokens: number
): UserMessage[] {
  const selected: UserMessage[] = [];
  let remaining = Math.max(0, maxTokens);
  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = candidates[index];
    const tokens = estimateTokens(message);
    if (tokens <= remaining) {
      selected.push(message);
      remaining -= tokens;
      continue;
    }
    selected.push(truncateUserMessageForCheckpoint(message, remaining));
    break;
  }
  return selected.reverse();
}

/**
 * Reshape pi's preparation into the one range this runtime summarizes.
 *
 * `retainedUserTokens` comes from `retainedUserMessageBudget` (P2-3), so the
 * clamp against a small window is applied here rather than being a second
 * constant.
 */
export function shapeForCheckpoint(
  preparation: CompactionPreparation,
  retainedUserTokens: number,
  retentionMode: RetentionMode
): CompactionPreparation {
  const messagesToSummarize = [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
    ...preparation.retainedTail,
  ];
  const latestUser = messagesToSummarize
    .filter((message): message is UserMessage => message.role === 'user')
    .at(-1);
  // A completed turn keeps nothing: its summary is authoritative and the next
  // prompt becomes the sole new instruction after the checkpoint.
  const candidates = retentionMode === 'active_turn' && latestUser ? [latestUser] : [];
  return {
    ...preparation,
    messagesToSummarize,
    turnPrefixMessages: [],
    isSplitTurn: false,
    retainedTail: selectRetainedUserMessages(candidates, retainedUserTokens),
  };
}

/**
 * Project in-memory messages onto the session entries `prepareCompaction`
 * walks.
 *
 * The runtime has no session store yet (P3), and compaction needs one only for
 * its *shape*: ids, ordering and a parent chain. Synthesizing them keeps the
 * cut-point logic pi already owns instead of re-deriving it here, and the ids
 * are deliberately local — nothing persists them, so they cannot be mistaken
 * for the durable entry ids P3-1 will mint.
 */
export function toMessageEntries(
  messages: readonly AgentMessage[],
  options: { idPrefix?: string; startSeq?: number; parentId?: string | null } = {}
): MessageEntry[] {
  const prefix = options.idPrefix ?? 'ctx';
  const startSeq = options.startSeq ?? 0;
  let parentId = options.parentId ?? null;
  return messages.map((message, index) => {
    const id = `${prefix}:${startSeq + index}`;
    const entry: MessageEntry = {
      type: 'message',
      id,
      seq: startSeq + index,
      parentId,
      timestamp: timestampMs(message.timestamp),
      message,
    };
    parentId = id;
    return entry;
  });
}

/** pi messages carry epoch milliseconds; tolerate an ISO string from an adapter. */
export function timestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}
