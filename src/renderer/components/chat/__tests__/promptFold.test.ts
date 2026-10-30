import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  estimatePromptLines,
  PROMPT_FOLD_MIN_PX,
  PROMPT_FOLD_THRESHOLD_LINES,
  PROMPT_FOLDED_PX,
  promptFolds,
  promptFoldsAtHeight,
  userBubbleFoldClass,
  userBubbleTextClass,
} from '../chatTimelineLayout';

/**
 * Issue #26 item 5: a long prompt folds, decided from its text. F10 forbids a
 * fold that depends on measured geometry, so the decision is a pure function
 * of the string and the clip is CSS of the user's boolean.
 */
describe('estimatePromptLines', () => {
  it('counts hard breaks, and an empty line as a line', () => {
    expect(estimatePromptLines('a')).toBe(1);
    expect(estimatePromptLines('a\n\nb')).toBe(3);
    expect(estimatePromptLines('a\r\nb')).toBe(2);
  });

  it('wraps by width, a CJK character counting two', () => {
    expect(estimatePromptLines('x'.repeat(76))).toBe(1);
    expect(estimatePromptLines('x'.repeat(77))).toBe(2);
    expect(estimatePromptLines('中'.repeat(38))).toBe(1);
    expect(estimatePromptLines('中'.repeat(39))).toBe(2);
  });
});

describe('promptFolds', () => {
  it('folds above the threshold and not at it', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
    expect(promptFolds(lines(PROMPT_FOLD_THRESHOLD_LINES))).toBe(false);
    expect(promptFolds(lines(PROMPT_FOLD_THRESHOLD_LINES + 1))).toBe(true);
    // One long pasted paragraph folds too.
    expect(promptFolds('word '.repeat(400))).toBe(true);
  });
});

describe('userBubbleFoldClass', () => {
  it('clips to ~300px (FR-01.5) with the 3rem fade', () => {
    const cls = userBubbleFoldClass(true);
    expect(cls).toContain('max-h-75'); // 18.75rem = PROMPT_FOLDED_PX
    expect(PROMPT_FOLDED_PX).toBe(300);
    expect(cls).toContain('overflow-hidden');
    expect(cls).toContain('calc(100%-3rem)');
    expect(cls).toContain('text-chat-body');
    expect(cls).toContain('leading-[1.43]');
  });

  it('[PILAB-R1-01.5] folds by measured full height, only when that hides ~2 lines, with hysteresis', () => {
    expect(promptFoldsAtHeight(PROMPT_FOLD_MIN_PX)).toBe(false);
    expect(promptFoldsAtHeight(PROMPT_FOLD_MIN_PX + 1)).toBe(true);
    // A narrow pane that wraps a prompt the text estimate called short still folds.
    expect(promptFolds('short line\n'.repeat(10))).toBe(false);
    expect(promptFoldsAtHeight(520)).toBe(true);
    // Already folded: stays folded down to the folded height, so a width wobble cannot flip it.
    expect(promptFoldsAtHeight(320, true)).toBe(true);
    expect(promptFoldsAtHeight(300, true)).toBe(false);
  });

  it('open is no class at all, and the text box itself stays a constant (F10)', () => {
    expect(userBubbleFoldClass(false)).toBe('');
    expect(userBubbleTextClass()).toBe('select-text space-y-2');
  });

  it('the bubble measures only its own full height, never scroll position (F10)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../MessageTimeline.tsx', import.meta.url)),
      'utf8'
    );
    const bubble = source.slice(
      source.indexOf('function UserBubble('),
      source.indexOf('\n}\n', source.indexOf('function UserBubble('))
    );
    expect(bubble).toContain('promptFolds(');
    expect(bubble).toContain('promptFoldsAtHeight(height, was === true)');
    for (const banned of [
      'scrollTop',
      'getBoundingClientRect',
      'IntersectionObserver',
      'clientHeight',
    ]) {
      expect(bubble, banned).not.toContain(banned);
    }
  });
});
