/**
 * T-18 Composer attachments — pure helpers (no DOM, no IO).
 *
 * vitest runs in a node environment and only collects `.ts`, so every decision
 * that needs regression cover lives here; the component and the hook keep only
 * the File / DataTransfer plumbing.
 *
 * §12 verification first: __tests__/attachments.test.ts.
 */
import type { ChatSendAttachment } from '@/stores/chatSessions';
import { formatCharCount, formatTokenCount } from './countFormat';

export type AttachmentKind = 'image' | 'text';

/** One pending attachment held by the Composer until the send succeeds. */
export interface AttachmentDraft {
  id: string;
  kind: AttachmentKind;
  /** Wire media type: one of the four API image types, or `text/plain`. */
  mediaType: string;
  /** Display name; may be '' for clipboard bitmaps without a file name. */
  name: string;
  /** RAW source bytes (pre-base64). Drives limits and the send timeout. */
  byteLength: number;
  /** image: base64 with no `data:` prefix. text: the decoded text itself. */
  data: string;
}

export interface AttachmentTypeMatch {
  kind: AttachmentKind;
  mediaType: string;
}

/**
 * The only image media types the API accepts. Anything else (bmp / tiff /
 * heic / avif …) must be rejected — the request fails with
 * invalid_request_error, so guessing is strictly worse than saying no.
 */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  'image/gif': 'image/gif',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * Extensions that are certainly not text. The list is deliberately short: an
 * unknown extension falls through to text and is caught later by
 * isProbablyBinary(), which reads the actual bytes.
 */
const BINARY_EXTENSIONS = new Set([
  '7z',
  'avif',
  'bin',
  'bmp',
  'class',
  'dat',
  'db',
  'dll',
  'dmg',
  'doc',
  'docx',
  'dylib',
  'eot',
  'exe',
  'gz',
  'heic',
  'heif',
  'ico',
  'iso',
  'jar',
  'mov',
  'mp3',
  'mp4',
  'odt',
  'otf',
  'pdf',
  'ppt',
  'pptx',
  'psd',
  'rar',
  'so',
  'sqlite',
  'tar',
  'tif',
  'tiff',
  'ttf',
  'wasm',
  'wav',
  'webm',
  'woff',
  'woff2',
  'xls',
  'xlsx',
  'zip',
  'zst',
]);

const BINARY_MEDIA_TYPES = new Set([
  'application/gzip',
  'application/java-archive',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/x-7z-compressed',
  'application/x-msdownload',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/x-zip-compressed',
  'application/zip',
]);

/** Lowercase, parameter-free media type (`text/plain;charset=utf-8` → `text/plain`). */
function normalizeMediaType(mimeType: string | undefined): string {
  if (!mimeType) return '';
  const [base] = mimeType.split(';');
  return base.trim().toLowerCase();
}

/** Lowercase extension without the dot; '' when the name has none. */
function fileExtension(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Decide how a pasted file should travel on the wire, or null when the
 * protocol cannot carry it (zip / pdf / unsupported image codecs).
 *
 * Two hard rules encoded here:
 * - text attachments are always normalised to `text/plain`. The API document
 *   block with `source:{type:'text'}` only accepts text/plain, and Renderer
 *   values reach the API verbatim (the Host default never kicks in).
 * - image media types are whitelisted to the four the API supports, with the
 *   extension used as a fallback because File.type is often '' on Windows.
 */
export function detectAttachmentKind(
  fileName: string,
  mimeType: string | undefined
): AttachmentTypeMatch | null {
  const mime = normalizeMediaType(mimeType);
  const ext = fileExtension(fileName);

  // SVG is markup, not a supported image media type — carry it as text.
  if (mime === 'image/svg+xml' || ext === 'svg') {
    return { kind: 'text', mediaType: 'text/plain' };
  }

  const byMime = IMAGE_MEDIA_TYPES[mime];
  if (byMime) return { kind: 'image', mediaType: byMime };

  const byExtension = IMAGE_EXTENSIONS[ext];
  if (byExtension) return { kind: 'image', mediaType: byExtension };

  // An image the API cannot decode — never smuggle it through as text.
  if (mime.startsWith('image/')) return null;

  if (BINARY_EXTENSIONS.has(ext)) return null;
  if (BINARY_MEDIA_TYPES.has(mime)) return null;
  if (mime.startsWith('audio/') || mime.startsWith('video/') || mime.startsWith('font/')) {
    return null;
  }

  return { kind: 'text', mediaType: 'text/plain' };
}

/** 32 KiB per chunk keeps the argument list far below any engine limit. */
const B64_CHUNK_BYTES = 0x8000;

/**
 * Encode raw bytes as standard base64 (no line breaks, no `data:` prefix).
 *
 * Chunked on purpose: `String.fromCharCode(...bytes)` spreads every byte into
 * an argument and blows the stack past ~100k of them — i.e. small screenshots
 * pass and real ones crash. Line breaks are also forbidden: the API only takes
 * a continuous base64 string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += B64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + B64_CHUNK_BYTES);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Decode bytes as UTF-8 and strip a leading BOM. Non-fatal: invalid sequences
 * become U+FFFD, which isProbablyBinary() then catches.
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** NUL bytes or a high replacement-char ratio mean this is not really text. */
export function isProbablyBinary(text: string): boolean {
  if (text.includes('\u0000')) return true;
  if (text.length === 0) return false;
  let replacements = 0;
  for (const ch of text) {
    if (ch === '\uFFFD') replacements += 1;
  }
  return replacements / text.length > 0.02;
}

/** Total RAW bytes of the drafts — the input of every limit and the timeout. */
export function totalAttachmentBytes(drafts: ReadonlyArray<{ byteLength: number }>): number {
  let total = 0;
  for (const draft of drafts) total += draft.byteLength;
  return total;
}

/**
 * Last gate before the protocol: drop entries with empty data (the Host
 * rejects the WHOLE send when any attachment has `data === ''`), strip local
 * fields, and return undefined rather than [] so a text-only payload carries
 * no `attachments` key at all.
 */
export function toWireAttachments(
  drafts: ReadonlyArray<AttachmentDraft>
): ChatSendAttachment[] | undefined {
  const wire: ChatSendAttachment[] = [];
  for (const draft of drafts) {
    if (draft.data.length === 0) continue;
    wire.push({
      kind: draft.kind,
      mediaType: draft.mediaType,
      data: draft.data,
      ...(draft.name ? { name: draft.name } : {}),
    });
  }
  return wire.length > 0 ? wire : undefined;
}

/** Human readable size, matching the tiers already used elsewhere in the app. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentChip {
  kind: AttachmentKind;
  /** Middle-elided name for the chip body. */
  label: string;
  sizeLabel: string;
  /** Always the untouched name — the chip uses it as the tooltip. */
  title: string;
}

const DEFAULT_CHIP_LABEL_LENGTH = 28;

/** Middle elision that keeps the extension — it tells image from text apart. */
function elideMiddle(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  if (maxLength <= 1) return '…';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : '';
  const budget = maxLength - extension.length - 1;
  if (budget <= 0) return `${name.slice(0, maxLength - 1)}…`;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  const stem = name.slice(0, name.length - extension.length);
  const tailPart = tail > 0 ? stem.slice(stem.length - tail) : '';
  return `${name.slice(0, head)}…${tailPart}${extension}`;
}

/** View model for one chip — the component only renders what this returns. */
export function toAttachmentChip(
  draft: AttachmentDraft,
  maxLabelLength: number = DEFAULT_CHIP_LABEL_LENGTH
): AttachmentChip {
  return {
    kind: draft.kind,
    label: elideMiddle(draft.name, maxLabelLength),
    sizeLabel: formatAttachmentSize(draft.byteLength),
    title: draft.name,
  };
}

/**
 * First of TWO display thresholds (F456 §7.5-a). Past this many seconds the
 * waiting copy drops the verb and switches to `Still waiting`.
 *
 * No longer "turns warning": F2 raised the silence ceiling to ~300s, which made
 * a first token after 45s the ordinary shape of a long prompt rather than an
 * alarm. A warning colour that is on for minutes at a time is not a warning, so
 * `turnStatusToneClass` now leaves this tier on the head's own muted colour and
 * the tier is carried by wording alone (§7.5 ruling 1).
 *
 * Neither threshold is a TIMEOUT: crossing one aborts nothing, unbinds nothing
 * and changes no state. They only decide which sentence is on screen.
 */
export const SLOW_WAIT_HINT_SECONDS = 45;

/**
 * Second display threshold: past this the wait is outside any range this app
 * can honestly call usual, and the copy says exactly that (F456 §7.5-a).
 *
 * Declared beside `SLOW_WAIT_HINT_SECONDS` on purpose. `composerSendingLine`
 * and `deriveTurnStatus` both key their wording switch off these two constants
 * in the same order, which is what makes `kind` and copy unable to flip apart —
 * the invariant F2 §8.3 established for one threshold, now stated over two.
 *
 * The value is F2 §8.3's suggested one and has no measurement behind it. It is
 * a tunable and is registered as one (spec §10.2 Q6), not a derived constant.
 */
export const STALLED_HINT_SECONDS = 180;

/**
 * F456 §7.3: the rotating verb the ordinary waiting line opens with.
 *
 * All four selection rules, and what each is defending against:
 *
 *  1. Nothing here claims to know what the other end is DOING. In this branch
 *     no block has arrived by definition, so "Reading your files" would be a
 *     guess wearing the clothes of a fact — and naming tools is the tool rows'
 *     job, where the claim is backed by an event.
 *  2. Nothing predicts progress or a finish ("Almost there", "Nearly done").
 *     Same rule that retired the `(up to Ns)` clause, for the same reason: this
 *     surface has never been able to predict a finish time and must not imply
 *     it can.
 *  3. Nothing scolds ("Still nothing…"). The wait is not the user's doing.
 *  4. Every entry is an intransitive present participle. What they assert is
 *     that something is under way — the one fact this branch can actually
 *     witness (the request is demonstrably in flight: `sawUserEcho` and F2's
 *     liveness frames both prove it), as opposed to a claim about what the
 *     model is thinking.
 *
 * Frozen: the rotation's entire value is that a given second always shows the
 * same word, and a table a consumer could reorder would not have that property.
 */
export const VERBS = Object.freeze([
  'Pondering',
  'Percolating',
  'Ruminating',
  'Noodling',
  'Mulling',
  'Simmering',
  'Marinating',
  'Cogitating',
  'Deliberating',
  'Brewing',
  'Puzzling',
  'Contemplating',
] as const);

/**
 * Seconds each verb holds the line. Long enough to finish reading, short enough
 * that one wait is not a single frozen word.
 *
 * Load-bearing against the table's length: one wait spans
 * `[0, SLOW_WAIT_HINT_SECONDS)`, so it draws
 * `ceil(SLOW_WAIT_HINT_SECONDS / VERB_ROTATION_SECONDS)` verbs and must never
 * draw more than the table holds. `[F4-2]` asserts that ACROSS the two
 * constants, so raising the slow threshold — or shortening either the period or
 * the table — fails loudly instead of silently starting to repeat words, which
 * is not a degradation review would ever notice.
 */
export const VERB_ROTATION_SECONDS = 6;

/**
 * The verb for a given second. A pure function of `elapsedSeconds` and nothing
 * else: no `Math.random`, no clock read, no module state. That is what keeps
 * `composerSendingLine` truth-table assertable second by second, and `[F4-1]`
 * pins it with an interleaved `A -> B -> A` call rather than a repeat call,
 * which a cache or a counter would also survive.
 */
function waitingVerb(elapsedSeconds: number): string {
  return VERBS[Math.floor(elapsedSeconds / VERB_ROTATION_SECONDS) % VERBS.length];
}

/**
 * Where an in-flight send currently is.
 *
 * `handshake` covers ensureHost -> closeSession -> createSession -> waiting for
 * session.created (up to ~5s). Nothing has been transmitted yet, so the status
 * line must not claim it has — otherwise a createSession timeout contradicts a
 * line that just said "Sent 152 KB".
 */
export type SendPhase = 'handshake' | 'awaiting';

/**
 * Status line shown while a send is in flight. Deliberately never predicts a
 * finish time: measured latency is size-independent and swings ~8x day to day,
 * so a fake number would be worse than none. F456 §7.2 took that rule to its
 * conclusion and retired the `(up to Ns)` clause, which was a soft prediction
 * of exactly the kind this paragraph forbids.
 *
 * T-31 §3.2: the sole consumer is now the TURN HEAD (`turnStatus.ts`), not the
 * composer — this copy describes the turn in flight, so it renders with the
 * reply. The name is kept as-is: renaming would churn this function and its
 * two word-for-word assertions in `attachments.test.ts` for no behavior change,
 * and those assertions are exactly what stops the copy from being reimplemented
 * a second time downstream.
 */
export function composerSendingLine(input: {
  phase: SendPhase;
  elapsedSeconds: number;
  /**
   * F456 §7.2: ACCEPTED AND IGNORED. The `(up to Ns)` clause it used to print
   * was retired outright once F2 re-sourced this to a silence ceiling that
   * expressly does not end the turn — `up to N` reads as "you will have a
   * result by then", which is the one promise F2 stopped making.
   *
   * Kept on the signature rather than deleted, for the same reason
   * `shouldShowStatusLine` keeps its `sending` input: remove it and "passing a
   * budget cannot put a deadline on screen" stops being a statable proposition,
   * and `[F4-4]` is that proposition.
   */
  budgetMs: number;
  attachmentCount: number;
  attachmentBytes: number;
  /**
   * a1 (2026-07-30 net-visibility batch): the CLI's own transport-retry loop
   * is in progress for this turn (SessionRetryInfo, minus the fields the
   * status line has no room for). Appended alongside the existing "waiting"
   * copy rather than replacing it — the user still gets the familiar framing
   * ("waiting for reply") plus the one new fact that actually explains the
   * wait, instead of a wording swap that would make every prior screenshot
   * and design-doc reference stale.
   */
  retry?: { attempt: number; maxRetries: number } | null;
  /**
   * F456 §7.4: size of the prompt this turn sent, in CODE POINTS, snapshotted
   * at the commit point (`ChatComposer.tsx`). `0` — the fallback for a session
   * that was already running when this window opened and therefore has no
   * snapshot — omits the `↑` entirely rather than printing a truthful-looking
   * `↑ 0 chars` for a message that was certainly not empty.
   */
  promptChars?: number;
  /**
   * D33's live, ESTIMATED output-token count, forwarded from
   * `deriveTurnStatus`. Previously read only by the streaming branch; the wait
   * before the first block is exactly when "is anything coming back at all"
   * is the user's question, so it is answered here too.
   */
  outputTokensDisplay?: number | null;
}): string {
  const elapsed = Math.max(0, Math.floor(input.elapsedSeconds));
  if (input.phase === 'handshake') {
    return `Starting Agent Host… · ${elapsed}s`;
  }
  // Round-10 inspection ④: no "Network" here — this surface has no
  // errorStatus to discriminate transport failures from upstream 5xx (the
  // user's live case was an upstream 503), so the suffix stays cause-neutral.
  // The banner (retryBanner.ts), which does see the status, carries the
  // cause-specific wording.
  const retrySuffix = input.retry
    ? ` · Retry ${input.retry.attempt}/${input.retry.maxRetries}`
    : '';
  // The two wording tiers, in the same order `deriveTurnStatus` tests its two
  // kinds — same constants, same sequence, so a `kind` can never describe a
  // sentence other than the one that actually ran. Deeper tier first: they
  // overlap, and the more specific statement wins.
  if (elapsed >= STALLED_HINT_SECONDS) {
    // Every clause is checkable. "past the usual range" states only that a
    // threshold was crossed and predicts nothing. "no reply and no error yet"
    // is true by construction here: `hasBlocks` routes to `streaming` before
    // this point, and `failed` is a higher-priority kind of its own. The
    // threshold's NUMBER stays out of the copy — the constant owns it.
    return `Still waiting · ${elapsed}s${retrySuffix} — past the usual range; no reply and no error yet. Stop to abort.`;
  }
  if (elapsed >= SLOW_WAIT_HINT_SECONDS) {
    return `Still waiting · ${elapsed}s${retrySuffix} — gateway latency varies. Stop to abort.`;
  }
  const promptChars = Math.max(0, Math.floor(input.promptChars ?? 0));
  // The asymmetry in unit words is deliberate. `↑` is an exact figure the
  // renderer counted from text it holds, so labelling it costs nothing. `↓` is
  // the Host's mid-turn estimate, which `turnStatus.ts` states must never be
  // presented as an authoritative token count — appending a `tokens` unit would
  // raise precisely the air of authority that rule forbids. The two labels also
  // happen to keep the arrows apart at a glance.
  const sentCount = promptChars > 0 ? ` · ↑ ${formatCharCount(promptChars)} chars` : '';
  const replyCount =
    input.outputTokensDisplay != null ? ` · ↓ ${formatTokenCount(input.outputTokensDisplay)}` : '';
  const verb = waitingVerb(elapsed);
  if (input.attachmentCount > 0) {
    const size = formatAttachmentSize(input.attachmentBytes);
    return `${verb}…${sentCount}${replyCount} · Sent ${size}${retrySuffix} · ${elapsed}s`;
  }
  return `${verb}…${sentCount}${replyCount}${retrySuffix} · ${elapsed}s`;
}

/**
 * Byte budget for the 16px chip thumbnail.
 *
 * A `data:` URI makes the browser decode the image at its NATURAL size before
 * rastering it into 16 CSS pixels, so under the 5 MB / 8000x8000 caps a single
 * chip could pin ~256 MB of RGBA. Above the budget the chip falls back to the
 * plain image icon, which the design brief already lists as the alternative.
 */
export const THUMBNAIL_MAX_BYTES = 512 * 1024;

/** Whether a draft is cheap enough to preview inline rather than as an icon. */
export function shouldRenderThumbnail(
  draft: Pick<AttachmentDraft, 'kind' | 'byteLength' | 'data'>,
  maxBytes: number = THUMBNAIL_MAX_BYTES
): boolean {
  return draft.kind === 'image' && draft.data.length > 0 && draft.byteLength <= maxBytes;
}

export interface AttachmentNotice {
  tone: 'warning' | 'info';
  message: string;
}

/**
 * Fold every skip reason of one paste into a single inline notice — a toast
 * per file would both spam and disappear before the user can act.
 */
export function formatSkipNotice(skipped: readonly string[]): AttachmentNotice | null {
  if (skipped.length === 0) return null;
  if (skipped.length === 1) return { tone: 'warning', message: skipped[0] };
  return {
    tone: 'warning',
    message: `${skipped.length} attachments skipped: ${skipped.join(' ')}`,
  };
}
