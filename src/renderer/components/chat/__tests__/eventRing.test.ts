import { describe, expect, it } from 'vitest';
import { createEventRing } from '../eventRing';

/**
 * Build spec 2026-08-14 (partial messages), 片 2: the collapsing diagnostic
 * event ring that replaces the rejected rev.1 flat tail ring. See
 * `eventRing.ts`'s module doc for the fold + head-window + tail-cap rules
 * this exercises.
 */
describe('createEventRing', () => {
  it('collapses consecutive identical pushes into a `type ×N` snapshot entry', () => {
    const ring = createEventRing();
    ring.push('a');
    ring.push('a');
    ring.push('a');
    ring.push('b');
    expect(ring.snapshot()).toEqual(['a ×3', 'b']);
  });

  it('does not collapse non-consecutive repeats of the same string', () => {
    const ring = createEventRing();
    ring.push('a');
    ring.push('b');
    ring.push('a');
    expect(ring.snapshot()).toEqual(['a', 'b', 'a']);
  });

  it('always folds the high-frequency whitelist types (message.delta / thinking.delta / usage.updated)', () => {
    const ring = createEventRing();
    ring.push('message.delta');
    ring.push('message.delta');
    ring.push('thinking.delta');
    ring.push('usage.updated');
    ring.push('usage.updated');
    ring.push('usage.updated');
    expect(ring.snapshot()).toEqual(['message.delta ×2', 'thinking.delta', 'usage.updated ×3']);
  });

  it('folds high-frequency types by TYPE PREFIX, not full-string equality', () => {
    const ring = createEventRing();
    ring.push('message.delta');
    // A hypothetical future formatRuntimeEvent() that appends detail after
    // the type name must still fold to one line — full-string equality
    // alone would let a per-tick flood of slightly different strings
    // through uncollapsed.
    ring.push('message.delta(extra detail)');
    expect(ring.snapshot()).toEqual(['message.delta ×2']);
  });

  it('non-whitelisted types require exact-string equality to fold, unlike the whitelist prefix rule', () => {
    const ring = createEventRing();
    ring.push('host.error(a)');
    // The first string is a literal PREFIX of the second, but `host.error`
    // is not in the high-frequency whitelist — only an EXACT repeat of the
    // tail string may fold here, so these stay two separate lines.
    ring.push('host.error(a) extra');
    expect(ring.snapshot()).toEqual(['host.error(a)', 'host.error(a) extra']);
  });

  it('keeps the first 50 post-fold entries (head window) alive after 10k pushes', () => {
    const ring = createEventRing();
    const expectedHead: string[] = [];
    for (let i = 0; i < 50; i++) {
      const label = `head-${i}`;
      expectedHead.push(label);
      ring.push(label);
    }
    for (let i = 0; i < 10_000; i++) {
      ring.push(`tail-${i}`);
    }
    expect(ring.snapshot().slice(0, 50)).toEqual(expectedHead);
  });

  it('create-timeout diagnostic scenario: the earliest events survive a flood of high-frequency deltas', () => {
    // This is the exact shape ChatComposer.tsx:1213's create-timeout
    // diagnostic depends on — session.created and an early host.error must
    // still be visible after thousands of message.delta events fold in.
    const ring = createEventRing();
    ring.push('session.created');
    ring.push('host.error(create_failed: boom)');
    for (let i = 0; i < 20_000; i++) {
      ring.push('message.delta');
    }
    const snapshot = ring.snapshot();
    expect(snapshot[0]).toBe('session.created');
    expect(snapshot[1]).toBe('host.error(create_failed: boom)');
  });

  it('caps the tail at 250 post-fold entries once the head window is full', () => {
    const ring = createEventRing();
    for (let i = 0; i < 50; i++) ring.push(`head-${i}`);
    // 300 distinct (non-folding) tail pushes against a 250 cap — the 50
    // oldest must be evicted, in FIFO order.
    for (let i = 0; i < 300; i++) ring.push(`tail-${i}`);

    const snapshot = ring.snapshot();
    expect(snapshot.length).toBe(50 + 250);
    expect(snapshot[50]).toBe('tail-50');
    expect(snapshot[snapshot.length - 1]).toBe('tail-299');
  });

  it('dropped() counts evicted entries honestly', () => {
    const ring = createEventRing();
    for (let i = 0; i < 50; i++) ring.push(`head-${i}`);
    expect(ring.dropped()).toBe(0);

    for (let i = 0; i < 300; i++) ring.push(`tail-${i}`);
    expect(ring.dropped()).toBe(50);
  });

  it('dropped() sums the underlying push count of a folded entry when it is evicted, not just 1', () => {
    const ring = createEventRing();
    for (let i = 0; i < 50; i++) ring.push(`head-${i}`);
    // A single tail entry folded 5x, then pushed out of the cap by 250 more
    // distinct entries — its eviction must count all 5 underlying pushes.
    for (let i = 0; i < 5; i++) ring.push('bursty');
    for (let i = 0; i < 250; i++) ring.push(`tail-${i}`);

    expect(ring.dropped()).toBe(5);
    expect(ring.snapshot()).not.toContain('bursty ×5');
  });
});
