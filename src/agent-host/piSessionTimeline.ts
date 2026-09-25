import { attachmentNameOf } from '../shared/attachmentRider.ts';
import { isInternalMessage } from '../shared/internalMessage.ts';
import { reviewFromToolResult } from '../shared/sessionFileChange.ts';
import {
  LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY,
  LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE,
} from '../shared/types/legacyImport.ts';
import {
  type HistoryAttachment,
  type HistoryBlock,
  type HistoryMessage,
  RUN_STOP_CUSTOM_TYPE,
  type SessionHistoryPage,
  type TurnStopCause,
} from '../shared/types/sessionHistory.ts';

export interface PiHistorySessionManager {
  getBranch(): unknown[];
}

/**
 * Record that an entry dated `stamp` was folded into `message`: `settledAt`
 * becomes the latest of the message's own date and every folded entry's, and
 * stays absent while nothing later than the message itself was folded in.
 */
function foldSettledAt(message: HistoryMessage, stamp: number | undefined): HistoryMessage {
  if (stamp === undefined) return message;
  const latest = message.settledAt ?? message.timestamp;
  if (latest !== undefined && stamp <= latest) return message;
  return { ...message, settledAt: stamp };
}

/**
 * Fold a run-stop record onto the run it closes.
 *
 * The record is written after the run's last message, so the run's last
 * assistant message is the newest one since the last user message. A run
 * stopped before it produced any assistant message has nothing to carry the
 * cause, and none is invented.
 *
 * The record's own date is folded in too: it is written when the run ENDED,
 * which for a run that stopped at a tool boundary is later than any assistant
 * entry it wrote.
 */
function stampRunStop(
  messages: HistoryMessage[],
  cause: TurnStopCause,
  stamp: number | undefined
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role === 'user') return;
    if (message.role !== 'assistant') continue;
    messages[index] = foldSettledAt({ ...message, stopCause: cause }, stamp);
    return;
  }
}

/**
 * T023 — the imported-history banner, as a catalog key plus its two values.
 *
 * It used to be a Chinese template literal built right here, with a comment
 * arguing that a worker has no renderer locale so Chinese was the safer guess.
 * The guess is what a language setting exists to stop making: this projection
 * feeds every install, and the app ships an English UI too.
 *
 * ## Why changing it breaks no session file
 *
 * Nothing about this sentence is stored. The session file holds a `custom`
 * entry (`aiclient.legacy-import.provenance`) carrying `sourceKind` and
 * `sourceSessionId` and nothing else — `nativeImport.ts` writes exactly those
 * fields — and this function mints the sentence fresh on every read. So a
 * session imported last week renders in today's wording and today's language,
 * and no reader needs a compatibility path for the old Chinese string.
 */
const IMPORTED_HISTORY_NOTICE_KEY =
  'This history was imported from a {{sourceKind}} session ({{sourceSessionId}}). You can keep talking here; the original run state — tools, permissions — did not come across.';

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
    // D25 — the file name, when the block that was written carried it. Absent
    // on every block stored before T061 and on anything pi wrote itself, which
    // keeps falling back to the media type alone.
    const name = attachmentNameOf(record);
    return [{ kind: 'image' as const, mediaType, ...(name ? { name } : {}) }];
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
      if (entry.customType === RUN_STOP_CUSTOM_TYPE) {
        const cause = recordOf(entry.data)?.cause;
        if (cause === 'interjected' || cause === 'user_stop')
          stampRunStop(messages, cause, timestamp);
        continue;
      }
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
              // T023: `text` is the English rendering so any surface that
              // ignores `notice` still shows a whole sentence; `notice` is
              // what the renderer runs through the dictionary.
              text: IMPORTED_HISTORY_NOTICE_KEY.replace('{{sourceKind}}', sourceKind).replace(
                '{{sourceSessionId}}',
                sourceSessionId
              ),
              notice: {
                key: IMPORTED_HISTORY_NOTICE_KEY,
                params: { sourceKind, sourceSessionId },
              },
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
      // A delegation report the runtime fed back to the model is stored as a
      // user message because that is the only shape pi has for it. Live, the
      // projector already keeps it off the timeline; a reopened session has to
      // agree, or the bubble the user never wrote comes back on reload — as the
      // newest thing they appear to have asked for. Legacy sessions never carry
      // the mark, so this is inert for them.
      if (isInternalMessage(message)) continue;
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
      const details = recordOf(message.details) as {
        patch?: unknown;
        refused?: unknown;
        stopped?: unknown;
      } | null;
      const review = message.isError !== true ? reviewFromToolResult(message) : undefined;
      const resultBlock: HistoryBlock = {
        type: 'tool_result',
        id: stablePartId(messageId, 'tool-result', toolCallId || 0),
        toolCallId: toolCallId || `${entry.id}-result`,
        ok: message.isError !== true,
        ...(output ? { output } : {}),
        ...(review ? { review } : {}),
        ...(message.isError !== true && typeof details?.patch === 'string'
          ? { patch: details.patch }
          : {}),
        ...(message.isError === true ? { error: output || 'Tool call failed' } : {}),
        // N5 / T130: the same flags the live projector forwards
        // (`toolOutcomeDetails`). Strictly `true`: TaskStop's own
        // `details.stopped` is the list of delegations it stopped.
        ...(details?.refused === true ? { refused: true as const } : {}),
        ...(details?.stopped === true ? { stopped: true as const } : {}),
      };
      if (target && messages[target.messageIndex]) {
        const owner = messages[target.messageIndex];
        // The result's date survives the fold as `settledAt`: it is when the
        // call FINISHED, and for a run that stopped right after it nothing
        // later records how long the call took.
        messages[target.messageIndex] = foldSettledAt(
          { ...owner, blocks: [...owner.blocks, resultBlock] },
          timestamp
        );
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

  return markIncompleteAssistantLeaves(settleUnstartedToolCalls(messages));
}

/** Mirrors the live projector's `NOT_STARTED_ERROR`, so both paths read alike. */
const NOT_STARTED_ERROR = 'The run ended before this call started.';

/**
 * N5: give every call Pi never ran a result that says so.
 *
 * Pi's loop executes no tool call of an assistant message that ended `aborted`
 * or `error` (`agent-loop.js`: it returns straight after `turn_end` with no
 * tool results), so nothing in the file ever answers those calls. Left alone
 * they replay as RUNNING — present-tense verbs on a finished transcript. This
 * is the replay half of the live projector's `settleUnfinishedToolRows`.
 *
 * Runs after the whole branch is folded, because a result is written after
 * its call and may sit several entries later.
 */
function settleUnstartedToolCalls(messages: HistoryMessage[]): HistoryMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message;
    if (message.stopReason !== 'aborted' && message.stopReason !== 'error') return message;
    const answered = new Set(
      message.blocks.flatMap((block) => (block.type === 'tool_result' ? [block.toolCallId] : []))
    );
    const unstarted: HistoryBlock[] = message.blocks.flatMap((block) =>
      block.type === 'tool_call' && !answered.has(block.toolCallId)
        ? [
            {
              type: 'tool_result' as const,
              id: stablePartId(message.id, 'tool-result', block.toolCallId),
              toolCallId: block.toolCallId,
              ok: false,
              error: NOT_STARTED_ERROR,
              notStarted: true as const,
            },
          ]
        : []
    );
    if (unstarted.length === 0) return message;
    changed = true;
    return { ...message, blocks: [...message.blocks, ...unstarted] };
  });
  return changed ? next : messages;
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
