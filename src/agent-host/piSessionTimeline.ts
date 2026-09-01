import {
  LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY,
  LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE,
} from '../shared/types/legacyImport.ts';
import type {
  HistoryAttachment,
  HistoryBlock,
  HistoryMessage,
  SessionHistoryPage,
} from '../shared/types/sessionHistory.ts';

export interface PiHistorySessionManager {
  getBranch(): unknown[];
}

const TOOL_OUTPUT_LIMIT = 4_000;
const UNMATCHED_TOOL_OUTPUT_LIMIT = 2_000;
const DEFAULT_HISTORY_PAGE_LIMIT = 80;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function epoch(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => {
      const record = recordOf(part);
      if (!record) return [];
      if (record.type === 'text' && typeof record.text === 'string') return [record.text];
      return [];
    })
    .join('');
}

function attachmentMetadata(content: unknown): HistoryAttachment[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const record = recordOf(part);
    if (!record || record.type !== 'image') return [];
    const mediaType =
      typeof record.mimeType === 'string'
        ? record.mimeType
        : typeof record.mediaType === 'string'
          ? record.mediaType
          : 'image/*';
    return [{ kind: 'image' as const, mediaType }];
  });
}

function boundedText(value: unknown, max: number): string {
  const text = textFromContent(value);
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}

function stablePartId(messageId: string, kind: string, suffix: string | number): string {
  return `${messageId}:${kind}:${suffix}`;
}

function stopReason(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isFailureStopReason(value: string | undefined): boolean {
  return value === 'aborted' || value === 'interrupted' || value === 'error';
}

function markIncompleteAssistantLeaves(messages: HistoryMessage[]): HistoryMessage[] {
  let cursor = messages.length - 1;
  while (cursor >= 0 && messages[cursor]?.role !== 'user') cursor -= 1;
  const start = cursor + 1;
  let changed = false;
  const next = [...messages];
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    const hasVisibleBody = message.blocks.some(
      (block) => (block.type === 'text' || block.type === 'thinking') && Boolean(block.text?.trim())
    );
    const hasToolCall = message.blocks.some((block) => block.type === 'tool_call');
    if (hasVisibleBody) break;
    if (hasToolCall) continue;
    if (!message.incomplete) {
      next[index] = {
        ...message,
        incomplete: true,
        stopReason: isFailureStopReason(message.stopReason)
          ? message.stopReason
          : (message.stopReason ?? 'interrupted'),
      };
      changed = true;
    }
  }
  return changed ? next : messages;
}

/** Project the exact SessionManager active branch into stable renderer history DTOs. */
export function projectPiSessionHistory(manager: PiHistorySessionManager): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  const toolCalls = new Map<string, { messageIndex: number; toolName: string }>();

  for (const rawEntry of manager.getBranch()) {
    const entry = recordOf(rawEntry);
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    const messageId = `h:${entry.id}` as const;
    const timestamp = epoch(entry.timestamp);

    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      const summary = typeof entry.summary === 'string' ? entry.summary : '';
      if (!summary) continue;
      messages.push({
        id: messageId,
        entryId: entry.id,
        role: 'system',
        ...(timestamp !== undefined ? { timestamp } : {}),
        blocks: [
          {
            type: 'text',
            id: stablePartId(messageId, 'summary', 0),
            text: `Context summary\n\n${summary}`,
          },
        ],
      });
      continue;
    }
    if (entry.type === 'custom') {
      if (entry.customType === LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE) {
        const data = recordOf(entry.data);
        const sourceSessionId =
          typeof data?.sourceSessionId === 'string' ? data.sourceSessionId : 'unknown';
        const sourceKind = typeof data?.sourceKind === 'string' ? data.sourceKind : 'legacy';
        messages.push({
          id: messageId,
          entryId: entry.id,
          role: 'system',
          ...(timestamp !== undefined ? { timestamp } : {}),
          blocks: [
            {
              type: 'text',
              id: stablePartId(messageId, 'provenance', 0),
              text: `Imported read-only history from ${sourceKind} session ${sourceSessionId}. Continue in Pi; the original runtime state was not restored.`,
            },
          ],
        });
        continue;
      }
      if (entry.customType === LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY) {
        const data = recordOf(entry.data);
        const title = typeof data?.title === 'string' ? data.title : 'Legacy history';
        if (data?.displayKind === 'tool') {
          const toolCallId =
            typeof data.toolCallId === 'string' && data.toolCallId
              ? data.toolCallId
              : `${entry.id}-display`;
          const toolName =
            typeof data.toolName === 'string' && data.toolName ? data.toolName : title;
          const output = typeof data.output === 'string' ? data.output : undefined;
          messages.push({
            id: messageId,
            entryId: entry.id,
            role: 'assistant',
            ...(timestamp !== undefined ? { timestamp } : {}),
            blocks: [
              {
                type: 'tool_call',
                id: stablePartId(messageId, 'legacy-tool-call', 0),
                toolCallId,
                name: toolName,
                ...(data.input !== undefined ? { input: data.input } : {}),
              },
              {
                type: 'tool_result',
                id: stablePartId(messageId, 'legacy-tool-result', 0),
                toolCallId,
                ok: data.isError !== true,
                ...(output ? (data.isError === true ? { error: output } : { output }) : {}),
              },
            ],
          });
          continue;
        }
        const body = typeof data?.body === 'string' ? data.body : '';
        messages.push({
          id: messageId,
          entryId: entry.id,
          role: 'system',
          ...(timestamp !== undefined ? { timestamp } : {}),
          blocks: [
            {
              type: 'text',
              id: stablePartId(messageId, 'legacy-display', 0),
              text: body ? `${title}\n\n${body}` : title,
            },
          ],
        });
        continue;
      }
      continue;
    }
    if (entry.type === 'custom_message') {
      if (entry.display === false) continue;
      const content = textFromContent(entry.content);
      if (!content) continue;
      messages.push({
        id: messageId,
        entryId: entry.id,
        role: 'system',
        ...(timestamp !== undefined ? { timestamp } : {}),
        blocks: [{ type: 'text', id: stablePartId(messageId, 'text', 0), text: content }],
      });
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = recordOf(entry.message);
    if (!message || typeof message.role !== 'string') continue;
    const content = message.content;

    if (message.role === 'user') {
      const text = textFromContent(content);
      const attachments = attachmentMetadata(content);
      messages.push({
        id: messageId,
        entryId: entry.id,
        role: 'user',
        ...(timestamp !== undefined ? { timestamp } : {}),
        blocks: text ? [{ type: 'text', id: stablePartId(messageId, 'text', 0), text }] : [],
        ...(attachments.length ? { attachments } : {}),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const blocks: HistoryBlock[] = [];
      const parts = Array.isArray(content) ? content : [];
      for (let index = 0; index < parts.length; index += 1) {
        const part = recordOf(parts[index]);
        if (!part) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          blocks.push({
            type: 'text',
            id: stablePartId(messageId, 'text', index),
            text: part.text,
          });
        } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
          blocks.push({
            type: 'thinking',
            id: stablePartId(messageId, 'thinking', index),
            text: part.thinking,
          });
        } else if (part.type === 'toolCall') {
          const nested = recordOf(part.toolCall);
          const toolCallId =
            typeof part.id === 'string'
              ? part.id
              : typeof nested?.id === 'string'
                ? nested.id
                : `${entry.id}-${index}`;
          const name =
            typeof part.name === 'string'
              ? part.name
              : typeof nested?.name === 'string'
                ? nested.name
                : 'tool';
          const input = part.arguments ?? part.input ?? nested?.arguments ?? nested?.input;
          blocks.push({
            type: 'tool_call',
            id: stablePartId(messageId, 'tool-call', toolCallId),
            toolCallId,
            name,
            ...(input !== undefined ? { input } : {}),
          });
          toolCalls.set(toolCallId, { messageIndex: messages.length, toolName: name });
        }
      }
      const reason = stopReason(message.stopReason);
      const model =
        typeof message.provider === 'string' && typeof message.model === 'string'
          ? `${message.provider}/${message.model}`
          : typeof message.model === 'string'
            ? message.model
            : undefined;
      messages.push({
        id: messageId,
        entryId: entry.id,
        role: 'assistant',
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(model ? { model } : {}),
        blocks,
        ...(reason ? { stopReason: reason } : {}),
        ...(!blocks.some((block) => block.type === 'text' || block.type === 'thinking') &&
        !blocks.some((block) => block.type === 'tool_call')
          ? { incomplete: true, stopReason: reason ?? 'interrupted' }
          : isFailureStopReason(reason)
            ? { incomplete: true }
            : {}),
      });
      continue;
    }

    if (message.role === 'toolResult') {
      const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
      const toolName = typeof message.toolName === 'string' ? message.toolName : 'result';
      const output = boundedText(
        content,
        toolCallId ? TOOL_OUTPUT_LIMIT : UNMATCHED_TOOL_OUTPUT_LIMIT
      );
      let target = toolCallId ? toolCalls.get(toolCallId) : undefined;
      if (!target) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const candidate = messages[index];
          const call = candidate?.blocks.find(
            (block) =>
              block.type === 'tool_call' &&
              !candidate.blocks.some(
                (other) => other.type === 'tool_result' && other.toolCallId === block.toolCallId
              ) &&
              (toolName === 'result' || block.name === toolName)
          );
          if (call?.type === 'tool_call') {
            target = { messageIndex: index, toolName: call.name };
            break;
          }
        }
      }
      const resultBlock: HistoryBlock = {
        type: 'tool_result',
        id: stablePartId(messageId, 'tool-result', toolCallId || 0),
        toolCallId: toolCallId || `${entry.id}-result`,
        ok: message.isError !== true,
        ...(output ? { output } : {}),
        ...(message.isError === true ? { error: output || 'Tool call failed' } : {}),
      };
      if (target && messages[target.messageIndex]) {
        const owner = messages[target.messageIndex];
        messages[target.messageIndex] = { ...owner, blocks: [...owner.blocks, resultBlock] };
      } else {
        messages.push({
          id: messageId,
          entryId: entry.id,
          role: 'assistant',
          ...(timestamp !== undefined ? { timestamp } : {}),
          blocks: [
            {
              type: 'tool_call',
              id: stablePartId(messageId, 'tool-call', toolCallId || 0),
              toolCallId: resultBlock.toolCallId,
              name: toolName,
            },
            resultBlock,
          ],
        });
      }
    }
  }

  return markIncompleteAssistantLeaves(messages);
}

export function paginatePiSessionHistory(
  messages: HistoryMessage[],
  offset = 0,
  limit = DEFAULT_HISTORY_PAGE_LIMIT
): SessionHistoryPage {
  const totalCount = messages.length;
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const normalizedLimit = Number.isFinite(limit)
    ? Math.min(500, Math.max(1, Math.floor(limit)))
    : DEFAULT_HISTORY_PAGE_LIMIT;
  if (normalizedOffset >= totalCount) {
    return {
      messages: [],
      offset: normalizedOffset,
      limit: normalizedLimit,
      totalCount,
      hasMore: false,
    };
  }
  const end = Math.max(0, totalCount - normalizedOffset);
  const start = Math.max(0, end - normalizedLimit);
  const page = messages.slice(start, end);
  return {
    messages: page,
    offset: normalizedOffset,
    limit: normalizedLimit,
    totalCount,
    hasMore: start > 0,
  };
}

export function readPiSessionHistoryPage(
  manager: PiHistorySessionManager,
  offset?: number,
  limit?: number
): SessionHistoryPage {
  return paginatePiSessionHistory(projectPiSessionHistory(manager), offset, limit);
}
