/**
 * Decision 203: a subagent's own conversation for its sub-conversation page,
 * read from the CLI's `subagents/agent-<task id>.jsonl` (2.1.300): one JSON
 * row per user or assistant message, the assistant's split across rows that
 * share the API message id.
 *
 * Projected as the session's own transcript is (`readTranscript`): the
 * prompt and any later user text as user messages, an assistant message's
 * text, thinking and calls in order, and each call's result folded into the
 * message that made it. Rows that are not messages are skipped; a torn line
 * (the CLI is still writing) is skipped too.
 */

import type { HistoryBlock, HistoryMessage } from '../shared/types/sessionHistory.ts';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A content value's text: a string, or its text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = record(block);
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function projectSubagentTranscript(raw: string): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  const byApiId = new Map<string, HistoryMessage>();
  const toolOwner = new Map<string, HistoryMessage>();
  let row = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    row += 1;
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : `row-${row}`;
    const message = record(entry.message) ?? {};
    const content = message.content;
    if (entry.type === 'user') {
      const results = Array.isArray(content)
        ? content.map(record).filter((b) => b?.type === 'tool_result')
        : [];
      if (results.length > 0) {
        for (const b of results) {
          if (!b || typeof b.tool_use_id !== 'string') continue;
          const text = textOf(b.content);
          toolOwner.get(b.tool_use_id)?.blocks.push({
            type: 'tool_result',
            id: `${b.tool_use_id}-result`,
            toolCallId: b.tool_use_id,
            ok: b.is_error !== true,
            output: text,
            ...(b.is_error === true ? { error: text } : {}),
          });
        }
        continue;
      }
      const text = textOf(content);
      if (!text.trim()) continue;
      out.push({
        id: `h:${uuid}`,
        entryId: uuid,
        role: 'user',
        blocks: [{ type: 'text', id: `${uuid}-text`, text }],
      });
      continue;
    }
    const apiId = typeof message.id === 'string' ? message.id : uuid;
    let target = byApiId.get(apiId);
    if (!target) {
      target = {
        id: `h:${uuid}`,
        entryId: uuid,
        role: 'assistant',
        ...(typeof message.model === 'string' ? { model: message.model } : {}),
        blocks: [],
      };
      byApiId.set(apiId, target);
      out.push(target);
    }
    if (!Array.isArray(content)) continue;
    for (const [i, block] of content.entries()) {
      const b = record(block);
      if (!b) continue;
      const id = `${uuid}-${i}`;
      let projected: HistoryBlock | null = null;
      if (b.type === 'text' && typeof b.text === 'string') {
        projected = { type: 'text', id, text: b.text };
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        projected = { type: 'thinking', id, text: b.thinking };
      } else if (b.type === 'tool_use' && typeof b.id === 'string') {
        projected = {
          type: 'tool_call',
          id: b.id,
          toolCallId: b.id,
          name: String(b.name),
          input: b.input,
        };
        toolOwner.set(b.id, target);
      }
      if (projected) target.blocks.push(projected);
    }
  }
  return out;
}
