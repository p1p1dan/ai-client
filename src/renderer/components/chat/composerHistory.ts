/**
 * Up/Down through what was sent in this chat, as the official client's
 * composer does ("History 2/3"). Pure: the composer owns the cursor and the
 * textarea; this decides what a key turns the box into.
 *
 * Rules:
 * - The entries are this chat's user messages, oldest first, an empty one
 *   left out and a repeat of the one before folded into it.
 * - Up on the caret's first line starts browsing at the newest entry and
 *   keeps the draft; each further Up goes one older and stops at the oldest.
 * - Down on the caret's last line, while browsing, goes one newer; past the
 *   newest the draft comes back and browsing ends.
 * - An edit ends browsing (the composer drops the cursor on change): the text
 *   as edited is the draft from then on.
 */

import type { ChatMessage } from '../../stores/chatSessions';

/** This chat's sent lines, oldest first. */
export function composerHistoryEntries(messages: readonly ChatMessage[] | undefined): string[] {
  const entries: string[] = [];
  for (const message of messages ?? []) {
    if (message.role !== 'user') continue;
    const text = message.blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    if (text.trim() === '' || entries[entries.length - 1] === text) continue;
    entries.push(text);
  }
  return entries;
}

export interface ComposerHistoryCursor {
  /** Index into the entries the box shows. */
  index: number;
  /** What the box held before browsing began. */
  draft: string;
}

export interface ComposerHistoryStep {
  cursor: ComposerHistoryCursor | null;
  value: string;
  /** Where the caret goes: the start keeps a further Up on the first line, the end a Down on the last. */
  caret: 'start' | 'end';
}

/** The caret is collapsed and on the box's first line. */
export function caretOnFirstLine(value: string, start: number, end: number): boolean {
  return start === end && !value.slice(0, start).includes('\n');
}

/** The caret is collapsed and on the box's last line. */
export function caretOnLastLine(value: string, start: number, end: number): boolean {
  return start === end && !value.slice(end).includes('\n');
}

/** What Up or Down does, or null when the key is the textarea's own. */
export function composerHistoryStep(
  entries: readonly string[],
  cursor: ComposerHistoryCursor | null,
  direction: 'up' | 'down',
  value: string
): ComposerHistoryStep | null {
  if (direction === 'up') {
    if (entries.length === 0) return null;
    if (cursor === null) {
      const index = entries.length - 1;
      return {
        cursor: { index, draft: value },
        value: entries[index] ?? '',
        caret: caretFor(entries[index], 'up'),
      };
    }
    const index = Math.max(0, Math.min(cursor.index, entries.length) - 1);
    return {
      cursor: { ...cursor, index },
      value: entries[index] ?? '',
      caret: caretFor(entries[index], 'up'),
    };
  }
  if (cursor === null) return null;
  const index = cursor.index + 1;
  if (index >= entries.length) return { cursor: null, value: cursor.draft, caret: 'end' };
  return { cursor: { ...cursor, index }, value: entries[index] ?? '', caret: 'end' };
}

function caretFor(entry: string | undefined, direction: 'up' | 'down'): 'start' | 'end' {
  return direction === 'up' && entry?.includes('\n') ? 'start' : 'end';
}
