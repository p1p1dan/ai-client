import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../stores/chatSessions';
import {
  caretOnFirstLine,
  caretOnLastLine,
  composerHistoryEntries,
  composerHistoryStep,
} from '../composerHistory.ts';

/**
 * Up/Down through this chat's sent lines, as the official client's composer
 * does ("History 2/3"): the draft survives a round trip, the walk stops at the
 * oldest entry, and only a caret on the edge line hands the key over.
 */

function message(role: ChatMessage['role'], ...texts: string[]): ChatMessage {
  return {
    id: `${role}-${texts.join('|')}`,
    sessionId: 's',
    role,
    blocks: texts.map((text, i) => ({ id: `b${i}`, type: 'text', text })),
  } as ChatMessage;
}

describe('composerHistoryEntries', () => {
  it('lists the user lines oldest first, without blanks or an immediate repeat', () => {
    expect(
      composerHistoryEntries([
        message('user', 'first'),
        message('assistant', 'reply'),
        message('user', '  '),
        message('user', 'sec', 'ond'),
        message('user', 'second'),
        message('user', 'third'),
      ])
    ).toEqual(['first', 'second', 'third']);
    expect(composerHistoryEntries(undefined)).toEqual([]);
  });
});

describe('composerHistoryStep', () => {
  const entries = ['one', 'two', 'three'];

  it('starts at the newest entry and keeps the draft', () => {
    expect(composerHistoryStep(entries, null, 'up', 'draft')).toEqual({
      cursor: { index: 2, draft: 'draft' },
      value: 'three',
      caret: 'end',
    });
  });

  it('walks older, stops at the oldest, and Down brings the draft back past the newest', () => {
    let step = composerHistoryStep(entries, null, 'up', 'draft');
    step = composerHistoryStep(entries, step?.cursor ?? null, 'up', step?.value ?? '');
    expect(step?.value).toBe('two');
    step = composerHistoryStep(entries, step?.cursor ?? null, 'up', step?.value ?? '');
    expect(step?.value).toBe('one');
    step = composerHistoryStep(entries, step?.cursor ?? null, 'up', step?.value ?? '');
    expect(step).toMatchObject({ value: 'one', cursor: { index: 0 } });
    step = composerHistoryStep(entries, step?.cursor ?? null, 'down', step?.value ?? '');
    expect(step?.value).toBe('two');
    step = composerHistoryStep(entries, { index: 2, draft: 'draft' }, 'down', 'three');
    expect(step).toEqual({ cursor: null, value: 'draft', caret: 'end' });
  });

  it('leaves the key to the textarea with nothing to show or nothing being browsed', () => {
    expect(composerHistoryStep([], null, 'up', '')).toBeNull();
    expect(composerHistoryStep(entries, null, 'down', 'draft')).toBeNull();
  });

  it('puts the caret at the start of a multi-line entry going up, so the next Up keeps walking', () => {
    expect(composerHistoryStep(['a\nb'], null, 'up', '')?.caret).toBe('start');
  });
});

describe('caret edges', () => {
  it('needs a collapsed caret on the first or the last line', () => {
    expect(caretOnFirstLine('ab\ncd', 1, 1)).toBe(true);
    expect(caretOnFirstLine('ab\ncd', 4, 4)).toBe(false);
    expect(caretOnFirstLine('ab', 0, 2)).toBe(false);
    expect(caretOnLastLine('ab\ncd', 4, 4)).toBe(true);
    expect(caretOnLastLine('ab\ncd', 1, 1)).toBe(false);
  });
});
