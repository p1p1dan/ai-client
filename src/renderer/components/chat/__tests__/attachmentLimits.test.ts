import { MAX_ATTACHMENT_READ_BYTES } from '@shared/types/attachmentIo';
import { describe, expect, it } from 'vitest';
import {
  type AttachmentLimits,
  admitAttachment,
  DEFAULT_ATTACHMENT_LIMITS,
  largeAttachmentHint,
  MAX_IMAGE_EDGE_PX,
  planImageAttachment,
  SEND_BASE_TIMEOUT_MS,
  SEND_TIMEOUT_CEILING_MS,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  sendTimeoutMs,
} from '../attachmentLimits';

const LIMITS: AttachmentLimits = {
  maxCount: 5,
  maxImageBytes: 1_048_576,
  maxTextBytes: 1_048_576,
  maxTotalBytes: 2_097_152,
};

const KB = 1024;
const MB = 1024 * 1024;

describe('admitAttachment (T-18 A-01..A-08)', () => {
  it('[A-01] refuses a zero-byte file — an empty data field kills the whole send', () => {
    const result = admitAttachment([], { name: 'empty.txt', byteLength: 0, kind: 'text' });
    expect(result).toMatchObject({ ok: false, reason: 'empty' });
    expect(result.ok === false && result.message).toContain('empty.txt');
  });

  it('[A-02] refuses a single file over the per-attachment cap and names the cap', () => {
    const result = admitAttachment(
      [],
      { name: 'big.png', byteLength: 1_048_577, kind: 'image' },
      LIMITS
    );
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
    expect(result.ok === false && result.message).toContain('1.0 MB');
  });

  it('[A-03] refuses when the total would break the budget, even if each item fits', () => {
    const result = admitAttachment(
      [{ byteLength: 1_887_437 }],
      { name: 'x.png', byteLength: 524_288, kind: 'image' },
      LIMITS
    );
    expect(result).toMatchObject({ ok: false, reason: 'total-exceeded' });
  });

  it('[A-04] checks the count before the size, so the message cannot mislead', () => {
    const existing = Array.from({ length: 5 }, () => ({ byteLength: KB }));
    const result = admitAttachment(
      existing,
      { name: 'sixth.png', byteLength: KB, kind: 'image' },
      LIMITS
    );
    expect(result).toMatchObject({ ok: false, reason: 'too-many' });
    expect(result.ok === false && result.message).toContain('5 attachments');
  });

  it('[A-05] admits an ordinary screenshot', () => {
    expect(admitAttachment([], { name: 'shot.png', byteLength: 40_960, kind: 'image' })).toEqual({
      ok: true,
    });
  });

  it('[A-06] treats the single-attachment cap as inclusive', () => {
    expect(
      admitAttachment(
        [],
        { name: 'exact.png', byteLength: LIMITS.maxImageBytes, kind: 'image' },
        LIMITS
      )
    ).toEqual({ ok: true });
  });

  it('[A-07] treats the total cap as inclusive', () => {
    expect(
      admitAttachment(
        [{ byteLength: LIMITS.maxTotalBytes - KB }],
        { name: 'last.png', byteLength: KB, kind: 'image' },
        LIMITS
      )
    ).toEqual({ ok: true });
  });

  it('[A-08] ships defaults that are internally consistent', () => {
    expect(DEFAULT_ATTACHMENT_LIMITS.maxCount).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_ATTACHMENT_LIMITS.maxImageBytes).toBeGreaterThan(0);
    expect(DEFAULT_ATTACHMENT_LIMITS.maxTextBytes).toBeGreaterThan(0);
    expect(DEFAULT_ATTACHMENT_LIMITS.maxImageBytes).toBeLessThanOrEqual(
      DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes
    );
    expect(DEFAULT_ATTACHMENT_LIMITS.maxTextBytes).toBeLessThanOrEqual(
      DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes
    );
  });

  it('[A-09] applies the text budget to text and the image budget to images', () => {
    // A 2 MB screenshot is fine; 2 MB of text is ~500k tokens and is not.
    expect(admitAttachment([], { name: 'shot.png', byteLength: 2 * MB, kind: 'image' })).toEqual({
      ok: true,
    });
    expect(
      admitAttachment([], { name: 'dump.log', byteLength: 2 * MB, kind: 'text' })
    ).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('[A-10] falls back to a readable label for unnamed clipboard bitmaps', () => {
    const result = admitAttachment([], { name: '', byteLength: 0, kind: 'image' });
    expect(result.ok === false && result.message).toContain('Pasted item');
  });
});

/**
 * D4 (round-5) mirror lock — same technique as `sendBudgets.ts`'s Host mirrors.
 *
 * The main process cannot import these renderer budgets (they are renderer
 * code, and main must not depend on the Composer), so it carries ONE number of
 * its own: a hard ceiling on a single attachment read. If the two ever drift,
 * the failure is silent and asymmetric — a raised image budget would be
 * refused by main with a size the renderer never expected to be a problem, and
 * a lowered one would let main read more than the renderer will ever accept.
 */
describe('MAX_ATTACHMENT_READ_BYTES mirror (D4)', () => {
  it('the main-process read ceiling equals the renderer image budget', () => {
    expect(MAX_ATTACHMENT_READ_BYTES).toBe(DEFAULT_ATTACHMENT_LIMITS.maxImageBytes);
  });

  // The ceiling is the LARGEST single thing that may ever be read, so no tier
  // may sit above it — a text budget over the ceiling would be unreachable.
  it('no per-attachment tier sits above the ceiling', () => {
    expect(DEFAULT_ATTACHMENT_LIMITS.maxTextBytes).toBeLessThanOrEqual(MAX_ATTACHMENT_READ_BYTES);
    expect(DEFAULT_ATTACHMENT_LIMITS.maxImageBytes).toBeLessThanOrEqual(MAX_ATTACHMENT_READ_BYTES);
  });
});

describe('planImageAttachment (T-18 E2/E3 — accept vs reject, no downscale)', () => {
  it('accepts a supported format inside the pixel cap as-is', () => {
    expect(
      planImageAttachment({
        name: 'shot.png',
        mediaType: 'image/png',
        width: 3840,
        height: 2160,
      })
    ).toEqual({ action: 'as-is' });
  });

  it('accepts when the dimensions could not be decoded (no false rejection)', () => {
    expect(planImageAttachment({ name: 'shot.webp', mediaType: 'image/webp' })).toEqual({
      action: 'as-is',
    });
  });

  it('rejects a format outside the API whitelist', () => {
    const plan = planImageAttachment({ name: 'old.bmp', mediaType: 'image/bmp' });
    expect(plan).toMatchObject({ action: 'reject', reason: 'unsupported-type' });
    expect(plan.action === 'reject' && plan.message).toContain('WebP');
  });

  it('rejects an image past the 8000px edge cap the API enforces', () => {
    const plan = planImageAttachment({
      name: 'huge.png',
      mediaType: 'image/png',
      width: 12_000,
      height: 800,
    });
    expect(plan).toMatchObject({ action: 'reject', reason: 'oversized-pixels' });
    expect(plan.action === 'reject' && plan.message).toContain('8000px');
  });

  it('treats the edge cap as inclusive', () => {
    expect(
      planImageAttachment({
        name: 'edge.png',
        mediaType: 'image/png',
        width: MAX_IMAGE_EDGE_PX,
        height: MAX_IMAGE_EDGE_PX,
      })
    ).toEqual({ action: 'as-is' });
  });

  it('whitelists exactly the four documented media types', () => {
    expect([...SUPPORTED_IMAGE_MEDIA_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ]);
  });
});

describe('largeAttachmentHint (T-18 E6)', () => {
  it('stays quiet for small payloads', () => {
    expect(largeAttachmentHint([{ byteLength: 40 * KB }])).toBeNull();
  });

  it('warns on a large single attachment', () => {
    expect(largeAttachmentHint([{ byteLength: 3 * MB }])).toBe(
      'Attachments total 3.0 MB — sending may take longer.'
    );
  });

  it('warns on a large total and never predicts seconds', () => {
    const hint = largeAttachmentHint([{ byteLength: 900 * KB }, { byteLength: 1.5 * MB }]);
    expect(hint).not.toBeNull();
    expect(hint).not.toMatch(/\d+\s*s\b/);
  });
});

/**
 * F2 (2026-08-18 §12.1): `[T-06]` and `[a4]` are RETIRED here rather than
 * renumbered — both locked the OLD invariant direction ("the renderer's
 * ceiling elapses first"), which is now reversed. Their successors are
 * `[C-01]` / `[C-02]` in `sendBudgets.test.ts`; renumbering them would have
 * hidden the fact that the direction flipped.
 *
 * `[T-01]`~`[T-05]` stay green only because `sendTimeoutMs` still has one
 * caller (`MessageTimeline.tsx`'s `DEFAULT_REPLY_BUDGET_MS`, S3's file). They
 * retire together with the function itself in S3 — a live formula with no pin
 * would be worse than a pin on a deprecated one.
 */
describe('sendTimeoutMs (T-18 T-01..T-05, deprecated — retires with the function in F2 S3)', () => {
  it('[T-01] is bit-for-bit unchanged on the text-only path', () => {
    expect(sendTimeoutMs(0)).toBe(45_000);
    expect(sendTimeoutMs(0)).toBe(SEND_BASE_TIMEOUT_MS);
    expect(sendTimeoutMs(-1)).toBe(45_000);
  });

  it('[T-02] gives a 150 KB screenshot far more room than the old 45s', () => {
    const budget = sendTimeoutMs(150 * KB);
    expect(budget).toBe(75_000);
    expect(budget).toBeGreaterThan(45_000);
    // The former `< HOST_STALL_TIMEOUT_MS` assertion was a restatement of the
    // retired `[T-06]` invariant and moved with it to `sendBudgets.test.ts`.
  });

  it('[T-03] barely moves for a tiny image', () => {
    expect(sendTimeoutMs(70)).toBe(75_000);
  });

  it('[T-04] budgets on total bytes, not on the largest item', () => {
    expect(sendTimeoutMs(100 * KB + 52 * KB)).toBe(sendTimeoutMs(152 * KB));
    expect(sendTimeoutMs(2 * MB)).toBe(105_000);
  });

  it('[T-05] is clamped and monotonic', () => {
    expect(sendTimeoutMs(5 * MB)).toBe(SEND_TIMEOUT_CEILING_MS);
    expect(sendTimeoutMs(10 * MB)).toBe(SEND_TIMEOUT_CEILING_MS);
    const points = [0, 60 * KB, 152 * KB, 2 * MB, 5 * MB].map(sendTimeoutMs);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]).toBeGreaterThanOrEqual(points[i - 1]);
    }
  });
});
