import { describe, expect, it } from 'vitest';
import type { TurnItem } from '../chatTurn';
import { streamingBlockIdForItem } from '../streamingBlockId';

/**
 * The `messageIds` wiring, at the layer that can actually be exercised.
 *
 * `MessageTimeline.tsx` cannot be mounted under this suite (node environment),
 * so this rule lives in its own module and is tested here rather than being
 * pinned by a source scan — which would only prove the call exists, not that it
 * resolves the right message.
 */

function toolGroup(messageId: string, messageIds?: readonly string[]): TurnItem {
  return {
    kind: 'toolGroup',
    blockIndex: 0,
    messageId,
    entries: [],
    ...(messageIds ? { messageIds } : {}),
  };
}

describe('streamingBlockIdForItem (T105)', () => {
  it('reads the single message of an unmerged group', () => {
    expect(streamingBlockIdForItem(toolGroup('m1'), new Map([['m1', 'block-a']]))).toBe('block-a');
  });

  it('is null when that message has nothing streaming', () => {
    expect(streamingBlockIdForItem(toolGroup('m1'), new Map([['m1', null]]))).toBeNull();
    expect(streamingBlockIdForItem(toolGroup('m1'), new Map())).toBeNull();
  });

  /**
   * The defect this module exists for. A merged group's `messageId` is the
   * FIRST message; the live thought can be arriving in any of the later ones.
   * Reading only `messageId` here returns null and the "thinking" row silently
   * stops growing — no error, nothing red, and no other assertion in the suite
   * notices.
   */
  it('finds a streaming block on a LATER message of a merged group', () => {
    const map = new Map([
      ['m1', null],
      ['m2', 'block-live'],
    ]);
    expect(streamingBlockIdForItem(toolGroup('m1', ['m1', 'm2']), map)).toBe('block-live');
  });

  it('takes the first non-null in message order, across three messages', () => {
    const map = new Map([
      ['m1', null],
      ['m2', null],
      ['m3', 'block-tail'],
    ]);
    expect(streamingBlockIdForItem(toolGroup('m1', ['m1', 'm2', 'm3']), map)).toBe('block-tail');
  });

  it('an absent `messageIds` is not confused with an empty one', () => {
    // An empty array would make the loop vacuous and silently return null, so
    // the field is only ever set by the merge, which always has >= 2 ids.
    const map = new Map([['m1', 'block-a']]);
    expect(streamingBlockIdForItem(toolGroup('m1', []), map)).toBeNull();
    expect(streamingBlockIdForItem(toolGroup('m1'), map)).toBe('block-a');
  });

  it('works for a non-group item too — it just reads its own message', () => {
    const text: TurnItem = {
      kind: 'text',
      block: { id: 't1', type: 'text', text: 'hi' },
      blockIndex: 0,
      messageId: 'm1',
    };
    expect(streamingBlockIdForItem(text, new Map([['m1', 't1']]))).toBe('t1');
  });
});
