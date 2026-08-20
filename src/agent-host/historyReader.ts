/**
 * Host-side JSONL session history reader (C-06).
 * Locates `~/.claude/projects/<munged-cwd>/<runtimeIdentity>.jsonl`, parses it
 * tolerantly, and digests it into `HistoryMessage[]` for the `session.history`
 * batch event / `session.listHistory` command.
 *
 * Standalone Host bundle: only Node builtins + src/shared/types are allowed
 * here (no src/main/** or src/renderer/** imports — Host ships as an
 * independent process/bundle).
 *
 * See docs/plans/2026-07-24-c06-session-history-protocol-draft.md §2 / §5.
 */

import type { Dirent } from 'node:fs';
import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  HistoryAttachment,
  HistoryBlock,
  HistoryMessage,
  HistoryParseStats,
  HistoryReadError,
  HistorySessionSummary,
} from '../shared/types/sessionHistory.ts';
import { HISTORY_MESSAGE_ID_PREFIX } from '../shared/types/sessionHistory.ts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReadSessionHistoryOptions {
  workspacePath: string;
  runtimeIdentity: string;
  /** Test override; defaults to process.env.CLAUDE_CONFIG_DIR || ~/.claude */
  claudeConfigDir?: string;
}

export interface HistoryReadResult {
  messages: HistoryMessage[];
  truncated: boolean;
  omittedCount: number;
  parseStats: HistoryParseStats;
  error?: HistoryReadError;
}

export interface ListSessionHistoryOptions {
  workspacePath: string;
  claudeConfigDir?: string;
}

export interface HistoryListResult {
  sessions: HistorySessionSummary[];
  error?: HistoryReadError;
}

/** Read and digest a single session's JSONL into a chronological message timeline. Never throws. */
export async function readSessionHistory(
  opts: ReadSessionHistoryOptions
): Promise<HistoryReadResult> {
  const emptyStats: HistoryParseStats = { totalLines: 0, controlLines: 0, badLines: 0 };
  try {
    const projectsDir = getProjectsDir(opts.claudeConfigDir);
    const filePath = await locateSessionFile(projectsDir, opts.workspacePath, opts.runtimeIdentity);
    if (!filePath) {
      return {
        messages: [],
        truncated: false,
        omittedCount: 0,
        parseStats: emptyStats,
        error: {
          code: 'jsonl_not_found',
          message: `No session JSONL found for runtimeIdentity "${opts.runtimeIdentity}" under ${projectsDir}`,
        },
      };
    }

    const head = await peekHeader(filePath, TSD_MAGIC.length);
    if (isTsdEncryptedHead(head)) {
      return {
        messages: [],
        truncated: false,
        omittedCount: 0,
        parseStats: emptyStats,
        error: {
          code: 'encrypted_unreadable',
          message: `Session file appears TSD-encrypted and unreadable by this Host process: ${filePath}`,
        },
      };
    }

    return await digestHistoryFile(filePath);
  } catch (err) {
    return {
      messages: [],
      truncated: false,
      omittedCount: 0,
      parseStats: emptyStats,
      error: { code: 'read_failed', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** List historical CC sessions for a workspace (candidate-directory scan only). Never throws. */
export async function listSessionHistory(
  opts: ListSessionHistoryOptions
): Promise<HistoryListResult> {
  try {
    const projectsDir = getProjectsDir(opts.claudeConfigDir);

    let rootDirents: Dirent[];
    try {
      rootDirents = await readdir(projectsDir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return { sessions: [] };
      throw err;
    }

    const mungedTarget = mungeCwd(opts.workspacePath);
    const candidate = rootDirents.find(
      (d) => d.isDirectory() && dirNameMatches(d.name, mungedTarget)
    );
    if (!candidate) return { sessions: [] };

    const candidateDir = path.join(projectsDir, candidate.name);
    let fileDirents: Dirent[];
    try {
      fileDirents = await readdir(candidateDir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return { sessions: [] };
      throw err;
    }

    const fileNames = fileDirents
      .filter((d) => d.isFile() && isSessionJsonlFile(d.name))
      .map((d) => d.name);

    const targetNorm = normalizePathForCompare(opts.workspacePath);
    const summaries: HistorySessionSummary[] = [];

    for (const fileName of fileNames) {
      const filePath = path.join(candidateDir, fileName);

      const head = await peekHeader(filePath, TSD_MAGIC.length);
      if (isTsdEncryptedHead(head)) {
        // TSD encryption is a machine/process-wide property (whichever agent
        // encrypts Node-written files does so for all of them) — one hit means
        // this Host process cannot trust any file under this workspace, so we
        // abort the whole listing rather than silently return a partial one.
        return {
          sessions: [],
          error: {
            code: 'encrypted_unreadable',
            message: `Session file appears TSD-encrypted and unreadable by this Host process: ${filePath}`,
          },
        };
      }

      const info = await readSummaryHeader(filePath);
      if (!info.cwd || normalizePathForCompare(info.cwd) !== targetNorm) continue;

      summaries.push({
        runtimeIdentity: path.basename(fileName, '.jsonl'),
        workspacePath: opts.workspacePath,
        title: info.title,
        firstMessage: info.firstMessage,
        createdAt: info.createdAt,
        lastMessageAt: info.lastMessageAt,
        model: info.model,
      });
    }

    summaries.sort(
      (a, b) =>
        (b.lastMessageAt ?? Number.NEGATIVE_INFINITY) -
        (a.lastMessageAt ?? Number.NEGATIVE_INFINITY)
    );
    return { sessions: summaries };
  } catch (err) {
    return {
      sessions: [],
      error: { code: 'read_failed', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// Caps (§5.4) — exported so tests can assert against the real thresholds
// instead of duplicating magic numbers.
// ---------------------------------------------------------------------------

/** Input files larger than this are read from the tail only. */
export const HISTORY_INPUT_TAIL_LIMIT_BYTES = 32 * 1024 * 1024;
/** Max chars kept for a single user text block. */
export const HISTORY_USER_TEXT_CAP_CHARS = 64 * 1024;
/** Max chars kept for assistant text / thinking / tool input / tool output blocks. */
export const HISTORY_BLOCK_TEXT_CAP_CHARS = 16 * 1024;
/** Max digested messages kept (ring-buffer, oldest evicted first). */
export const HISTORY_MAX_MESSAGES = 1000;
/** Approximate serialized-size budget for the whole digested message array. */
export const HISTORY_OUTPUT_BUDGET_CHARS = 8 * 1024 * 1024;

const HEADER_LINE_LIMIT = 300;
const SUMMARY_TAIL_WINDOW_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// TSD encryption detection
// ---------------------------------------------------------------------------

// Mirrors src/main/utils/tsdSafeRead.ts TSD_MAGIC. Duplicated (not imported)
// because the Host bundle must stay independent of src/main/**.
// TEC Solutions OCular Agent (TSD) encrypts files written by Node.js processes
// on some Windows machines; a non-whitelisted process reading such a file sees
// this header instead of JSON. We detect it and report explicitly rather than
// silently returning an empty history.
const TSD_MAGIC = Buffer.from('%TSD-Header-###%');

function isTsdEncryptedHead(head: Buffer): boolean {
  if (head.length < TSD_MAGIC.length) return false;
  return head.compare(TSD_MAGIC, 0, TSD_MAGIC.length, 0, TSD_MAGIC.length) === 0;
}

async function peekHeader(filePath: string, length: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Path helpers (§5.1)
// ---------------------------------------------------------------------------

function getProjectsDir(claudeConfigDir?: string): string {
  const base = claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  return path.join(base, 'projects');
}

/** Forward munge: every non-alphanumeric char becomes `-` (verified against real project dirs). */
function mungeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const IS_WIN32 = process.platform === 'win32';

/** Directory-name comparison: case-insensitive on win32 only (POSIX filesystems are case-sensitive). */
function dirNameMatches(dirName: string, mungedTarget: string): boolean {
  return IS_WIN32 ? dirName.toLowerCase() === mungedTarget.toLowerCase() : dirName === mungedTarget;
}

/** Path comparison for cwd validation: case-insensitive + backslash-normalized on win32 only. */
function normalizePathForCompare(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, '');
  if (IS_WIN32) return trimmed.replace(/\\/g, '/').toLowerCase();
  return trimmed;
}

function isSessionJsonlFile(fileName: string): boolean {
  return fileName.endsWith('.jsonl') && !fileName.startsWith('agent-');
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function isExistingFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Locate `<runtimeIdentity>.jsonl` for resume:
 * 1) munge workspacePath -> candidate dir (case-insensitive dir-name match);
 * 2) miss -> scan every project dir for a file with this exact name (isFile filtered).
 */
async function locateSessionFile(
  projectsDir: string,
  workspacePath: string,
  runtimeIdentity: string
): Promise<string | null> {
  const targetFileName = `${runtimeIdentity}.jsonl`;

  let rootDirents: Dirent[];
  try {
    rootDirents = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const projectDirs = rootDirents.filter((d) => d.isDirectory());

  const mungedTarget = mungeCwd(workspacePath);
  const candidate = projectDirs.find((d) => dirNameMatches(d.name, mungedTarget));
  if (candidate) {
    const candidatePath = path.join(projectsDir, candidate.name, targetFileName);
    if (await isExistingFile(candidatePath)) return candidatePath;
  }

  for (const dir of projectDirs) {
    if (candidate && dir.name === candidate.name) continue; // already checked above
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(projectsDir, dir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    const match = entries.find((e) => e.isFile() && e.name === targetFileName);
    if (match) return path.join(projectsDir, dir.name, match.name);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Byte-range reads (input-side 32MB tail cap + listHistory 64KB tail window)
// ---------------------------------------------------------------------------

async function readExact(filePath: string, length: number, position: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let readTotal = 0;
    while (readTotal < length) {
      const { bytesRead } = await handle.read(
        buffer,
        readTotal,
        length - readTotal,
        position + readTotal
      );
      if (bytesRead === 0) break;
      readTotal += bytesRead;
    }
    return readTotal === length ? buffer : buffer.subarray(0, readTotal);
  } finally {
    await handle.close();
  }
}

async function readTailBytes(filePath: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(filePath);
  const length = Math.min(info.size, maxBytes);
  const position = info.size - length;
  return readExact(filePath, length, position);
}

// ---------------------------------------------------------------------------
// Line sources: full stream (<=32MB) vs tail-only (>32MB, §5.4)
// ---------------------------------------------------------------------------

interface LineSource {
  iterate(): AsyncIterable<string>;
  close(): void;
}

function openStreamLines(filePath: string): LineSource {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  let closed = false;
  return {
    iterate: async function* () {
      let buf = '';
      for await (const chunk of stream) {
        buf += chunk as string;
        let idx = buf.indexOf('\n');
        while (idx !== -1) {
          yield buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          idx = buf.indexOf('\n');
        }
      }
      if (buf.length > 0) yield buf.replace(/\r$/, '');
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        stream.destroy();
      } catch {
        // ignore
      }
    },
  };
}

async function openTailLines(filePath: string, size: number): Promise<LineSource> {
  const length = Math.min(size, HISTORY_INPUT_TAIL_LIMIT_BYTES);
  const position = size - length;
  const buffer = await readExact(filePath, length, position);
  const text = buffer.toString('utf-8');
  // The tail window can start mid-line (and mid multi-byte char); drop
  // everything up to and including the first newline so we never emit a
  // truncated leading residual line.
  const firstNewline = text.indexOf('\n');
  const body = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  const lines = body.split('\n');
  return {
    iterate: () =>
      (async function* () {
        for (const line of lines) yield line;
      })(),
    close: () => {
      // No handle to release for the in-memory tail path.
    },
  };
}

// ---------------------------------------------------------------------------
// JSONL line shapes (loose — tolerant parsing per §5.2)
// ---------------------------------------------------------------------------

interface JsonlContentItem {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  /** `image` / `document` blocks: `{ type: 'base64'|'text', media_type, data }`. */
  source?: unknown;
  /** `document` blocks: the display filename this Host puts there. */
  title?: string;
}

interface JsonlMessage {
  role?: string;
  model?: string;
  content?: JsonlContentItem[] | string;
}

interface JsonlEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  cwd?: string;
  timestamp?: number | string;
  isMeta?: boolean;
  isSidechain?: boolean;
  attachment?: unknown;
  aiTitle?: string;
  message?: JsonlMessage;
}

/** Known control-record types (§5.2 table) — skipped, counted as controlLines. */
const CONTROL_LINE_TYPES = new Set<string>([
  'mode',
  'permission-mode',
  'last-prompt',
  'file-history-snapshot',
  'queue-operation',
  'ai-title',
  'file-history-delta',
  'attribution-snapshot',
  'summary',
]);

// ---------------------------------------------------------------------------
// Text helpers (self-contained mirrors of ClaudeSessionScanner precedent —
// not imported, since Host must not depend on src/main/**)
// ---------------------------------------------------------------------------

/** Strip known Claude Code system/command wrapper tags, returning only user-authored text. */
function stripSystemTags(text: string): string {
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

/** Extract slash-command name from system tags as a display fallback. */
function extractCommandLabel(text: string): string | null {
  const match = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  return match ? `/${match[1].trim()}` : null;
}

/** Extract raw user text from a message.content (string or text[] blocks); null if none. */
function extractUserTextBlocks(content: unknown): string | null {
  if (typeof content === 'string') {
    const text = content.trim();
    return text || null;
  }
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((c): c is JsonlContentItem => !!c && typeof c === 'object')
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim();
  return text || null;
}

function truncatePreview(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}…`;
}

/** Parse a JSONL timestamp (ISO string or numeric epoch) to epoch ms. */
function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: values larger than ~2001-09-09 in ms are already ms.
    if (value > 1_000_000_000_000) return Math.floor(value);
    if (value > 0) return Math.floor(value * 1000);
    return null;
  }
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const block = item as { type?: string; text?: string; tool_name?: string };
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'tool_reference' && typeof block.tool_name === 'string') {
          return `[tool_reference:${block.tool_name}]`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function capInput(input: unknown, maxChars: number): { input: unknown; truncated: boolean } {
  if (input === undefined) return { input: undefined, truncated: false };
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? '';
  } catch {
    serialized = String(input);
  }
  if (serialized.length <= maxChars) return { input, truncated: false };
  return { input: serialized.slice(0, maxChars), truncated: true };
}

// ---------------------------------------------------------------------------
// Attachment metadata recovery (2026-08-10, §5.2 revision)
//
// Two independent carriers, because the transcript has two producers:
//
//  A. THIS app. `claudeRuntime.buildPromptWithAttachments` sends attachments
//     as Anthropic content blocks inside one SDK user message (`image` with a
//     base64 source, `document` with a text source + `title`), and the CLI
//     records that message verbatim. So an ai-client image turn lives in the
//     `type: 'user'` line's OWN `message.content` — this is the carrier that
//     actually fixes "cold restart drops the image chip".
//  B. A standalone `attachment` control record adjacent to the user line.
//     Verified 2026-08-10 against every such record on a real machine: 22
//     subtypes (task_reminder / skill_listing / file / directory /
//     hook_success / …), not one carrying `kind` or a media type — they are
//     context injections, not user attachments. `extractControlAttachment`
//     is therefore INERT on today's Claude Code output by construction; it
//     exists so a build that does write user attachments this way still
//     produces a chip instead of silently dropping it.
//
// Metadata only in both cases: `source.data` (the base64 bytes) is never
// touched, so this adds no IO and no new permission surface.
// ---------------------------------------------------------------------------

const IMAGE_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/** Last segment of a POSIX or Windows path — the chip shows a name, not a path. */
function baseName(value: string): string {
  const segments = value.split(/[\\/]/);
  return segments[segments.length - 1] || value;
}

/**
 * Fallback when the record states no media type. `mediaType` is required by
 * the wire shape (and doubles as the chip label when there is no name), so it
 * must always resolve to something — never to an empty string.
 */
function inferMediaType(name: string | undefined, kind: 'image' | 'text'): string {
  if (kind !== 'image') return 'text/plain';
  const ext = name?.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
  return (ext && IMAGE_EXTENSION_MEDIA_TYPES[ext]) || 'image/*';
}

/** Carrier A: `image` / `document` content blocks on the user line itself. */
function extractContentAttachments(content: unknown): HistoryAttachment[] {
  if (!Array.isArray(content)) return [];
  const attachments: HistoryAttachment[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as JsonlContentItem;
    if (item.type !== 'image' && item.type !== 'document') continue;
    const kind: 'image' | 'text' = item.type === 'image' ? 'image' : 'text';
    const source =
      item.source && typeof item.source === 'object'
        ? (item.source as { media_type?: unknown })
        : null;
    const declared =
      typeof source?.media_type === 'string' && source.media_type.trim()
        ? source.media_type.trim()
        : null;
    // Images get no name: this Host writes `title` on `document` blocks only,
    // and the Anthropic image block has nowhere to put a filename. The chip
    // then falls back to the media type ("image/png") — degraded on purpose,
    // and the reason a filename cannot be recovered for image turns.
    const name =
      typeof item.title === 'string' && item.title.trim() ? item.title.trim() : undefined;
    attachments.push({
      kind,
      mediaType: declared ?? inferMediaType(name, kind),
      ...(name ? { name } : {}),
    });
  }
  return attachments;
}

/**
 * Carrier B: a standalone `attachment` record, IF it describes a user
 * attachment. Anything without `kind: image|text` and without a media type is
 * not one (see the block comment above) and returns null, which keeps that
 * line skipped exactly as it was before this change.
 */
function extractControlAttachment(record: unknown): HistoryAttachment | null {
  if (!record || typeof record !== 'object') return null;
  const att = record as {
    kind?: unknown;
    mediaType?: unknown;
    media_type?: unknown;
    name?: unknown;
    filename?: unknown;
    path?: unknown;
  };

  const declaredRaw =
    typeof att.mediaType === 'string'
      ? att.mediaType
      : typeof att.media_type === 'string'
        ? att.media_type
        : null;
  const declared = declaredRaw?.trim() || null;

  let kind: 'image' | 'text';
  if (att.kind === 'image' || att.kind === 'text') {
    kind = att.kind;
  } else if (declared) {
    kind = declared.startsWith('image/') ? 'image' : 'text';
  } else {
    return null; // not a user attachment — a control record, as before.
  }

  const rawName = [att.name, att.filename, att.path].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  const name = rawName ? baseName(rawName.trim()) : undefined;
  return {
    kind,
    mediaType: declared ?? inferMediaType(name, kind),
    ...(name ? { name } : {}),
  };
}

// ---------------------------------------------------------------------------
// Digest: parse + merge + pair + cap (§5.2 / §5.3 / §5.4)
// ---------------------------------------------------------------------------

async function digestHistoryFile(filePath: string): Promise<HistoryReadResult> {
  const info = await stat(filePath);
  const inputTruncated = info.size > HISTORY_INPUT_TAIL_LIMIT_BYTES;
  const source = inputTruncated
    ? await openTailLines(filePath, info.size)
    : openStreamLines(filePath);

  let totalLines = 0;
  let controlLines = 0;
  let badLines = 0;

  // Ring buffer of finalized messages — capped as we go (never accumulate an
  // unbounded array before capping), plus a parallel size estimate per entry
  // so eviction can maintain a running total without re-stringifying everything.
  const messages: HistoryMessage[] = [];
  const sizes: number[] = [];
  let runningSize = 0;
  let omittedCount = 0;
  let outputTruncated = false;

  // In-progress assistant merge (spans consecutive assistant lines plus any
  // intervening pure-tool_result user lines — see §5.3).
  let currentMessage: HistoryMessage | null = null;
  let pairedToolCallIds = new Set<string>();
  let blockCounter = 0;

  // Attachment pairing (2026-08-10). Order tolerance is required because the
  // two plausible layouts disagree: real Claude Code writes `attachment`
  // records AFTER the user line they belong to (measured: prev-line = `user`
  // in the overwhelming majority), while the historic fixture assumption put
  // them before. So we support both, and only both.
  //  - `pendingAttachments`: seen before their user line, waiting to be claimed.
  //  - `lastUserMessage`: the user message a trailing record may still decorate.
  // Unclaimed either way = orphan = discarded. An attachment problem must
  // never cost a whole message ("only ever more, never less").
  let pendingAttachments: HistoryAttachment[] = [];
  let lastUserMessage: HistoryMessage | null = null;

  function estimateSize(msg: HistoryMessage): number {
    try {
      return JSON.stringify(msg).length;
    } catch {
      return 0;
    }
  }

  function pushMessage(msg: HistoryMessage): void {
    messages.push(msg);
    const size = estimateSize(msg);
    sizes.push(size);
    runningSize += size;
    while (messages.length > HISTORY_MAX_MESSAGES || runningSize > HISTORY_OUTPUT_BUDGET_CHARS) {
      messages.shift();
      runningSize -= sizes.shift() ?? 0;
      omittedCount += 1;
      outputTruncated = true;
    }
  }

  function closeCurrent(): void {
    if (currentMessage && currentMessage.blocks.length > 0) {
      pushMessage(currentMessage);
    }
    currentMessage = null;
    pairedToolCallIds = new Set();
    blockCounter = 0;
  }

  function startOrContinueAssistant(entry: JsonlEntry): HistoryMessage {
    if (currentMessage && currentMessage.role === 'assistant') return currentMessage;
    closeCurrent();
    const uuid =
      typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `synthetic-${totalLines}`;
    const msg: HistoryMessage = {
      id: `${HISTORY_MESSAGE_ID_PREFIX}${uuid}`,
      role: 'assistant',
      blocks: [],
    };
    const ts = parseTimestampMs(entry.timestamp);
    if (ts !== null) msg.timestamp = ts;
    const model = entry.message?.model;
    if (typeof model === 'string' && model.trim()) msg.model = model.trim();
    currentMessage = msg;
    blockCounter = 0;
    pairedToolCallIds = new Set();
    return msg;
  }

  /** Inject a tool_result into the matching open tool_call block. Returns false if orphaned. */
  function injectToolResult(item: JsonlContentItem): boolean {
    if (!currentMessage || currentMessage.role !== 'assistant') return false;
    const toolCallId = typeof item.tool_use_id === 'string' ? item.tool_use_id : null;
    if (!toolCallId || pairedToolCallIds.has(toolCallId)) return false;
    const idx = currentMessage.blocks.findIndex(
      (b) => b.type === 'tool_call' && b.toolCallId === toolCallId
    );
    if (idx === -1) return false;

    const isError = item.is_error === true;
    const rawOutput = stringifyToolResultContent(item.content);
    const capped = capText(rawOutput, HISTORY_BLOCK_TEXT_CAP_CHARS);
    const block: HistoryBlock = {
      type: 'tool_result',
      id: `${currentMessage.id}:${blockCounter++}`,
      toolCallId,
      ok: !isError,
      ...(isError ? { error: capped.text } : { output: capped.text }),
      ...(capped.truncated ? { truncated: true } : {}),
    };
    currentMessage.blocks.splice(idx + 1, 0, block);
    pairedToolCallIds.add(toolCallId);
    return true;
  }

  try {
    for await (const rawLine of source.iterate()) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      totalLines += 1;

      let entry: JsonlEntry;
      try {
        entry = JSON.parse(trimmed) as JsonlEntry;
      } catch {
        badLines += 1;
        continue;
      }
      if (!entry || typeof entry !== 'object') {
        badLines += 1;
        continue;
      }

      const type = entry.type;

      // "Adjacent" for a trailing attachment record means strictly adjacent:
      // only further attachment records may sit between a user line and the
      // records decorating it. Any other line closes that window.
      if (entry.attachment === undefined) lastUserMessage = null;

      if (typeof type === 'string' && CONTROL_LINE_TYPES.has(type)) {
        controlLines += 1;
        continue;
      }
      if (entry.attachment !== undefined) {
        // Still a controlLine for parseStats: even when claimed it never
        // becomes a message of its own, it only decorates one.
        controlLines += 1;
        const claimed = extractControlAttachment(entry.attachment);
        if (claimed) {
          if (lastUserMessage) {
            // Trailing record: its message is already in the ring buffer, so
            // decorate it in place. The running size estimate misses these few
            // dozen bytes — bounded, and far below the budget's resolution.
            lastUserMessage.attachments = [...(lastUserMessage.attachments ?? []), claimed];
          } else {
            pendingAttachments.push(claimed);
          }
        }
        continue;
      }
      if (entry.isMeta === true) {
        controlLines += 1;
        if (type === 'user') closeCurrent();
        continue;
      }
      if (entry.isSidechain === true) {
        controlLines += 1;
        continue;
      }
      if (type === 'system') {
        controlLines += 1;
        continue;
      }

      if (type === 'user') {
        const content = entry.message?.content;
        const items = Array.isArray(content) ? content : null;
        const toolResultItems = items ? items.filter((i) => i && i.type === 'tool_result') : [];

        if (items && toolResultItems.length > 0) {
          for (const item of toolResultItems) {
            if (!injectToolResult(item)) badLines += 1;
          }
          if (toolResultItems.length === items.length) continue; // pure tool_result: does not break merge
          closeCurrent(); // mixed text + tool_result: breaks merge before emitting the text portion
        } else {
          closeCurrent(); // plain user line always breaks merge, even if it yields no visible message
        }

        // Claim whatever arrived before this line; anything left unclaimed at
        // the next user line is an orphan and is dropped with it.
        const claimedAttachments = pendingAttachments;
        pendingAttachments = [];
        // Carrier A first — it is the authoritative one for turns this app sent.
        const attachments = [...extractContentAttachments(content), ...claimedAttachments];

        const raw = extractUserTextBlocks(content);
        const text = raw ? stripSystemTags(raw) || extractCommandLabel(raw) : null;

        // Emit when there is text OR an attachment. The attachment-only case
        // (an image sent with no prose) previously digested to nothing at all,
        // so a cold restart lost the entire turn rather than just its chip.
        if (text || attachments.length > 0) {
          const capped = text
            ? capText(text, HISTORY_USER_TEXT_CAP_CHARS)
            : { text: '', truncated: false };
          const uuid =
            typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `synthetic-${totalLines}`;
          const userMsg: HistoryMessage = {
            id: `${HISTORY_MESSAGE_ID_PREFIX}${uuid}`,
            role: 'user',
            blocks: text
              ? [
                  {
                    type: 'text',
                    id: `${HISTORY_MESSAGE_ID_PREFIX}${uuid}:0`,
                    text: capped.text,
                    ...(capped.truncated ? { truncated: true } : {}),
                  },
                ]
              : [],
            ...(attachments.length > 0 ? { attachments } : {}),
          };
          const ts = parseTimestampMs(entry.timestamp);
          if (ts !== null) userMsg.timestamp = ts;
          pushMessage(userMsg);
          lastUserMessage = userMsg;
        }
        continue;
      }

      if (type === 'assistant') {
        // An attachment record still unclaimed when the reply starts belongs
        // to no user message we can name — orphan, dropped.
        pendingAttachments = [];
        const rawContent = entry.message?.content;
        const items = Array.isArray(rawContent) ? rawContent : [];
        const msg = startOrContinueAssistant(entry);

        for (const item of items) {
          if (!item || typeof item !== 'object') continue;

          if (item.type === 'text' && typeof item.text === 'string') {
            const t = item.text.trim();
            if (!t) continue;
            const capped = capText(t, HISTORY_BLOCK_TEXT_CAP_CHARS);
            msg.blocks.push({
              type: 'text',
              id: `${msg.id}:${blockCounter++}`,
              text: capped.text,
              ...(capped.truncated ? { truncated: true } : {}),
            });
          } else if (item.type === 'thinking' && typeof item.thinking === 'string') {
            // signature is intentionally dropped — never carried into the protocol.
            const t = item.thinking.trim();
            if (!t) continue;
            const capped = capText(t, HISTORY_BLOCK_TEXT_CAP_CHARS);
            msg.blocks.push({
              type: 'thinking',
              id: `${msg.id}:${blockCounter++}`,
              text: capped.text,
              ...(capped.truncated ? { truncated: true } : {}),
            });
          } else if (
            item.type === 'tool_use' &&
            typeof item.id === 'string' &&
            typeof item.name === 'string'
          ) {
            const { input, truncated: inputTrunc } = capInput(
              item.input,
              HISTORY_BLOCK_TEXT_CAP_CHARS
            );
            msg.blocks.push({
              type: 'tool_call',
              id: `${msg.id}:${blockCounter++}`,
              toolCallId: item.id,
              name: item.name,
              ...(input !== undefined ? { input } : {}),
              ...(inputTrunc ? { truncated: true } : {}),
            });
          }
          // Unrecognized content item types (e.g. server_tool_use) are ignored —
          // the line itself parsed fine, so this is not a badLine.
        }
        continue;
      }

      // Unknown line type.
      badLines += 1;
    }
  } finally {
    source.close();
  }

  closeCurrent();

  return {
    messages,
    truncated: inputTruncated || outputTruncated,
    omittedCount,
    parseStats: { totalLines, controlLines, badLines },
  };
}

// ---------------------------------------------------------------------------
// listSessionHistory summary extraction (§5.7)
// ---------------------------------------------------------------------------

interface SummaryHeaderInfo {
  cwd: string | null;
  title: string | null;
  firstMessage: string | null;
  model: string | null;
  createdAt: number | null;
  lastMessageAt: number | null;
}

async function readSummaryHeader(filePath: string): Promise<SummaryHeaderInfo> {
  let cwd: string | null = null;
  let title: string | null = null;
  let firstMessage: string | null = null;
  let commandFallback: string | null = null;
  let model: string | null = null;
  let createdAt: number | null = null;

  const source = openStreamLines(filePath);
  let lineIndex = 0;
  try {
    for await (const rawLine of source.iterate()) {
      lineIndex += 1;
      if (lineIndex > HEADER_LINE_LIMIT) break;
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      let entry: JsonlEntry;
      try {
        entry = JSON.parse(trimmed) as JsonlEntry;
      } catch {
        continue;
      }

      if (cwd === null && typeof entry.cwd === 'string' && entry.cwd.trim()) {
        cwd = entry.cwd.trim();
      }
      if (
        title === null &&
        entry.type === 'ai-title' &&
        typeof entry.aiTitle === 'string' &&
        entry.aiTitle.trim()
      ) {
        title = entry.aiTitle.trim();
      }
      if (createdAt === null) {
        const ts = parseTimestampMs(entry.timestamp);
        if (ts !== null) createdAt = ts;
      }
      if (model === null && entry.type === 'assistant') {
        const m = entry.message?.model;
        if (typeof m === 'string' && m.trim()) model = m.trim();
      }
      if (firstMessage === null && entry.type === 'user') {
        const raw = extractUserTextBlocks(entry.message?.content);
        if (raw) {
          const cleaned = stripSystemTags(raw);
          if (cleaned) {
            firstMessage = truncatePreview(cleaned, 80);
          } else if (commandFallback === null) {
            commandFallback = extractCommandLabel(raw);
          }
        }
      }
    }
  } finally {
    source.close();
  }

  const lastMessageAt = await readLastTimestampFromTail(filePath);

  return {
    cwd,
    title,
    firstMessage: firstMessage ?? commandFallback,
    model,
    createdAt,
    lastMessageAt,
  };
}

async function readLastTimestampFromTail(filePath: string): Promise<number | null> {
  const buffer = await readTailBytes(filePath, SUMMARY_TAIL_WINDOW_BYTES);
  const lines = buffer.toString('utf-8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(trimmed) as JsonlEntry;
    } catch {
      continue; // may be a partial line at the start of the tail window
    }
    const ts = parseTimestampMs(entry.timestamp);
    if (ts !== null) return ts;
  }
  return null;
}
