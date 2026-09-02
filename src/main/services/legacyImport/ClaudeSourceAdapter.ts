import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  type ImportedAssistantBlock,
  type ImportedAttachmentDiagnostic,
  type ImportedConversation,
  type ImportedConversationEntry,
  LEGACY_IMPORT_MAX_ENTRIES,
  LEGACY_IMPORT_MAX_LINE_CHARS,
  LEGACY_IMPORT_MAX_SOURCE_BYTES,
  LEGACY_IMPORT_MAX_TEXT_CHARS,
  LEGACY_IMPORT_MAX_TOOL_CHARS,
  LEGACY_IMPORT_SCHEMA_VERSION,
  LEGACY_IMPORTER_VERSION,
  type LegacyImportSourceFingerprint,
  type LegacyImportSourceRef,
} from '@shared/types';
import {
  isFileTsdEncrypted,
  readFileTsdSafeBounded,
  TsdFileTooLargeError,
} from '../../utils/tsdSafeRead';
import type { ClaudeSessionScanner, ClaudeSessionSource } from './ClaudeSessionScanner';

interface ClaudeContentItem {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: unknown;
  title?: string;
}

interface ClaudeJsonlEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: number | string;
  isMeta?: boolean;
  isSidechain?: boolean;
  attachment?: unknown;
  message?: {
    role?: string;
    model?: string;
    content?: ClaudeContentItem[] | string;
  };
}

interface SourceSnapshot extends LegacyImportSourceFingerprint {
  filePath: string;
  dev: number;
  ino: number;
}

export class ClaudeImportSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeImportSourceError';
  }
}

export interface ReadClaudeConversationResult {
  conversation: ImportedConversation;
  sourcePath: string;
}

const CONTROL_LINE_TYPES = new Set([
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

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function boundedText(text: string, max: number): { text: string; truncated?: true } {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), truncated: true };
}

const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|authorization|cookie|credential)/i;
const SECRET_TEXT =
  /(bearer\s+)[^\s]+|(sk-[A-Za-z0-9_-]{8,})|((?:api[_-]?key|token|password)\s*[:=]\s*)[^\s,;]+/gi;
const BASE64_LIKE = /^[A-Za-z0-9+/=_-]{512,}$/;

function sanitizeString(value: string): string {
  if (BASE64_LIKE.test(value)) return '[binary payload omitted]';
  return boundedText(
    value.replace(SECRET_TEXT, (_match, bearer, sk, assignment) => {
      if (bearer) return `${bearer}[redacted]`;
      if (sk) return '[redacted token]';
      return `${assignment ?? ''}[redacted]`;
    }),
    LEGACY_IMPORT_MAX_TOOL_CHARS
  ).text;
}

function sanitizeLegacyValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeLegacyValue(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeLegacyValue(item, depth + 1);
  }
  return output;
}

function boundedSanitizedValue(value: unknown): unknown {
  const sanitized = sanitizeLegacyValue(value);
  try {
    const serialized = JSON.stringify(sanitized) ?? '';
    return serialized.length <= LEGACY_IMPORT_MAX_TOOL_CHARS
      ? sanitized
      : '[sanitized payload truncated]';
  } catch {
    return '[unserializable payload omitted]';
  }
}

function sanitizedToolOutput(value: unknown): string {
  if (typeof value === 'string') return sanitizeString(value);
  try {
    return sanitizeString(JSON.stringify(sanitizeLegacyValue(value), null, 2) ?? '');
  } catch {
    return '[unserializable payload omitted]';
  }
}

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

function commandLabel(text: string): string | null {
  const match = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  return match ? `/${match[1].trim()}` : null;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const item = raw as ClaudeContentItem;
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    })
    .join('\n');
}

function attachmentDiagnostics(content: unknown): ImportedAttachmentDiagnostic[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as ClaudeContentItem;
    if (item.type !== 'image' && item.type !== 'document') return [];
    const source =
      item.source && typeof item.source === 'object'
        ? (item.source as { media_type?: unknown })
        : null;
    const mediaType =
      typeof source?.media_type === 'string' && source.media_type.trim()
        ? source.media_type.trim()
        : item.type === 'image'
          ? 'image/*'
          : 'text/plain';
    const name =
      typeof item.title === 'string' && item.title.trim() ? path.basename(item.title) : undefined;
    return [
      {
        kind: item.type === 'image' ? ('image' as const) : ('text' as const),
        mediaType,
        ...(name ? { name } : {}),
        reason: 'metadata-only' as const,
      },
    ];
  });
}

async function sha256File(filePath: string): Promise<string> {
  if (await isFileTsdEncrypted(filePath)) {
    const buffer = await readFileTsdSafeBounded(filePath, LEGACY_IMPORT_MAX_SOURCE_BYTES);
    return createHash('sha256').update(buffer).digest('hex');
  }
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > LEGACY_IMPORT_MAX_SOURCE_BYTES) {
        stream.destroy(
          new ClaudeImportSourceError('Claude session grew beyond the import size limit')
        );
        return;
      }
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function snapshotSource(source: ClaudeSessionSource): Promise<SourceSnapshot> {
  const info = await stat(source.filePath);
  if (!info.isFile()) {
    throw new ClaudeImportSourceError('Claude import source is not a regular file');
  }
  if (info.size > LEGACY_IMPORT_MAX_SOURCE_BYTES) {
    throw new ClaudeImportSourceError(
      `Claude session exceeds the ${LEGACY_IMPORT_MAX_SOURCE_BYTES}-byte import limit`
    );
  }
  const contentHash = await sha256File(source.filePath);
  const stableSourceIdentity = createHash('sha256')
    .update(path.normalize(path.resolve(source.filePath)))
    .digest('hex');
  return {
    filePath: source.filePath,
    stableSourceIdentity,
    contentHash,
    size: info.size,
    mode: info.mode,
    mtimeMs: info.mtimeMs,
    dev: info.dev,
    ino: info.ino,
  };
}

function assertSameSource(before: SourceSnapshot, after: SourceSnapshot): void {
  if (
    before.filePath !== after.filePath ||
    before.stableSourceIdentity !== after.stableSourceIdentity ||
    before.contentHash !== after.contentHash ||
    before.size !== after.size ||
    before.mode !== after.mode ||
    before.mtimeMs !== after.mtimeMs ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new ClaudeImportSourceError(
      'Claude session changed while it was being imported; retry the import step'
    );
  }
}

async function* sourceLines(filePath: string): AsyncIterable<string> {
  if (await isFileTsdEncrypted(filePath)) {
    const buffer = await readFileTsdSafeBounded(filePath, LEGACY_IMPORT_MAX_SOURCE_BYTES);
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      if (line.length > LEGACY_IMPORT_MAX_LINE_CHARS) {
        throw new ClaudeImportSourceError('Claude session contains an oversized JSONL line');
      }
      yield line;
    }
    return;
  }
  const stream = createReadStream(filePath);
  let bytes = 0;
  let pending = '';
  try {
    for await (const rawChunk of stream) {
      const chunk = rawChunk as Buffer;
      bytes += chunk.length;
      if (bytes > LEGACY_IMPORT_MAX_SOURCE_BYTES) {
        throw new ClaudeImportSourceError('Claude session grew beyond the import size limit');
      }
      pending += chunk.toString('utf8');
      if (pending.length > LEGACY_IMPORT_MAX_LINE_CHARS && !pending.includes('\n')) {
        throw new ClaudeImportSourceError('Claude session contains an oversized JSONL line');
      }
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        if (line.length > LEGACY_IMPORT_MAX_LINE_CHARS) {
          throw new ClaudeImportSourceError('Claude session contains an oversized JSONL line');
        }
        yield line;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    if (pending.length > LEGACY_IMPORT_MAX_LINE_CHARS) {
      throw new ClaudeImportSourceError('Claude session contains an oversized JSONL line');
    }
    if (pending) yield pending.replace(/\r$/, '');
  } finally {
    stream.destroy();
  }
}

function pushBounded(entries: ImportedConversationEntry[], entry: ImportedConversationEntry): void {
  if (entries.length >= LEGACY_IMPORT_MAX_ENTRIES) {
    throw new ClaudeImportSourceError(
      `Claude session exceeds the ${LEGACY_IMPORT_MAX_ENTRIES}-entry import limit`
    );
  }
  entries.push(entry);
}

function buildDisplay(
  input: Omit<Extract<ImportedConversationEntry, { kind: 'display' }>, 'kind'>
): ImportedConversationEntry {
  return { kind: 'display', ...input };
}

async function parseConversation(
  source: ClaudeSessionSource,
  fingerprint: SourceSnapshot
): Promise<ImportedConversation> {
  const entries: ImportedConversationEntry[] = [];
  const diagnostics: string[] = [];
  const knownToolCalls = new Map<string, string>();
  let assistant:
    | {
        sourceEntryId?: string;
        timestamp?: number;
        model?: string;
        blocks: ImportedAssistantBlock[];
      }
    | undefined;
  let malformedLines = 0;
  let sidechainLines = 0;
  let unsupportedItems = 0;
  let firstUserText = '';
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let model: string | undefined;

  const observeTimestamp = (timestamp: number | undefined) => {
    if (timestamp === undefined) return;
    startedAt = startedAt === undefined ? timestamp : Math.min(startedAt, timestamp);
    endedAt = endedAt === undefined ? timestamp : Math.max(endedAt, timestamp);
  };
  const flushAssistant = () => {
    if (!assistant) return;
    if (assistant.blocks.length > 0) {
      pushBounded(entries, { kind: 'assistant', ...assistant });
    }
    assistant = undefined;
  };

  for await (const rawLine of sourceLines(source.filePath)) {
    const line = rawLine.trim();
    if (!line) continue;
    let raw: ClaudeJsonlEntry;
    try {
      raw = JSON.parse(line) as ClaudeJsonlEntry;
    } catch {
      malformedLines += 1;
      continue;
    }
    const timestamp = parseTimestamp(raw.timestamp);
    observeTimestamp(timestamp);
    const provenance = {
      ...(typeof raw.uuid === 'string' && raw.uuid ? { sourceEntryId: raw.uuid } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    };

    if (raw.isSidechain === true) {
      sidechainLines += 1;
      continue;
    }
    if (raw.isMeta === true || raw.type === 'system' || CONTROL_LINE_TYPES.has(raw.type ?? '')) {
      continue;
    }
    if (raw.attachment !== undefined) {
      pushBounded(
        entries,
        buildDisplay({
          ...provenance,
          displayKind: 'attachment',
          title: 'Legacy attachment metadata',
          body: 'Attachment payload was omitted; only its position in the legacy timeline is retained.',
          redacted: true,
        })
      );
      continue;
    }

    if (raw.type === 'assistant') {
      const nextModel = raw.message?.model?.trim() || undefined;
      model ??= nextModel;
      const ensureAssistant = () => {
        if (!assistant) {
          assistant = {
            ...provenance,
            ...(nextModel ? { model: nextModel } : {}),
            blocks: [],
          };
        }
        return assistant;
      };
      const content = Array.isArray(raw.message?.content) ? raw.message.content : [];
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
          ensureAssistant().blocks.push({
            type: 'text',
            ...boundedText(item.text.trim(), LEGACY_IMPORT_MAX_TEXT_CHARS),
          });
        } else if (
          item.type === 'thinking' &&
          typeof item.thinking === 'string' &&
          item.thinking.trim()
        ) {
          ensureAssistant().blocks.push({
            type: 'thinking',
            ...boundedText(item.thinking.trim(), LEGACY_IMPORT_MAX_TEXT_CHARS),
          });
        } else if (
          item.type === 'tool_use' &&
          typeof item.id === 'string' &&
          item.id.trim() &&
          typeof item.name === 'string' &&
          item.name.trim()
        ) {
          flushAssistant();
          knownToolCalls.set(item.id, item.name);
          pushBounded(
            entries,
            buildDisplay({
              ...provenance,
              displayKind: 'tool',
              title: `Legacy tool call: ${item.name.slice(0, 256)}`,
              toolCallId: item.id,
              toolName: item.name.slice(0, 256),
              ...(item.input !== undefined ? { input: boundedSanitizedValue(item.input) } : {}),
              redacted: true,
            })
          );
        } else if (item.type) {
          unsupportedItems += 1;
          flushAssistant();
          pushBounded(
            entries,
            buildDisplay({
              ...provenance,
              displayKind: 'custom',
              title: `Unsupported Claude assistant block: ${item.type}`,
              body:
                typeof item.name === 'string' && item.name.trim()
                  ? `Legacy block name: ${item.name.trim().slice(0, 256)}. Raw payload omitted.`
                  : 'Raw legacy block payload omitted.',
              redacted: true,
            })
          );
        }
      }
      continue;
    }

    if (raw.type === 'user') {
      const content = raw.message?.content;
      const items = Array.isArray(content) ? content : [];
      const toolResults = items.filter((item) => item?.type === 'tool_result');
      if (toolResults.length > 0) {
        flushAssistant();
        for (const item of toolResults) {
          const toolCallId = typeof item.tool_use_id === 'string' ? item.tool_use_id : '';
          const toolName = toolCallId ? knownToolCalls.get(toolCallId) : undefined;
          pushBounded(
            entries,
            buildDisplay({
              ...provenance,
              displayKind: 'tool',
              title: toolName
                ? `Legacy tool result: ${toolName.slice(0, 256)}`
                : 'Unmatched legacy tool result',
              ...(toolCallId ? { toolCallId } : {}),
              ...(toolName ? { toolName: toolName.slice(0, 256) } : {}),
              output: sanitizedToolOutput(item.content),
              isError: item.is_error === true,
              redacted: true,
            })
          );
        }
      } else {
        flushAssistant();
      }

      const rawText = textFromContent(content);
      const cleaned = rawText ? stripSystemTags(rawText) || commandLabel(rawText) || '' : '';
      const attachments = attachmentDiagnostics(content);
      if (cleaned || attachments.length > 0) {
        const bounded = boundedText(cleaned, LEGACY_IMPORT_MAX_TEXT_CHARS);
        if (!firstUserText && bounded.text) firstUserText = bounded.text;
        pushBounded(entries, {
          kind: 'user',
          ...provenance,
          text: bounded.text,
          ...(attachments.length ? { attachments } : {}),
        });
        for (const attachment of attachments) {
          pushBounded(
            entries,
            buildDisplay({
              ...provenance,
              displayKind: 'attachment',
              title: attachment.name ?? attachment.mediaType,
              body: `Legacy ${attachment.kind} attachment (${attachment.mediaType}) is metadata-only and was not copied.`,
            })
          );
        }
      }
      continue;
    }

    if (raw.type) {
      pushBounded(
        entries,
        buildDisplay({
          ...provenance,
          displayKind: 'diagnostic',
          title: `Unsupported Claude entry: ${raw.type}`,
          body: 'Raw legacy entry payload omitted.',
          redacted: true,
        })
      );
    }
  }
  flushAssistant();

  if (malformedLines) diagnostics.push(`${malformedLines} malformed JSONL line(s) skipped`);
  if (sidechainLines) diagnostics.push(`${sidechainLines} sidechain line(s) omitted`);
  if (unsupportedItems)
    diagnostics.push(`${unsupportedItems} unsupported content block(s) kept display-only`);
  if (!entries.some((entry) => entry.kind === 'assistant')) {
    throw new ClaudeImportSourceError(
      'Claude session has no assistant response and cannot materialize a Pi session'
    );
  }

  return {
    schemaVersion: LEGACY_IMPORT_SCHEMA_VERSION,
    importerVersion: LEGACY_IMPORTER_VERSION,
    sourceKind: 'claude-code',
    stableSourceIdentity: fingerprint.stableSourceIdentity,
    sourceSessionId: source.sessionId,
    workspacePath: source.workspacePath,
    title: firstUserText.trim().slice(0, 120) || 'Imported Claude conversation',
    ...(model ? { model } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    sourceFingerprint: {
      stableSourceIdentity: fingerprint.stableSourceIdentity,
      contentHash: fingerprint.contentHash,
      size: fingerprint.size,
      mode: fingerprint.mode,
      mtimeMs: fingerprint.mtimeMs,
    },
    entries,
    diagnostics,
  };
}

function safeSourceError(error: unknown): ClaudeImportSourceError {
  if (error instanceof ClaudeImportSourceError) return error;
  if (error instanceof TsdFileTooLargeError) {
    return new ClaudeImportSourceError('Claude session exceeds the safe buffered import limit');
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return new ClaudeImportSourceError('Claude session source was not found');
  if (code === 'EACCES' || code === 'EPERM') {
    return new ClaudeImportSourceError('Claude session source could not be read');
  }
  return new ClaudeImportSourceError('Claude session source could not be read safely');
}

export class ClaudeSourceAdapter {
  constructor(private readonly scanner: ClaudeSessionScanner) {}

  async read(sourceRef: LegacyImportSourceRef): Promise<ReadClaudeConversationResult> {
    try {
      if (sourceRef.sourceKind !== 'claude-code') {
        throw new ClaudeImportSourceError('Unsupported legacy import source');
      }
      const source = await this.scanner.resolveSessionSource(
        sourceRef.projectId,
        sourceRef.sourceSessionId
      );
      if (!source) throw new ClaudeImportSourceError('Claude session source was not found');
      const before = await snapshotSource(source);
      const conversation = await parseConversation(source, before);
      const after = await snapshotSource(source);
      assertSameSource(before, after);
      return { conversation, sourcePath: source.filePath };
    } catch (error) {
      throw safeSourceError(error);
    }
  }

  async assertUnchanged(
    sourcePath: string,
    expected: LegacyImportSourceFingerprint
  ): Promise<void> {
    try {
      const source: ClaudeSessionSource = {
        projectId: '',
        sessionId: '',
        workspacePath: '',
        configDir: '',
        filePath: sourcePath,
        rootKind: 'legacy',
      };
      const current = await snapshotSource(source);
      if (
        current.stableSourceIdentity !== expected.stableSourceIdentity ||
        current.contentHash !== expected.contentHash ||
        current.size !== expected.size ||
        current.mode !== expected.mode ||
        current.mtimeMs !== expected.mtimeMs
      ) {
        throw new ClaudeImportSourceError(
          'Claude session changed before publish; retry the import step'
        );
      }
    } catch (error) {
      throw safeSourceError(error);
    }
  }
}
