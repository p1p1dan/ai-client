import type { PiLeafCheckpoint, SessionHistoryPage } from './sessionHistory';
import type { SessionIndexEntry } from './sessionIndex';

export const LEGACY_IMPORT_SCHEMA_VERSION = 1 as const;
export const LEGACY_IMPORTER_VERSION = 't34-claude-v1' as const;
export const LEGACY_IMPORT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const LEGACY_IMPORT_MAX_ENTRIES = 4_000;
export const LEGACY_IMPORT_MAX_TEXT_CHARS = 64 * 1024;
export const LEGACY_IMPORT_MAX_TOOL_CHARS = 16 * 1024;
export const LEGACY_IMPORT_MAX_LINE_CHARS = 2 * 1024 * 1024;
export const LEGACY_IMPORT_MAX_DIAGNOSTICS = 100;
export const LEGACY_IMPORT_MAX_BATCH = 100;
export const LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE = 'aiclient.legacy-import.provenance';
export const LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY = 'aiclient.legacy-import.display';

export type LegacyImportSourceKind = 'claude-code';

export interface LegacyImportSourceRef {
  sourceKind: LegacyImportSourceKind;
  projectId: string;
  sourceSessionId: string;
}

export interface LegacyImportProject {
  id: string;
  path: string;
  sessionCount: number;
  lastActivityAt: number;
}

export interface LegacyImportSessionPreview {
  id: string;
  projectId: string;
  firstMessage: string | null;
  createdAt: number;
  lastMessageAt: number | null;
  model: string | null;
  importedSnapshots: number;
}

export interface LegacyImportSourceFingerprint {
  stableSourceIdentity: string;
  contentHash: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

export interface ImportedEntryProvenance {
  sourceEntryId?: string;
  timestamp?: number;
}

export interface ImportedAttachmentDiagnostic {
  kind: 'image' | 'text';
  mediaType: string;
  name?: string;
  reason: 'metadata-only' | 'unsupported' | 'redacted';
}

export type ImportedAssistantBlock =
  | { type: 'text'; text: string; truncated?: boolean }
  | { type: 'thinking'; text: string; truncated?: boolean }
  | {
      type: 'tool_call';
      toolCallId: string;
      name: string;
      input?: unknown;
      truncated?: boolean;
    };

export type ImportedConversationEntry =
  | ({
      kind: 'user';
      text: string;
      attachments?: ImportedAttachmentDiagnostic[];
    } & ImportedEntryProvenance)
  | ({
      kind: 'assistant';
      blocks: ImportedAssistantBlock[];
      model?: string;
    } & ImportedEntryProvenance)
  | ({
      kind: 'tool_result';
      toolCallId: string;
      toolName: string;
      output: string;
      isError: boolean;
      truncated?: boolean;
    } & ImportedEntryProvenance)
  | ({
      kind: 'display';
      displayKind: 'tool' | 'custom' | 'diagnostic' | 'attachment';
      title: string;
      body?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      output?: string;
      isError?: boolean;
      redacted?: boolean;
    } & ImportedEntryProvenance);

export interface ImportedConversation {
  schemaVersion: typeof LEGACY_IMPORT_SCHEMA_VERSION;
  importerVersion: string;
  sourceKind: LegacyImportSourceKind;
  stableSourceIdentity: string;
  sourceSessionId: string;
  workspacePath: string;
  title: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  sourceFingerprint: LegacyImportSourceFingerprint;
  entries: ImportedConversationEntry[];
  diagnostics: string[];
}

export interface LegacyImportScanRequest {
  projectId: string;
}

export interface LegacyImportBatchRequest {
  sources: LegacyImportSourceRef[];
}

export type LegacyImportItemStatus = 'imported' | 'already-imported' | 'failed';

export interface LegacyImportItemResult {
  source: LegacyImportSourceRef;
  status: LegacyImportItemStatus;
  session?: SessionIndexEntry;
  error?: string;
}

export interface LegacyImportBatchResult {
  results: LegacyImportItemResult[];
}

export interface WorkerImportConversationPayload {
  logicalSessionId: string;
  targetPiSessionId: string;
  conversation: ImportedConversation;
}

export interface WorkerInspectImportedSessionPayload {
  logicalSessionId: string;
  workspacePath: string;
  targetPiSessionId: string;
}

export interface WorkerInspectImportedSessionResult {
  sessionFiles: string[];
}

export interface WorkerReconcileImportedSessionPayload {
  logicalSessionId: string;
  workspacePath: string;
  targetPiSessionId: string;
}

export interface WorkerReconcileImportedSessionResult {
  removedFiles: number;
  remainingFiles: number;
}

export interface WorkerDiscardImportedSessionPayload {
  logicalSessionId: string;
  sessionFile: string;
}

export interface WorkerDiscardImportedSessionResult {
  discarded: boolean;
}

export interface WorkerImportConversationResult {
  logicalSessionId: string;
  piSessionId: string;
  workspacePath: string;
  stagedSessionFile: string;
  finalSessionFile: string;
  leaf: PiLeafCheckpoint;
  history: {
    logicalSessionId: string;
    sessionFile: string;
    workspacePath: string;
    page: SessionHistoryPage;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isFingerprint(value: unknown): value is LegacyImportSourceFingerprint {
  return (
    isRecord(value) &&
    nonEmptyString(value.stableSourceIdentity) &&
    nonEmptyString(value.contentHash) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0 &&
    Number.isSafeInteger(value.mode) &&
    Number(value.mode) >= 0 &&
    typeof value.mtimeMs === 'number' &&
    Number.isFinite(value.mtimeMs)
  );
}

function isImportedAssistantBlock(value: unknown): value is ImportedAssistantBlock {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text' || value.type === 'thinking') {
    return typeof value.text === 'string' && value.text.length <= LEGACY_IMPORT_MAX_TEXT_CHARS;
  }
  if (value.type !== 'tool_call') return false;
  return nonEmptyString(value.toolCallId) && nonEmptyString(value.name);
}

function isImportedEntry(value: unknown): value is ImportedConversationEntry {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (!optionalFiniteNumber(value.timestamp)) return false;
  if (value.sourceEntryId !== undefined && typeof value.sourceEntryId !== 'string') return false;
  switch (value.kind) {
    case 'user':
      return typeof value.text === 'string' && value.text.length <= LEGACY_IMPORT_MAX_TEXT_CHARS;
    case 'assistant':
      return (
        Array.isArray(value.blocks) &&
        value.blocks.length <= 256 &&
        value.blocks.every(isImportedAssistantBlock) &&
        (value.model === undefined || typeof value.model === 'string')
      );
    case 'tool_result':
      return (
        nonEmptyString(value.toolCallId) &&
        nonEmptyString(value.toolName) &&
        typeof value.output === 'string' &&
        value.output.length <= LEGACY_IMPORT_MAX_TOOL_CHARS &&
        typeof value.isError === 'boolean'
      );
    case 'display':
      return (
        ['tool', 'custom', 'diagnostic', 'attachment'].includes(String(value.displayKind)) &&
        nonEmptyString(value.title) &&
        value.title.length <= 256 &&
        (value.body === undefined ||
          (typeof value.body === 'string' && value.body.length <= LEGACY_IMPORT_MAX_TOOL_CHARS)) &&
        (value.output === undefined ||
          (typeof value.output === 'string' &&
            value.output.length <= LEGACY_IMPORT_MAX_TOOL_CHARS)) &&
        (value.toolCallId === undefined || typeof value.toolCallId === 'string') &&
        (value.toolName === undefined ||
          (typeof value.toolName === 'string' && value.toolName.length <= 256))
      );
    default:
      return false;
  }
}

export function isImportedConversation(value: unknown): value is ImportedConversation {
  return (
    isRecord(value) &&
    value.schemaVersion === LEGACY_IMPORT_SCHEMA_VERSION &&
    nonEmptyString(value.importerVersion) &&
    value.sourceKind === 'claude-code' &&
    nonEmptyString(value.stableSourceIdentity) &&
    nonEmptyString(value.sourceSessionId) &&
    nonEmptyString(value.workspacePath) &&
    typeof value.title === 'string' &&
    isFingerprint(value.sourceFingerprint) &&
    Array.isArray(value.entries) &&
    value.entries.length > 0 &&
    value.entries.length <= LEGACY_IMPORT_MAX_ENTRIES &&
    value.entries.every(isImportedEntry) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.length <= LEGACY_IMPORT_MAX_DIAGNOSTICS &&
    value.diagnostics.every(
      (item) => typeof item === 'string' && item.length <= LEGACY_IMPORT_MAX_TOOL_CHARS
    ) &&
    optionalFiniteNumber(value.startedAt) &&
    optionalFiniteNumber(value.endedAt)
  );
}

export function isWorkerImportConversationPayload(
  value: unknown
): value is WorkerImportConversationPayload {
  return (
    isRecord(value) &&
    nonEmptyString(value.logicalSessionId) &&
    nonEmptyString(value.targetPiSessionId) &&
    isImportedConversation(value.conversation)
  );
}

export function isLegacyImportPathSegment(value: unknown): value is string {
  return (
    nonEmptyString(value) &&
    value.length <= 512 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

export function isLegacyImportBatchRequest(value: unknown): value is LegacyImportBatchRequest {
  if (!isRecord(value) || !Array.isArray(value.sources)) return false;
  if (value.sources.length < 1 || value.sources.length > LEGACY_IMPORT_MAX_BATCH) return false;
  return value.sources.every(
    (source) =>
      isRecord(source) &&
      source.sourceKind === 'claude-code' &&
      isLegacyImportPathSegment(source.projectId) &&
      isLegacyImportPathSegment(source.sourceSessionId)
  );
}

export function legacyImportDedupeKey(conversation: ImportedConversation): string {
  return [
    conversation.sourceKind,
    conversation.stableSourceIdentity,
    conversation.sourceSessionId,
    conversation.sourceFingerprint.contentHash,
    String(conversation.schemaVersion),
    conversation.importerVersion,
  ].join(':');
}
