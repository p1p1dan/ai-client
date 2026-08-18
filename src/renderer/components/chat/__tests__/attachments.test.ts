import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  SLOW_WAIT_HINT_SECONDS,
  STALLED_HINT_SECONDS,
  shouldRenderThumbnail,
  THUMBNAIL_MAX_BYTES,
  toAttachmentChip,
  totalAttachmentBytes,
  toWireAttachments,
  VERB_ROTATION_SECONDS,
  VERBS,
} from '../attachments';
import { stripComments } from './stripComments';

const CHAT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every module in this directory reachable from `entry` by relative import,
 * `entry` included. `[F4-5]` scans this set rather than one file: purity that
 * only holds for the entry point is purity a one-line move can escape.
 */
function localImportClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  const files: string[] = [];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    files.push(name);
    const source = readFileSync(path.join(CHAT_DIR, name), 'utf8');
    for (const match of source.matchAll(/from '\.\/([A-Za-z0-9_.-]+)'/g)) {
      queue.push(match[1].endsWith('.ts') ? match[1] : `${match[1]}.ts`);
    }
  }
  return files;
}

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

describe('composerSendingLine (T-18 B2 / F4 §7)', () => {
  /** The line's leading word, minus its trailing ellipsis — `Pondering… · …` -> `Pondering`. */
  function verbOf(line: string): string {
    return line.split(' ')[0].replace('…', '');
  }

  /** An ordinary text-only waiting line at `elapsed`, with nothing else varying. */
  function waitingAt(elapsedSeconds: number): string {
    return composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds,
      budgetMs: 45_000,
      attachmentCount: 0,
      attachmentBytes: 0,
    });
  }

  // Retired (F4 §7.2): the old pin was the whole sentence `Waiting for Agent
  // Host reply · 12s (up to 45s)`. Both halves of it are gone — the copy now
  // leads with a rotating verb, and the budget clause was retired outright
  // because F2 re-sourced `budgetMs` to a silence ceiling that explicitly does
  // NOT promise a finish time (`:309-312` here says a fake number is worse than
  // none). The proposition this replaces it with is the SHAPE of the line, so
  // the verb is free to rotate without churning an assertion every 6 seconds.
  it('leads the text-only waiting line with a verb, counts the prompt, and predicts nothing', () => {
    const line = composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds: 12,
      budgetMs: 45_000,
      attachmentCount: 0,
      attachmentBytes: 0,
      promptChars: 428,
    });
    expect(VERBS).toContain(verbOf(line));
    expect(line).toContain('↑ 428 chars');
    expect(line).toContain('· 12s');
    expect(line).not.toContain('up to');
  });

  // Retired for the same reason; the attachment fact itself is unchanged and
  // stays pinned word for word, because "Sent 152.0 KB" is the one claim on
  // this line that would be a lie if it drifted.
  it('still names the payload once attachments are in flight', () => {
    const line = composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds: 31,
      budgetMs: 75_000,
      attachmentCount: 1,
      attachmentBytes: 155_648,
      promptChars: 428,
    });
    expect(line).toContain('Sent 152.0 KB');
    expect(line).toContain('↑ 428 chars');
    expect(line).toContain('· 31s');
    expect(line).not.toContain('up to');
    expect(VERBS).toContain(verbOf(line));
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
    // Extended to the whole table (§7.7): one sampled second only proves the
    // verb that happened to be showing at 3s is clean. The rotation means every
    // entry reaches the screen, so every entry has to clear the same bar.
    for (const verb of VERBS) {
      expect(verb.toLowerCase(), verb).not.toContain('upload');
    }
  });

  it('never claims the payload was sent while the handshake is still running', () => {
    // ensureHost -> closeSession -> createSession can burn seconds before
    // chat.send is even called; "Sent 152 KB" there would be a lie that a
    // createSession timeout immediately contradicts. Same reason the verbs stay
    // out of this branch (§7.1): "Pondering" before the Host is even connected
    // is the same lie wearing a friendlier word.
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
    // Past the SECOND threshold too: the handshake test runs before either
    // tier, so a stalled handshake is still a handshake (§7.7).
    expect(
      composerSendingLine({
        phase: 'handshake',
        elapsedSeconds: STALLED_HINT_SECONDS + 1,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      })
    ).toBe(`Starting Agent Host… · ${STALLED_HINT_SECONDS + 1}s`);
  });

  // a1 (2026-07-30 net-visibility batch): the CLI-side network retry counter
  // must appear ALONGSIDE the existing waiting copy, not replace it. F4 changed
  // the base copy underneath it, so the pin moves from the sentence to the
  // proposition: the suffix is still there AND the base line is still intact.
  it('appends the retry counter to the text-only waiting line without dropping the base copy', () => {
    const line = composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds: 12,
      budgetMs: 45_000,
      attachmentCount: 0,
      attachmentBytes: 0,
      promptChars: 428,
      retry: { attempt: 3, maxRetries: 10 },
    });
    expect(line).toContain('· Retry 3/10');
    expect(VERBS).toContain(verbOf(line));
    expect(line).toContain('↑ 428 chars');
    expect(line).toContain('· 12s');
  });

  it('appends the retry counter to the attachment-in-flight line too', () => {
    const line = composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds: 31,
      budgetMs: 75_000,
      attachmentCount: 1,
      attachmentBytes: 155_648,
      retry: { attempt: 1, maxRetries: 10 },
    });
    expect(line).toContain('· Retry 1/10');
    expect(line).toContain('Sent 152.0 KB');
    expect(VERBS).toContain(verbOf(line));
    expect(line).toContain('· 31s');
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

  /**
   * `[F4-1]` The verb is a DETERMINISTIC function of `elapsedSeconds` — the one
   * property that keeps `composerSendingLine` pure and therefore truth-table
   * assertable at all (§7.3).
   *
   * `A -> B -> A` interleaved, not "same argument twice": two adjacent calls
   * returning the same thing is also what a module-level counter that happens
   * to land on the same index would do. Going away to a different second and
   * coming back is what a counter, a cache or a clock read cannot survive.
   */
  it('[F4-1] the verb is a pure function of elapsed seconds — A -> B -> A returns to A', () => {
    const a1 = waitingAt(0);
    const b = waitingAt(7);
    const a2 = waitingAt(0);
    expect(a2).toBe(a1);
    expect(verbOf(b)).not.toBe(verbOf(a1));

    // The whole reachable window, second by second: this is the fixed sequence
    // a user sees across one 45s wait, written out rather than recomputed from
    // the formula (a test that re-derives the formula proves only that two
    // copies of it agree).
    const sequence = Array.from({ length: SLOW_WAIT_HINT_SECONDS }, (_, second) =>
      verbOf(waitingAt(second))
    );
    expect(sequence).toEqual([
      'Pondering',
      'Pondering',
      'Pondering',
      'Pondering',
      'Pondering',
      'Pondering',
      'Percolating',
      'Percolating',
      'Percolating',
      'Percolating',
      'Percolating',
      'Percolating',
      'Ruminating',
      'Ruminating',
      'Ruminating',
      'Ruminating',
      'Ruminating',
      'Ruminating',
      'Noodling',
      'Noodling',
      'Noodling',
      'Noodling',
      'Noodling',
      'Noodling',
      'Mulling',
      'Mulling',
      'Mulling',
      'Mulling',
      'Mulling',
      'Mulling',
      'Simmering',
      'Simmering',
      'Simmering',
      'Simmering',
      'Simmering',
      'Simmering',
      'Marinating',
      'Marinating',
      'Marinating',
      'Marinating',
      'Marinating',
      'Marinating',
      'Cogitating',
      'Cogitating',
      'Cogitating',
    ]);

    // No exported mutable state: a frozen table cannot be reordered or extended
    // by a consumer, so the sequence above is a property of the module and not
    // of whatever ran before this test.
    expect(Object.isFrozen(VERBS)).toBe(true);
  });

  /**
   * `[F4-2]` A single wait never repeats a verb. The window is
   * `[0, SLOW_WAIT_HINT_SECONDS)` — past that the copy switches to
   * `Still waiting` and the rotation stops — so at most
   * `ceil(SLOW / ROTATION)` verbs are ever drawn from the table.
   *
   * Cross-module on purpose: if F2 (or anyone) raises the slow threshold, or
   * someone shortens the rotation or the table, THIS goes red rather than the
   * degradation being invisible ("the verbs started repeating" is not a thing
   * review notices).
   */
  it('[F4-2] one wait can never repeat a verb, whoever moves the thresholds', () => {
    const drawn = Math.ceil(SLOW_WAIT_HINT_SECONDS / VERB_ROTATION_SECONDS);
    expect(drawn).toBeLessThanOrEqual(VERBS.length);
    const seen = new Set(
      Array.from({ length: SLOW_WAIT_HINT_SECONDS }, (_, second) => verbOf(waitingAt(second)))
    );
    expect(seen.size).toBe(drawn);
  });

  /**
   * `[F4-3]` The two counters: presence, omission, ORDER and the actual values.
   *
   * The value half is what makes this load-bearing — an implementation that
   * hard-coded `↑ 1 chars · ↓ 1k` would satisfy every presence/order check.
   */
  it('[F4-3] the up/down counters appear, omit and format by their own inputs', () => {
    const bare = waitingAt(12);
    expect(bare).not.toContain('↑');
    expect(bare).not.toContain('↓');

    const both = composerSendingLine({
      phase: 'awaiting',
      elapsedSeconds: 12,
      budgetMs: 45_000,
      attachmentCount: 0,
      attachmentBytes: 0,
      promptChars: 428,
      outputTokensDisplay: 1800,
    });
    expect(both).toContain('↑ 428 chars');
    expect(both).toContain('↓ 1.8k');
    expect(both.indexOf('↑')).toBeLessThan(both.indexOf('↓'));

    // Both sides of the 1000 boundary for the token count, and the char count
    // keeps its unit word while the token count deliberately has none (§7.4).
    expect(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 12,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
        outputTokensDisplay: 850,
      })
    ).toContain('↓ 850');

    // A session already running when this window opened has no snapshot, so
    // `promptChars` falls back to 0 — which must read as "unknown", not as a
    // user who sent an empty prompt.
    expect(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 12,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
        promptChars: 0,
        outputTokensDisplay: null,
      })
    ).not.toContain('↑');
  });

  /**
   * `[F4-4]` `budgetMs` is accepted and ignored (§7.2). The parameter stays on
   * the signature precisely so this stays expressible: delete it and "passing a
   * budget cannot put a deadline on screen" becomes an unstatable proposition.
   *
   * The second half matters as much as the first: proving only that something
   * DISAPPEARED is also satisfied by a function that returns a constant, so the
   * same assertion re-confirms the six facts that must still be there.
   */
  it('[F4-4] budgetMs changes nothing, and the rest of the line is still there', () => {
    const args = {
      phase: 'awaiting' as const,
      elapsedSeconds: 31,
      attachmentCount: 1,
      attachmentBytes: 155_648,
      promptChars: 428,
      outputTokensDisplay: 1800,
      retry: { attempt: 3, maxRetries: 10 },
    };
    const cheap = composerSendingLine({ ...args, budgetMs: 45_000 });
    const generous = composerSendingLine({ ...args, budgetMs: 300_000 });
    expect(cheap).toBe(generous);
    expect(cheap).not.toContain('up to');
    expect(cheap).not.toContain('45');
    expect(cheap).not.toContain('300');
    // Six positives, in one assertion block, so "simplify the whole line to a
    // constant" cannot pass by deleting content this test only checks for.
    expect(VERBS).toContain(verbOf(cheap));
    expect(cheap).toContain('· 31s');
    expect(cheap).toContain('Sent 152.0 KB');
    expect(cheap).toContain('· Retry 3/10');
    expect(cheap).toContain('↑ 428 chars');
    expect(cheap).toContain('↓ 1.8k');
  });

  /**
   * `[F4-5]` No randomness or clock anywhere the copy can reach.
   *
   * Scanned over the LOCAL IMPORT CLOSURE, not just this module: the rotation's
   * purity is trivially escapable by moving `Math.random()` into a helper
   * `attachments.ts` imports (`countFormat.ts` is exactly such a helper and was
   * created by this batch), and a scan of one file would never see it.
   */
  it('[F4-5] neither attachments.ts nor anything it imports locally can read a clock or a die', () => {
    const closure = localImportClosure('attachments.ts');
    // The new helper is genuinely inside the scanned set — otherwise this test
    // passes by scanning nothing that changed.
    expect(closure).toContain('countFormat.ts');
    for (const file of closure) {
      const code = stripComments(readFileSync(path.join(CHAT_DIR, file), 'utf8'), file);
      for (const source of [
        'Math.random',
        'Date.now',
        'performance.now',
        'crypto.getRandomValues',
      ]) {
        expect(code, `${file} must not read ${source}`).not.toContain(source);
      }
    }
  });

  /**
   * `[F4-6]` The stalled tier has its OWN wording, keyed off its own constant.
   *
   * `kind` and copy may only ever flip together (`turnStatus.ts`'s own header
   * states the invariant). A second `kind` with the first tier's words would
   * break that by construction — which is why the copy below exists at all.
   * Both tiers keep `Stop to abort.`: the sentence names the one control that
   * is actually on screen, and it is load-bearing in BOTH.
   */
  it('[F4-6] the stalled tier reads differently from slow, and both keep "Stop to abort."', () => {
    const slow = waitingAt(STALLED_HINT_SECONDS - 1);
    const stalled = waitingAt(STALLED_HINT_SECONDS);
    expect(slow).toBe('Still waiting · 179s — gateway latency varies. Stop to abort.');
    expect(stalled).toBe(
      'Still waiting · 180s — past the usual range; no reply and no error yet. Stop to abort.'
    );
    expect(slow).toContain('Stop to abort.');
    expect(stalled).toContain('Stop to abort.');
    // No threshold number is ever written into the copy (§0.2) — "the usual
    // range" is the fact; the number that defines it stays in the constant.
    // Sampled away from the boundary, where the clock would supply a 180 of its
    // own and hide a hard-coded one.
    expect(waitingAt(200)).not.toContain('180');
    expect(SLOW_WAIT_HINT_SECONDS).toBeLessThan(STALLED_HINT_SECONDS);
  });

  /**
   * `[F4-8]` Word-table discipline (§7.3's four rules, in their assertable
   * part). Scoped to `VERBS` ONLY: `slow`/`stalled` both open with "Still
   * waiting", so a ban applied to the whole line would fail them by design.
   */
  it('[F4-8] every verb is a single neutral present participle, promising nothing', () => {
    for (const verb of VERBS) {
      expect(verb, verb).toMatch(/^[A-Z][a-z]+$/);
      for (const banned of ['upload', 'almost', 'nearly', 'still']) {
        expect(verb.toLowerCase(), verb).not.toContain(banned);
      }
    }
    expect(new Set(VERBS).size).toBe(VERBS.length);
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
