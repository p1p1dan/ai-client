import { describe, expect, it } from 'vitest';
import { composerSendingLine, SLOW_WAIT_HINT_SECONDS } from '../attachments';
import { deriveTurnStatus, TURN_FAILED_TEXT, type TurnStatusInput } from '../turnStatus';

const base: TurnStatusInput = {
  active: true,
  phase: 'awaiting',
  elapsedSeconds: 12,
  budgetMs: 45_000,
  attachmentCount: 0,
  attachmentBytes: 0,
};

describe('deriveTurnStatus (F-B5)', () => {
  it('F-B5: handshake', () => {
    const status = deriveTurnStatus({ ...base, phase: 'handshake', elapsedSeconds: 3 });
    expect(status?.kind).toBe('handshake');
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'handshake',
        elapsedSeconds: 3,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      })
    );
  });

  // The point of this pair is that neither side is a literal. `attachments.ts`
  // owns the copy and `attachments.test.ts` pins it word for word; this asserts
  // the turn head *delegates* rather than keeping a second copy of the string,
  // which is the drift the spec (§3.2) is guarding against.
  it('F-B5: awaiting is character-for-character the same-argument composerSendingLine output', () => {
    const status = deriveTurnStatus(base);
    expect(status?.kind).toBe('awaiting');
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 12,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      })
    );
  });

  it('F-B5: awaiting delegates the attachment branch too, without knowing its shape', () => {
    const input = { ...base, attachmentCount: 1, attachmentBytes: 155_648, elapsedSeconds: 31 };
    expect(deriveTurnStatus(input)?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 31,
        budgetMs: 45_000,
        attachmentCount: 1,
        attachmentBytes: 155_648,
      })
    );
  });

  it('F-B5: streaming — the one string this batch adds (§9-ε)', () => {
    const status = deriveTurnStatus({ ...base, hasBlocks: true, elapsedSeconds: 7 });
    expect(status).toEqual({ kind: 'streaming', text: 'Generating · 7s' });
  });

  it('F-B5: streaming outranks the slow branch — "Still waiting" is false once tokens arrive', () => {
    const status = deriveTurnStatus({ ...base, hasBlocks: true, elapsedSeconds: 90 });
    expect(status).toEqual({ kind: 'streaming', text: 'Generating · 90s' });
  });

  it('F-B5: slow at the threshold, still delegating the copy', () => {
    const status = deriveTurnStatus({ ...base, elapsedSeconds: SLOW_WAIT_HINT_SECONDS });
    expect(status?.kind).toBe('slow');
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: SLOW_WAIT_HINT_SECONDS,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      })
    );
    // One second earlier is still the ordinary waiting state: the kind flips on
    // the same constant the copy does, never a second threshold of its own.
    expect(deriveTurnStatus({ ...base, elapsedSeconds: SLOW_WAIT_HINT_SECONDS - 1 })?.kind).toBe(
      'awaiting'
    );
  });

  it('F-B5: retrying carries the retry counter through, base copy intact', () => {
    const retry = { attempt: 3, maxRetries: 10 };
    const status = deriveTurnStatus({ ...base, retry });
    expect(status?.kind).toBe('retrying');
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 12,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
        retry,
      })
    );
  });

  it('F-B5: complete returns null — the "Worked for Ns" row takes the same slot', () => {
    expect(deriveTurnStatus({ ...base, active: false })).toBeNull();
  });

  it('F-B5: failed wins over every in-flight branch and stays a short fixed label', () => {
    expect(deriveTurnStatus({ ...base, failed: true })).toEqual({
      kind: 'failed',
      text: TURN_FAILED_TEXT,
    });
    expect(deriveTurnStatus({ ...base, active: false, failed: true })?.kind).toBe('failed');
    expect(TURN_FAILED_TEXT.length).toBeLessThanOrEqual(16);
  });

  it('F-B5: a negative/fractional elapsed counts the same second as the composer copy does', () => {
    expect(deriveTurnStatus({ ...base, hasBlocks: true, elapsedSeconds: -2 })?.text).toBe(
      'Generating · 0s'
    );
    expect(deriveTurnStatus({ ...base, hasBlocks: true, elapsedSeconds: 7.9 })?.text).toBe(
      'Generating · 7s'
    );
  });
});
