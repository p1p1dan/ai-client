import { describe, expect, it } from 'vitest';
import {
  CHAT_TRANSCRIPT_STYLES,
  DEFAULT_CHAT_TRANSCRIPT_STYLE,
  isChatTranscriptStyle,
  resolveChatTranscriptStyle,
} from '../types/chatTranscriptStyle';

/**
 * Decision 208 (user ruling 2026-11-03): two styles, terminal by default, and
 * no third value for the look before the setting.
 */
describe('chat transcript style', () => {
  it('offers exactly the two styles the user chose, terminal first and by default', () => {
    expect(CHAT_TRANSCRIPT_STYLES).toEqual(['terminal', 'desktop']);
    expect(DEFAULT_CHAT_TRANSCRIPT_STYLE).toBe('terminal');
  });

  it('accepts only the two values', () => {
    expect(isChatTranscriptStyle('terminal')).toBe(true);
    expect(isChatTranscriptStyle('desktop')).toBe(true);
    for (const value of ['classic', 'Terminal', '', undefined, null, 1, {}]) {
      expect(isChatTranscriptStyle(value)).toBe(false);
    }
  });

  it('resolves a missing or unknown value to the default', () => {
    expect(resolveChatTranscriptStyle('desktop')).toBe('desktop');
    expect(resolveChatTranscriptStyle(undefined)).toBe('terminal');
    expect(resolveChatTranscriptStyle('classic')).toBe('terminal');
  });
});
