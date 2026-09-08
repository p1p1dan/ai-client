/**
 * P2-7 gate.
 *
 * The metric's whole value is that it distinguishes causes a single hit-rate
 * number cannot, so the tests are written around the failures it must be able
 * to tell apart: an append (healthy), a changed system prompt (poisons
 * everything), a reordered but otherwise identical set of blocks (the failure
 * `plugins/prompt/segments.ts`'s fixed slot order exists to prevent), and an
 * edited message in the middle.
 */

import { describe, expect, it } from 'vitest';
import {
  comparePrefix,
  type PrefixBlockInput,
  prefixTraceDetail,
  snapshotPrefix,
} from '../plugins/context/prefixStability.ts';

const system = (text: string): PrefixBlockInput => ({ kind: 'system', content: text });
const message = (label: string, text = label): PrefixBlockInput => ({
  kind: 'message',
  label,
  content: text,
});

const TURN_ONE = [system('you are an agent'), message('u1'), message('a1')];

describe('snapshotPrefix', () => {
  it('records sizes and digests without keeping the content', () => {
    const snapshot = snapshotPrefix([system('abc')]);
    expect(snapshot.totalBytes).toBe(3);
    expect(JSON.stringify(snapshot)).not.toContain('abc');
  });

  it('counts bytes, not characters', () => {
    expect(snapshotPrefix([message('m', '中文')]).totalBytes).toBe(6);
  });

  it('separates blocks that serialize identically but are different kinds', () => {
    const [a] = snapshotPrefix([system('same')]).blocks;
    const [b] = snapshotPrefix([message('m', 'same')]).blocks;
    expect(a?.digest).not.toBe(b?.digest);
  });

  it('ignores the label, because a regenerated id is still the same bytes', () => {
    const [a] = snapshotPrefix([message('id-1', 'body')]).blocks;
    const [b] = snapshotPrefix([message('id-2', 'body')]).blocks;
    expect(a?.digest).toBe(b?.digest);
  });
});

describe('comparePrefix', () => {
  it('reports nothing reusable on the first turn', () => {
    expect(comparePrefix(snapshotPrefix(TURN_ONE))).toEqual({
      commonBlocks: 0,
      commonBytes: 0,
      nextBlocks: TURN_ONE.length,
      previousBlocks: 0,
      sharedPrefixRatio: 0,
    });
  });

  it('treats an append as a fully preserved prefix', () => {
    const previous = snapshotPrefix(TURN_ONE);
    const next = snapshotPrefix([...TURN_ONE, message('u2'), message('a2')]);
    const comparison = comparePrefix(next, previous);
    expect(comparison.commonBlocks).toBe(TURN_ONE.length);
    expect(comparison.commonBytes).toBe(previous.totalBytes);
    // An append is the healthy shape: nothing conflicts, the request just grew.
    expect(comparison.divergedAt).toBeUndefined();
    expect(comparison.nextBlocks).toBe(TURN_ONE.length + 2);
    expect(comparison.previousBlocks).toBe(TURN_ONE.length);
    expect(comparison.sharedPrefixRatio).toBeLessThan(1);
  });

  it('blames the system prompt when it changes, not the messages after it', () => {
    const comparison = comparePrefix(
      snapshotPrefix([system('you are an agent\n\nbudget warning'), message('u1'), message('a1')]),
      snapshotPrefix(TURN_ONE)
    );
    expect(comparison.commonBlocks).toBe(0);
    expect(comparison.sharedPrefixRatio).toBe(0);
    expect(comparison.divergedAt).toMatchObject({ index: 0, kind: 'system' });
  });

  it('catches a reorder even though every block is unchanged', () => {
    const comparison = comparePrefix(
      snapshotPrefix([TURN_ONE[0]!, TURN_ONE[2]!, TURN_ONE[1]!]),
      snapshotPrefix(TURN_ONE)
    );
    expect(comparison.commonBlocks).toBe(1);
    expect(comparison.divergedAt).toMatchObject({ index: 1, label: 'a1', previousLabel: 'u1' });
  });

  it('points at the edited message in the middle', () => {
    const comparison = comparePrefix(
      snapshotPrefix([TURN_ONE[0]!, message('u1', 'edited'), TURN_ONE[2]!]),
      snapshotPrefix(TURN_ONE)
    );
    expect(comparison.commonBlocks).toBe(1);
    expect(comparison.divergedAt).toMatchObject({
      index: 1,
      kind: 'message',
      label: 'u1',
      previousLabel: 'u1',
    });
  });

  it('treats a shrink as fully reusable and shows it in the block counts', () => {
    // Compaction and rewind both shorten the request. Everything still sent is
    // reusable, so this must not read as a divergence.
    const comparison = comparePrefix(snapshotPrefix([TURN_ONE[0]!]), snapshotPrefix(TURN_ONE));
    expect(comparison.commonBlocks).toBe(1);
    expect(comparison.sharedPrefixRatio).toBe(1);
    expect(comparison.divergedAt).toBeUndefined();
    expect(comparison.nextBlocks).toBe(1);
    expect(comparison.previousBlocks).toBe(TURN_ONE.length);
  });

  it('does not call an empty request perfectly cached', () => {
    expect(comparePrefix(snapshotPrefix([]), snapshotPrefix(TURN_ONE)).sharedPrefixRatio).toBe(0);
  });
});

describe('prefixTraceDetail', () => {
  it('flattens to one level with snake_case keys', () => {
    const detail = prefixTraceDetail(
      comparePrefix(snapshotPrefix([...TURN_ONE, message('u2')]), snapshotPrefix(TURN_ONE))
    );
    expect(detail).toEqual({
      common_blocks: 3,
      common_bytes: snapshotPrefix(TURN_ONE).totalBytes,
      next_blocks: 4,
      previous_blocks: 3,
      shared_prefix_ratio: expect.any(Number),
    });
    expect(Object.values(detail).every((value) => typeof value !== 'object')).toBe(true);
  });

  it('nulls an absent label rather than omitting the key', () => {
    const detail = prefixTraceDetail(
      comparePrefix(snapshotPrefix([system('changed')]), snapshotPrefix(TURN_ONE))
    );
    expect(detail.diverged_index).toBe(0);
    expect(detail.diverged_kind).toBe('system');
    expect(detail.diverged_label).toBeNull();
    expect(detail.diverged_previous_kind).toBe('system');
  });
});
