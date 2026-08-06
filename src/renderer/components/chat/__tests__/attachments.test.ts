import { describe, expect, it } from 'vitest';
import {
  type AttachmentDraft,
  bytesToBase64,
  composerSendingLine,
  decodeTextBytes,
  detectAttachmentKind,
  formatAttachmentSize,
  formatSkipNotice,
  isProbablyBinary,
  shouldRenderThumbnail,
  THUMBNAIL_MAX_BYTES,
  toAttachmentChip,
  totalAttachmentBytes,
  toWireAttachments,
} from '../attachments';

function draft(partial: Partial<AttachmentDraft> = {}): AttachmentDraft {
  return {
    id: 'a1',
    kind: 'image',
    mediaType: 'image/png',
    name: 'a.png',
    byteLength: 40960,
    data: 'iVBORw0KGgo=',
    ...partial,
  };
}

/** Node-side oracle: the encoder the Host smoke uses. */
function oracle(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function ramp(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = i % 256;
  return bytes;
}

describe('bytesToBase64 (T-18 B-01..B-06)', () => {
  it('[B-01] encodes an empty array as an empty string', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });

  it('[B-02] matches a known vector', () => {
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });

  it('[B-03] encodes the PNG magic bytes', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytesToBase64(png)).toBe('iVBORw0KGgo=');
  });

  it('[B-04] agrees with the Buffer oracle across the 32 KiB chunk boundary', () => {
    const bytes = ramp(40_000);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(oracle(bytes));
    expect(encoded).toHaveLength(53_336);
  });

  it('[B-04b] agrees with the oracle at exactly 0x7FFF / 0x8000 / 0x8001 bytes', () => {
    for (const length of [0x7fff, 0x8000, 0x8001]) {
      const bytes = ramp(length);
      expect(bytesToBase64(bytes)).toBe(oracle(bytes));
    }
  });

  it('[B-04c] encodes 512 KB without blowing the stack (spread-argument regression)', () => {
    const bytes = ramp(512 * 1024);
    let encoded = '';
    expect(() => {
      encoded = bytesToBase64(bytes);
    }).not.toThrow();
    expect(encoded).toBe(oracle(bytes));
  });

  it('[B-05] keeps high bytes intact (no UTF-8 reinterpretation)', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x00]);
    expect(bytesToBase64(bytes)).toBe(oracle(bytes));
  });

  it('[B-06] emits no data: prefix and no line breaks', () => {
    const encoded = bytesToBase64(ramp(70_000));
    expect(encoded).not.toContain('data:');
    expect(encoded).not.toContain(';base64,');
    expect(encoded).not.toContain('\n');
    expect(encoded).not.toContain('\r');
  });
});

describe('decodeTextBytes / isProbablyBinary (T-18 A5)', () => {
  it('decodes UTF-8 including multi-byte characters', () => {
    expect(decodeTextBytes(new TextEncoder().encode('héllo 世界'))).toBe('héllo 世界');
  });

  it('strips a leading UTF-8 BOM so it cannot pollute the prompt', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Title')]);
    expect(decodeTextBytes(withBom)).toBe('# Title');
  });

  it('flags NUL-bearing content as binary', () => {
    expect(isProbablyBinary('abc\u0000def')).toBe(true);
  });

  it('accepts ordinary text and empty text', () => {
    expect(isProbablyBinary('const a = 1;\n')).toBe(false);
    expect(isProbablyBinary('')).toBe(false);
  });

  it('flags decoded garbage by replacement-char ratio', () => {
    const garbage = decodeTextBytes(new Uint8Array([0xc3, 0x28, 0xa0, 0xa1, 0xf8, 0xa1]));
    expect(isProbablyBinary(garbage)).toBe(true);
  });
});

describe('detectAttachmentKind (T-18 D-01..D-09)', () => {
  it('[D-01] png with a correct MIME type', () => {
    expect(detectAttachmentKind('shot.png', 'image/png')).toEqual({
      kind: 'image',
      mediaType: 'image/png',
    });
  });

  it('[D-02] falls back to the extension, case-insensitively, when File.type is empty', () => {
    expect(detectAttachmentKind('SHOT.PNG', '')).toEqual({
      kind: 'image',
      mediaType: 'image/png',
    });
  });

  it('[D-03] markdown without a MIME type normalises to text/plain', () => {
    expect(detectAttachmentKind('notes.md', '')).toEqual({
      kind: 'text',
      mediaType: 'text/plain',
    });
  });

  it('[D-04] source files without a MIME type normalise to text/plain', () => {
    expect(detectAttachmentKind('main.ts', '')).toEqual({ kind: 'text', mediaType: 'text/plain' });
  });

  it('[D-05] application/json is text, not "unsupported"', () => {
    expect(detectAttachmentKind('tsconfig.json', 'application/json')).toEqual({
      kind: 'text',
      mediaType: 'text/plain',
    });
  });

  it('[D-06] extension-less files fall back to text instead of vanishing', () => {
    expect(detectAttachmentKind('LICENSE', '')).toEqual({ kind: 'text', mediaType: 'text/plain' });
    expect(detectAttachmentKind('Dockerfile', '')).toEqual({
      kind: 'text',
      mediaType: 'text/plain',
    });
    expect(detectAttachmentKind('.gitignore', '')).toEqual({
      kind: 'text',
      mediaType: 'text/plain',
    });
  });

  it('[D-07] archives are rejected', () => {
    expect(detectAttachmentKind('archive.zip', 'application/zip')).toBeNull();
  });

  it('[D-08] PDF is rejected — the protocol has no document kind', () => {
    expect(detectAttachmentKind('doc.pdf', 'application/pdf')).toBeNull();
  });

  it('[D-09] the four supported image types map to themselves', () => {
    expect(detectAttachmentKind('photo.jpg', 'image/jpeg')).toEqual({
      kind: 'image',
      mediaType: 'image/jpeg',
    });
    expect(detectAttachmentKind('anim.gif', 'image/gif')).toEqual({
      kind: 'image',
      mediaType: 'image/gif',
    });
    expect(detectAttachmentKind('pic.webp', 'image/webp')).toEqual({
      kind: 'image',
      mediaType: 'image/webp',
    });
    // image/jpg is a common browser alias and must be normalised.
    expect(detectAttachmentKind('photo.jpg', 'image/jpg')).toEqual({
      kind: 'image',
      mediaType: 'image/jpeg',
    });
  });

  it('[D-10] image formats outside the API whitelist are rejected, never sent as text', () => {
    expect(detectAttachmentKind('old.bmp', 'image/bmp')).toBeNull();
    expect(detectAttachmentKind('scan.tiff', 'image/tiff')).toBeNull();
    expect(detectAttachmentKind('phone.heic', 'image/heic')).toBeNull();
    expect(detectAttachmentKind('modern.avif', 'image/avif')).toBeNull();
  });

  it('[D-11] SVG travels as text — it is markup, not a supported image type', () => {
    expect(detectAttachmentKind('icon.svg', 'image/svg+xml')).toEqual({
      kind: 'text',
      mediaType: 'text/plain',
    });
  });

  it('[D-12] media type parameters do not break the match', () => {
    expect(detectAttachmentKind('notes.md', 'text/markdown;charset=utf-8')).toEqual({
      kind: 'text',
      mediaType: 'text/plain',
    });
  });

  it('[D-13] audio / video / fonts are rejected', () => {
    expect(detectAttachmentKind('clip.mp4', 'video/mp4')).toBeNull();
    expect(detectAttachmentKind('sound.mp3', 'audio/mpeg')).toBeNull();
    expect(detectAttachmentKind('face.woff2', 'font/woff2')).toBeNull();
  });
});

describe('toWireAttachments (T-18 W-01..W-07)', () => {
  it('[W-01] returns undefined for no drafts, so no attachments key is sent', () => {
    expect(toWireAttachments([])).toBeUndefined();
  });

  it('[W-02] emits exactly the four protocol fields', () => {
    const wire = toWireAttachments([draft()]);
    expect(wire).toEqual([
      { kind: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'a.png' },
    ]);
    expect(Object.keys(wire?.[0] ?? {}).sort()).toEqual(['data', 'kind', 'mediaType', 'name']);
    expect(wire?.[0].data).not.toContain('data:');
  });

  it('[W-03] drops an empty entry without taking the valid one down with it', () => {
    const wire = toWireAttachments([draft(), draft({ id: 'a2', data: '' })]);
    expect(wire).toHaveLength(1);
    expect(wire?.[0].name).toBe('a.png');
  });

  it('[W-04] returns undefined when every entry is empty (never an empty array)', () => {
    expect(toWireAttachments([draft({ data: '' })])).toBeUndefined();
  });

  it('[W-05] text drafts carry raw text, not base64', () => {
    const wire = toWireAttachments([
      draft({ kind: 'text', mediaType: 'text/plain', name: 'n.txt', data: 'hello' }),
    ]);
    expect(wire?.[0].data).toBe('hello');
  });

  it('[W-06] omits the name key entirely for unnamed clipboard bitmaps', () => {
    const wire = toWireAttachments([draft({ name: '' })]);
    expect(wire?.[0]).not.toHaveProperty('name');
  });

  it('[W-07] preserves paste order', () => {
    const wire = toWireAttachments([
      draft({ id: '1', name: 'one.png' }),
      draft({ id: '2', name: 'two.png' }),
      draft({ id: '3', name: 'three.png' }),
    ]);
    expect(wire?.map((item) => item.name)).toEqual(['one.png', 'two.png', 'three.png']);
  });
});

describe('formatAttachmentSize / totalAttachmentBytes (T-18 C-02, C-03)', () => {
  it('[C-02] uses the tiers already used elsewhere in the app', () => {
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(1024)).toBe('1.0 KB');
    expect(formatAttachmentSize(1_572_864)).toBe('1.5 MB');
  });

  it('[C-03] never renders NaN or a negative size', () => {
    expect(formatAttachmentSize(0)).toBe('0 B');
    expect(formatAttachmentSize(Number.NaN)).toBe('0 B');
    expect(formatAttachmentSize(-5)).toBe('0 B');
  });

  it('sums raw bytes across drafts', () => {
    expect(totalAttachmentBytes([{ byteLength: 100 }, { byteLength: 24 }])).toBe(124);
    expect(totalAttachmentBytes([])).toBe(0);
  });
});

describe('toAttachmentChip (T-18 C-01, C-04..C-08)', () => {
  it('[C-01] renders name, size and kind for a short name', () => {
    expect(toAttachmentChip(draft({ name: 'shot.png', byteLength: 40960 }))).toEqual({
      kind: 'image',
      label: 'shot.png',
      sizeLabel: '40.0 KB',
      title: 'shot.png',
    });
  });

  it('[C-04] leaves a short CJK name untouched', () => {
    expect(toAttachmentChip(draft({ name: '我的截图.png' })).label).toBe('我的截图.png');
  });

  it('[C-05] keeps inner spaces when the name fits', () => {
    const chip = toAttachmentChip(draft({ name: 'my long screenshot name.png' }), 40);
    expect(chip.label).toBe('my long screenshot name.png');
  });

  it('[C-06] elides the middle but keeps the extension and the full title', () => {
    const name = '我的 截图 非常长的文件名-测试-abcdefghijklmnopqrstuvwxyz.png';
    const chip = toAttachmentChip(draft({ name }), 24);
    expect(chip.label.length).toBeLessThanOrEqual(24);
    expect(chip.label).toContain('…');
    expect(chip.label.endsWith('.png')).toBe(true);
    expect(chip.title).toBe(name);
  });

  it('[C-07] elides an extension-less name without leaving a dot fragment', () => {
    const chip = toAttachmentChip(draft({ name: 'a'.repeat(60) }), 24);
    expect(chip.label.length).toBeLessThanOrEqual(24);
    expect(chip.label).toContain('…');
    expect(chip.label).not.toContain('.');
  });

  it('[C-08] reports the kind so the component picks an icon deterministically', () => {
    expect(toAttachmentChip(draft({ kind: 'text', name: 'n.md' })).kind).toBe('text');
    expect(toAttachmentChip(draft({ kind: 'image' })).kind).toBe('image');
  });
});

describe('composerSendingLine (T-18 B2)', () => {
  it('reports the real budget on the text-only path', () => {
    expect(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 12,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      })
    ).toBe('Waiting for Agent Host reply · 12s (up to 45s)');
  });

  it('names the payload once attachments are in flight', () => {
    expect(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 31,
        budgetMs: 75_000,
        attachmentCount: 1,
        attachmentBytes: 155_648,
      })
    ).toBe('Sent 152.0 KB · waiting for reply · 31s (up to 75s)');
  });

  it('switches wording past the slow threshold and never predicts a finish time', () => {
    const line = composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds: 62,
      budgetMs: 115_000,
      attachmentCount: 1,
      attachmentBytes: 2_097_152,
    });
    expect(line).toBe('Still waiting · 62s — gateway latency varies. Stop to abort.');
    expect(line).not.toContain('up to');
  });

  it('never says "Uploading" — the payload left the Renderer when send resolved', () => {
    const line = composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds: 3,
      budgetMs: 75_000,
      attachmentCount: 2,
      attachmentBytes: 1024,
    });
    expect(line.toLowerCase()).not.toContain('upload');
  });

  it('never claims the payload was sent while the handshake is still running', () => {
    // ensureHost -> closeSession -> createSession can burn seconds before
    // chat.send is even called; "Sent 152 KB" there would be a lie that a
    // createSession timeout immediately contradicts.
    const line = composerSendingLine({
      phase: 'handshake',
      elapsedSeconds: 3,
      budgetMs: 75_000,
      attachmentCount: 1,
      attachmentBytes: 155_648,
    });
    expect(line).toBe('Starting Agent Host… · 3s');
    expect(line).not.toContain('Sent');
  });

  it('keeps the handshake wording even past the slow threshold', () => {
    expect(
      composerSendingLine({
        phase: 'handshake',
        elapsedSeconds: 61,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      })
    ).toBe('Starting Agent Host… · 61s');
  });

  // a1 (2026-07-30 net-visibility batch): the CLI-side network retry counter
  // must appear ALONGSIDE the existing "waiting for reply" copy, not replace it.
  it('appends the retry counter to the text-only waiting line without dropping the base copy', () => {
    expect(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 12,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
        retry: { attempt: 3, maxRetries: 10 },
      })
    ).toBe('Waiting for Agent Host reply · Retry 3/10 · 12s (up to 45s)');
  });

  it('appends the retry counter to the attachment-in-flight line too', () => {
    expect(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 31,
        budgetMs: 75_000,
        attachmentCount: 1,
        attachmentBytes: 155_648,
        retry: { attempt: 1, maxRetries: 10 },
      })
    ).toBe('Sent 152.0 KB · waiting for reply · Retry 1/10 · 31s (up to 75s)');
  });

  it('still appends the retry counter past the slow-wait threshold', () => {
    const line = composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds: 62,
      budgetMs: 115_000,
      attachmentCount: 0,
      attachmentBytes: 0,
      retry: { attempt: 7, maxRetries: 10 },
    });
    expect(line).toBe('Still waiting · 62s · Retry 7/10 — gateway latency varies. Stop to abort.');
  });

  it('omits the retry suffix entirely when retry is absent or null', () => {
    const withoutField = composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds: 5,
      budgetMs: 45_000,
      attachmentCount: 0,
      attachmentBytes: 0,
    });
    const withNull = composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds: 5,
      budgetMs: 45_000,
      attachmentCount: 0,
      attachmentBytes: 0,
      retry: null,
    });
    expect(withoutField).not.toContain('· Retry');
    expect(withNull).not.toContain('· Retry');
    expect(withoutField).toBe(withNull);
  });

  it('never shows the retry counter during the handshake phase', () => {
    const line = composerSendingLine({
      phase: 'handshake',
      elapsedSeconds: 3,
      budgetMs: 45_000,
      attachmentCount: 0,
      attachmentBytes: 0,
      retry: { attempt: 1, maxRetries: 10 },
    });
    expect(line).toBe('Starting Agent Host… · 3s');
    expect(line).not.toContain('· Retry');
  });
});

describe('shouldRenderThumbnail (T-18 chip preview budget)', () => {
  it('previews a small pasted screenshot', () => {
    expect(shouldRenderThumbnail(draft({ byteLength: 40_960 }))).toBe(true);
  });

  it('takes the boundary as inclusive', () => {
    expect(shouldRenderThumbnail(draft({ byteLength: THUMBNAIL_MAX_BYTES }))).toBe(true);
    expect(shouldRenderThumbnail(draft({ byteLength: THUMBNAIL_MAX_BYTES + 1 }))).toBe(false);
  });

  it('falls back to an icon for images near the 5 MB cap', () => {
    // A data: URI is decoded at natural size before being rastered into 16 CSS
    // pixels, so a 5 MB / 8000x8000 image would pin ~256 MB of RGBA per chip.
    expect(shouldRenderThumbnail(draft({ byteLength: 5 * 1024 * 1024 }))).toBe(false);
  });

  it('never previews text drafts or empty data', () => {
    expect(shouldRenderThumbnail(draft({ kind: 'text', byteLength: 100 }))).toBe(false);
    expect(shouldRenderThumbnail(draft({ byteLength: 100, data: '' }))).toBe(false);
  });
});

describe('formatSkipNotice (T-18 B3)', () => {
  it('returns null when nothing was skipped', () => {
    expect(formatSkipNotice([])).toBeNull();
  });

  it('passes a single reason through verbatim', () => {
    expect(formatSkipNotice(['"a.zip" is not supported.'])).toEqual({
      tone: 'warning',
      message: '"a.zip" is not supported.',
    });
  });

  it('folds several reasons into one inline notice', () => {
    const notice = formatSkipNotice(['"a.zip" no.', '"b.txt" empty.']);
    expect(notice?.tone).toBe('warning');
    expect(notice?.message).toBe('2 attachments skipped: "a.zip" no. "b.txt" empty.');
  });
});
