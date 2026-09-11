import {
  type ImportedConversationEntry,
  LEGACY_IMPORT_MAX_DIAGNOSTICS,
  LEGACY_IMPORT_MAX_ENTRIES,
  LEGACY_IMPORT_MAX_LINE_CHARS,
  LEGACY_IMPORT_MAX_SOURCE_BYTES,
  LEGACY_IMPORT_MAX_TEXT_CHARS,
} from '@shared/types';
import { readCodexTextContent } from '../../../agent-host/codexItemMapper.ts';
import { boundedSanitizedValue, sanitizedToolOutput } from './legacyImportSanitization';

export interface CodexRollout {
  sessionId: string;
  workspacePath: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  entries: ImportedConversationEntry[];
  diagnostics: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Injected repo instructions / environment context, not something the user typed. */
function isSyntheticCodexUserText(text: string): boolean {
  return text.startsWith('<') || text.startsWith('# AGENTS.md') || text.startsWith('You are Codex');
}

/**
 * Codex writes two on-disk shapes and both are still on users' machines:
 *
 * - current: every line is `{timestamp, type, payload}`, the header is
 *   `session_meta`, and conversation items arrive as `response_item`;
 * - legacy: the first line is a bare session header (`id` + `timestamp`, no
 *   `type`) and the items themselves are bare rows (`type: 'message'` etc.).
 *
 * The legacy header may carry no `cwd` at all, so `workspacePath` can come back
 * empty here. That is reported, not invented — the import service decides where
 * such a conversation lands (see `LegacyImportService.resolveWorkspace`).
 */
export function parseCodexRollout(contents: string): CodexRollout {
  if (Buffer.byteLength(contents) > LEGACY_IMPORT_MAX_SOURCE_BYTES)
    throw new Error('Codex source exceeds import size limit');
  const result: CodexRollout = { sessionId: '', workspacePath: '', entries: [], diagnostics: [] };
  const calls = new Map<string, string>();
  const diagnose = (message: string) => {
    if (result.diagnostics.length < LEGACY_IMPORT_MAX_DIAGNOSTICS) result.diagnostics.push(message);
  };
  const LEGACY_ITEM_TYPES = [
    'message',
    'reasoning',
    'function_call',
    'function_call_output',
    'custom_tool_call',
    'custom_tool_call_output',
  ];
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line.trim()) continue;
    if (line.length > LEGACY_IMPORT_MAX_LINE_CHARS)
      throw new Error('Codex source line exceeds import limit');
    const row = record(JSON.parse(line));
    if (!row) throw new Error(`Invalid Codex record at line ${index + 1}`);
    const wrapped = record(row.payload);
    if (row.type === 'session_meta' && wrapped) {
      if (
        typeof wrapped.id !== 'string' ||
        !wrapped.id ||
        typeof wrapped.cwd !== 'string' ||
        !wrapped.cwd
      ) {
        throw new Error('Codex session metadata is incomplete');
      }
      if (result.sessionId && result.sessionId !== wrapped.id)
        throw new Error('Conflicting Codex session metadata');
      result.sessionId = wrapped.id;
      result.workspacePath = wrapped.cwd;
      result.startedAt = timestamp(wrapped.timestamp ?? row.timestamp);
      continue;
    }
    if (row.type === 'turn_context' && wrapped) {
      if (typeof wrapped.model === 'string') result.model = wrapped.model;
      continue;
    }
    // Legacy bare header: no `type`, but an id and a timestamp. Only the first
    // one counts; a second is a corrupt concatenation, not a second session.
    if (
      row.type === undefined &&
      typeof row.id === 'string' &&
      row.id &&
      typeof row.timestamp === 'string'
    ) {
      if (result.sessionId && result.sessionId !== row.id)
        throw new Error('Conflicting Codex session metadata');
      result.sessionId = row.id;
      if (typeof row.cwd === 'string' && row.cwd) result.workspacePath = row.cwd;
      result.startedAt = timestamp(row.timestamp);
      continue;
    }
    // A legacy item is the payload itself; a current one is wrapped.
    const legacyItem =
      !wrapped && typeof row.type === 'string' && LEGACY_ITEM_TYPES.includes(row.type);
    const payload = legacyItem ? row : wrapped;
    // event_msg mirrors response_item content. Reading both duplicates messages.
    if (!payload || (!legacyItem && row.type !== 'response_item')) continue;
    const at = timestamp(row.timestamp);
    if (at !== undefined) result.endedAt = at;
    const provenance = {
      sourceEntryId: `codex-line-${index + 1}`,
      ...(at !== undefined ? { timestamp: at } : {}),
    };
    const type = payload.type;
    if (type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') continue;
      const text = readCodexTextContent(payload.content, '\n');
      // Codex prepends synthetic user turns carrying repo instructions and
      // environment context. They are noise in a conversation the user reads,
      // and the first of them would otherwise become the session title.
      if (payload.role === 'user' && isSyntheticCodexUserText(text)) continue;
      if (!text) {
        diagnose(`Message at line ${index + 1} has no supported text; attachments omitted`);
        continue;
      }
      if (text.length > LEGACY_IMPORT_MAX_TEXT_CHARS)
        throw new Error('Codex message exceeds import text limit');
      result.entries.push(
        payload.role === 'user'
          ? { kind: 'user', text, ...provenance }
          : { kind: 'assistant', blocks: [{ type: 'text', text }], ...provenance }
      );
    } else if (type === 'reasoning') {
      const text = readCodexTextContent(payload.summary, '\n');
      if (text.length > LEGACY_IMPORT_MAX_TEXT_CHARS)
        throw new Error('Codex reasoning exceeds import text limit');
      if (text)
        result.entries.push({
          kind: 'assistant',
          blocks: [{ type: 'thinking', text }],
          ...provenance,
        });
      if (payload.encrypted_content) diagnose(`Encrypted reasoning omitted at line ${index + 1}`);
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const name = typeof payload.name === 'string' ? payload.name.slice(0, 256) : 'Codex tool';
      const id = typeof payload.call_id === 'string' ? payload.call_id : provenance.sourceEntryId;
      calls.set(id, name);
      let input = payload.arguments ?? payload.input;
      if (type === 'function_call' && typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          diagnose(`Non-JSON tool input at line ${index + 1}`);
        }
      }
      // Legacy tools remain display entries; importing never grants execution.
      result.entries.push({
        kind: 'display',
        displayKind: 'tool',
        title: name,
        toolName: name,
        toolCallId: id,
        input: boundedSanitizedValue(input),
        ...provenance,
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const id = typeof payload.call_id === 'string' ? payload.call_id : provenance.sourceEntryId;
      const name = calls.get(id) ?? 'Codex tool';
      result.entries.push({
        kind: 'display',
        displayKind: 'tool',
        title: name,
        toolName: name,
        toolCallId: id,
        output: sanitizedToolOutput(payload.output),
        ...provenance,
      });
    } else {
      diagnose(`Unsupported Codex response item at line ${index + 1}`);
    }
    if (result.entries.length > LEGACY_IMPORT_MAX_ENTRIES)
      throw new Error('Codex source exceeds import entry limit');
  }
  if (!result.sessionId) throw new Error('Codex session metadata was not found');
  if (!result.workspacePath)
    diagnose('Codex session recorded no working directory; it imports as a temporary chat');
  return result;
}
