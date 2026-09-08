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

export function parseCodexRollout(contents: string): CodexRollout {
  if (Buffer.byteLength(contents) > LEGACY_IMPORT_MAX_SOURCE_BYTES)
    throw new Error('Codex source exceeds import size limit');
  const result: CodexRollout = { sessionId: '', workspacePath: '', entries: [], diagnostics: [] };
  const calls = new Map<string, string>();
  const diagnose = (message: string) => {
    if (result.diagnostics.length < LEGACY_IMPORT_MAX_DIAGNOSTICS) result.diagnostics.push(message);
  };
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line.trim()) continue;
    if (line.length > LEGACY_IMPORT_MAX_LINE_CHARS)
      throw new Error('Codex source line exceeds import limit');
    const row = record(JSON.parse(line));
    if (!row) throw new Error(`Invalid Codex record at line ${index + 1}`);
    const payload = record(row.payload);
    if (row.type === 'session_meta' && payload) {
      if (
        typeof payload.id !== 'string' ||
        !payload.id ||
        typeof payload.cwd !== 'string' ||
        !payload.cwd
      ) {
        throw new Error('Codex session metadata is incomplete');
      }
      if (result.sessionId && result.sessionId !== payload.id)
        throw new Error('Conflicting Codex session metadata');
      result.sessionId = payload.id;
      result.workspacePath = payload.cwd;
      result.startedAt = timestamp(payload.timestamp ?? row.timestamp);
      continue;
    }
    if (row.type === 'turn_context' && payload) {
      if (typeof payload.model === 'string') result.model = payload.model;
      continue;
    }
    // event_msg mirrors response_item content. Reading both duplicates messages.
    if (row.type !== 'response_item' || !payload) continue;
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
      if (
        payload.role === 'user' &&
        /^(# AGENTS\.md instructions|<environment_context>|<permissions instructions>)/.test(text)
      )
        continue;
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
  if (!result.sessionId || !result.workspacePath)
    throw new Error('Codex session metadata was not found');
  return result;
}
