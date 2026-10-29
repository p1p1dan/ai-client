/**
 * Chat search: the text each engine's history contributes to the index.
 *
 * Only what a person reads as the conversation: the user's own messages and
 * the assistant's prose. No tool calls or outputs, no thinking, no notices the
 * app wrote into the transcript, no turn heads the engine opened by itself.
 *
 * Every message carries the key the chat timeline renders it under
 * (`HistoryMessage.id`), so the renderer can find a hit after it loaded the
 * session's history. See `docs/plantree/plans/chat-search` §3.2.
 */

import type { HistoryMessage } from '@shared/types/sessionHistory';

/** Longest body kept per message, in UTF-16 units; the rest is not searchable. */
export const MAX_INDEXED_MESSAGE_CHARS = 50_000;

export interface IndexedMessage {
  /** Equals the timeline's `HistoryMessage.id` (`h:<id>`). */
  key: string;
  role: 'user' | 'assistant';
  text: string;
  /** Epoch ms when known. */
  timestamp?: number;
}

/** Cut `text` to the cap without splitting a surrogate pair. */
export function clampBody(text: string): string {
  if (text.length <= MAX_INDEXED_MESSAGE_CHARS) return text;
  let end = MAX_INDEXED_MESSAGE_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * One projected history message (DSH `readPage`, legacy pi replay), or null
 * when nothing of it is the conversation's prose.
 */
export function indexableHistoryMessage(message: HistoryMessage): IndexedMessage | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  // A turn the engine started by itself (goal round, job, subagent): not typed by anyone.
  if (message.origin) return null;
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' && !block.notice ? [block.text] : []))
    .join('\n')
    .trim();
  if (!text) return null;
  return {
    key: message.id,
    role: message.role,
    text: clampBody(text),
    ...(typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {}),
  };
}

/**
 * A whole history in timeline order. A key seen twice (pages read while the
 * session grew) keeps its first copy.
 */
export function indexableHistory(messages: readonly HistoryMessage[]): IndexedMessage[] {
  const out: IndexedMessage[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const indexed = indexableHistoryMessage(message);
    if (!indexed || seen.has(indexed.key)) continue;
    seen.add(indexed.key);
    out.push(indexed);
  }
  return out;
}
