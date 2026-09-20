import type { TurnItem } from './chatTurn';

/**
 * Which block of this item's source message may still be streaming — the one
 * input `deriveToolGroupRows` needs for a live thought row.
 *
 * Its own module, and not a helper inside `MessageTimeline.tsx`, for the reason
 * every other rule in this directory has its own file: the vitest suite runs
 * `environment: node` and cannot mount that 2600-line component, so a rule
 * living inside it can only be asserted by scanning its source. This one is a
 * genuine derivation with a silent failure mode, so it gets a real test.
 *
 * ## What it is for
 *
 * `flattenTurnItems` merges adjacent `toolGroup` items across assistant-message
 * boundaries (T105): one continuous run of tool calls is cut wherever the Host
 * opened a new assistant message, which is every tool result. A merged item
 * records every contributing message in `messageIds`.
 *
 * The timeline resolves the streaming block PER MESSAGE
 * (`deriveStreamingBlockIds` keys its map by message id), so reading only
 * `item.messageId` — which a merge sets to the FIRST message — finds no
 * streaming block for a thought arriving in any later one. The live "thinking"
 * row would then stop growing mid-stream. No error, nothing red: exactly the
 * failure that survives a full test run.
 *
 * First non-null in message order wins, because at most one block can be the
 * one still streaming, and the merge preserved the contributing order.
 */
export function streamingBlockIdForItem(
  item: TurnItem,
  byMessage: ReadonlyMap<string, string | null>
): string | null {
  const ids = item.kind === 'toolGroup' && item.messageIds ? item.messageIds : [item.messageId];
  for (const id of ids) {
    const streaming = byMessage.get(id);
    if (streaming) return streaming;
  }
  return null;
}
