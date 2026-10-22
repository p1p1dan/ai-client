import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  estimatePromptLines,
  PROMPT_FOLD_THRESHOLD_LINES,
  PROMPT_FOLDED_LINES,
  promptFolds,
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
  it('clips to the folded line count in the box’s own lines, with the 3rem fade', () => {
    const cls = userBubbleFoldClass(true);
    expect(cls).toContain(`max-h-[${PROMPT_FOLDED_LINES}lh]`);
    expect(cls).toContain('overflow-hidden');
    expect(cls).toContain('calc(100%-3rem)');
    // `lh` must be the prose line, so the box pins the prose size and leading.
    expect(cls).toContain('text-chat-body');
    expect(cls).toContain('leading-[1.43]');
    expect(PROMPT_FOLDED_LINES).toBeLessThan(PROMPT_FOLD_THRESHOLD_LINES);
  });

  it('open is no class at all, and the text box itself stays a constant (F10)', () => {
    expect(userBubbleFoldClass(false)).toBe('');
    expect(userBubbleTextClass()).toBe('select-text space-y-2');
  });

  it('nothing in the bubble measures itself', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../MessageTimeline.tsx', import.meta.url)),
      'utf8'
    );
    const bubble = source.slice(
      source.indexOf('function UserBubble('),
      source.indexOf('\n}\n', source.indexOf('function UserBubble('))
    );
    expect(bubble).toContain('promptFolds(');
    for (const banned of ['ResizeObserver', 'scrollHeight', 'getBoundingClientRect', 'useRef']) {
      expect(bubble, banned).not.toContain(banned);
    }
  });
});
