import { translate } from '@shared/i18n';
import { MAX_ATTACHMENT_READ_BYTES } from '@shared/types/attachmentIo';
import { describe, expect, it } from 'vitest';
import {
  type AttachmentLimits,
  admitAttachment,
  DEFAULT_ATTACHMENT_LIMITS,
  imageInputUnsupportedHint,
  largeAttachmentHint,
  MAX_IMAGE_EDGE_PX,
  modelLacksImageInput,
  planImageAttachment,
  SUPPORTED_IMAGE_MEDIA_TYPES,
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
 * `[T-01]`~`[T-05]` retired together with `sendTimeoutMs` itself in F2 S3 (the
 * byte-scaled timeout formula is void — see spec §1.3 / §12.1). There are no
 * more timeout-related cases in this file.
 */

/**
 * T067 (D26) — every attachment sentence, in the app's default language.
 *
 * The 2026-09-17 field pass photographed a composer whose own controls read
 * 「执行 · 每次询问」 and 「发送消息」 while the attachment line under them read
 * `Attachments total 6.0 MB — sending may take longer.` Six sentences, one
 * surface, none of them ever routed through the catalog.
 *
 * Each case asserts the Chinese AND that the English template is gone. The
 * second half is what catches a half-applied fix — a key that reached the
 * catalog with the wrong text falls back to the key itself, i.e. to English,
 * silently.
 */
describe('attachment copy in Chinese (T067 D26)', () => {
  const zh = (key: string, params?: Record<string, string | number>) =>
    translate('zh', key, params);
  const refuse = (result: ReturnType<typeof admitAttachment>): string =>
    result.ok ? '' : result.message;

  it('words the four admission refusals', () => {
    expect(
      refuse(admitAttachment([], { name: 'empty.txt', byteLength: 0, kind: 'text' }, LIMITS, zh))
    ).toBe('「empty.txt」是空文件，已跳过。');

    const full = Array.from({ length: 5 }, () => ({ byteLength: 1024 }));
    expect(
      refuse(
        admitAttachment(full, { name: 'six.png', byteLength: 4096, kind: 'image' }, LIMITS, zh)
      )
    ).toBe('每条消息最多 5 个附件，已跳过「six.png」。');

    expect(
      refuse(
        admitAttachment([], { name: 'huge.png', byteLength: 7 * MB, kind: 'image' }, LIMITS, zh)
      )
    ).toBe('「huge.png」有 7.0 MB，单个图片最大 1.0 MB。');
    // The kind noun is its own key, so the text branch must not print 'image'.
    expect(
      refuse(admitAttachment([], { name: 'big.log', byteLength: 7 * MB, kind: 'text' }, LIMITS, zh))
    ).toContain('单个文本文件');

    expect(
      refuse(
        admitAttachment(
          [{ byteLength: 1.5 * MB }],
          { name: 'more.png', byteLength: 1 * MB, kind: 'image' },
          LIMITS,
          zh
        )
      )
    ).toBe('附件合计将达 2.5 MB，每条消息最多 2.0 MB，请先移除一个。');
  });

  it('words both image rejections', () => {
    expect(planImageAttachment({ name: 'old.bmp', mediaType: 'image/bmp' }, zh)).toEqual({
      action: 'reject',
      reason: 'unsupported-type',
      message: '「old.bmp」是 image/bmp，只支持 JPEG、PNG、GIF 和 WebP。',
    });
    expect(
      planImageAttachment(
        { name: 'wide.png', mediaType: 'image/png', width: 9000, height: 100 },
        zh
      )
    ).toEqual({
      action: 'reject',
      reason: 'oversized-pixels',
      message: '「wide.png」是 9000x100 像素，长边最大 8000 像素。',
    });
  });

  it('words the large-payload hint — the sentence actually photographed', () => {
    expect(largeAttachmentHint([{ byteLength: 3 * MB }], undefined, zh)).toBe(
      '附件合计 3.0 MB，发送可能会慢一些。'
    );
  });

  it('reverse: the default translator still emits the exact English bytes', () => {
    // Every assertion above this block asserts English through the same code
    // path with no `t` supplied. These two re-state it next to their Chinese
    // twins so a drift shows up as one failing pair, not a whole file.
    expect(largeAttachmentHint([{ byteLength: 3 * MB }])).toBe(
      'Attachments total 3.0 MB — sending may take longer.'
    );
    expect(largeAttachmentHint([{ byteLength: 3 * MB }], undefined, zh)).not.toMatch(
      /Attachments total|sending may take longer/
    );
    expect(refuse(admitAttachment([], { name: 'e.txt', byteLength: 0, kind: 'text' }))).toBe(
      '"e.txt" is empty — skipped.'
    );
  });
});

describe('modelLacksImageInput (T3)', () => {
  const catalog = [
    { id: 'p/vision', input: ['text', 'image'] as Array<'text' | 'image'> },
    { id: 'p/text', input: ['text'] as Array<'text' | 'image'> },
    // Undeclared: the runtime reads this as text-only.
    { id: 'p/plain' },
  ];
  const image = { kind: 'image' as const };
  const text = { kind: 'text' as const };

  it.each([
    ['text-only model, image draft', [image], 'p/text', true],
    ['undeclared model, image draft', [text, image], 'p/plain', true],
    ['image-capable model', [image], 'p/vision', false],
    ['no image draft', [text], 'p/text', false],
    ['no drafts at all', [], 'p/plain', false],
    // Automatic: the runtime picks a model this side cannot name.
    ['Automatic', [image], undefined, false],
    // Not in the catalog (yet): nothing declared to read, so no claim.
    ['model missing from the catalog', [image], 'gone/model', false],
  ] as const)('%s → %s', (_label, drafts, model, expected) => {
    expect(modelLacksImageInput({ drafts, model, catalog })).toBe(expected);
  });

  it('reads an empty catalog as "cannot tell"', () => {
    expect(modelLacksImageInput({ drafts: [image], model: 'p/text', catalog: [] })).toBe(false);
  });

  it('words the hint in both languages and names the only editable place', () => {
    const english = imageInputUnsupportedHint();
    expect(english).toContain('will not see this image');
    expect(english).toContain('Per-model metadata');
    const chinese = imageInputUnsupportedHint((key, params) => translate('zh', key, params));
    expect(chinese).toBe(
      '当前模型未声明支持图片，发送后模型看不到这张图片。可换用支持图片的模型；如果是你自己添加的 AI 服务，也可以在「设置 · Pi · AI 服务」里编辑该服务，在「各模型元数据」中把输入类型设为「图像」。'
    );
  });
});
