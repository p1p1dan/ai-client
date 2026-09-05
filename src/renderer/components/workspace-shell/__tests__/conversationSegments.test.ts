import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  deriveConversationComposition,
  formatCharCount,
  formatShare,
  SEGMENT_BODY_MAX_CHARS,
} from '../surfaces/conversationSegments';

function message(id: string, role: ChatMessage['role'], blocks: ChatBlock[] = []): ChatMessage {
  return { id, sessionId: 's1', role, blocks };
}

function text(id: string, value: string): ChatBlock {
  return { id, type: 'text', text: value };
}

describe('deriveConversationComposition (U07)', () => {
  it('sizes each message from every block it carries, not just its text', () => {
    const composition = deriveConversationComposition([
      message('m1', 'assistant', [
        text('b1', 'hello'),
        {
          id: 'b2',
          type: 'tool_call',
          toolCallId: 't1',
          toolName: 'Read',
          toolInput: { path: '/a' },
        },
      ]),
    ]);
    const [segment] = composition.segments;
    // 'hello' + 'Read' + JSON.stringify({path:'/a'})
    expect(segment.chars).toBe(5 + 4 + JSON.stringify({ path: '/a' }).length);
    expect(segment.detail).toContain('1');
  });

  it('lists newest first and keeps role shares in size order', () => {
    const composition = deriveConversationComposition([
      message('m1', 'user', [text('b1', 'a'.repeat(10))]),
      message('m2', 'assistant', [text('b2', 'b'.repeat(90))]),
    ]);
    expect(composition.segments.map((s) => s.id)).toEqual(['m2', 'm1']);
    expect(composition.totalMessages).toBe(2);
    expect(composition.totalChars).toBe(100);
    expect(composition.roles.map((r) => [r.role, r.chars, r.share])).toEqual([
      ['assistant', 90, 0.9],
      ['user', 10, 0.1],
    ]);
  });

  it('collapses a preview to one line and caps the expanded body', () => {
    const long = 'x'.repeat(SEGMENT_BODY_MAX_CHARS + 50);
    const [segment] = deriveConversationComposition([
      message('m1', 'assistant', [text('b1', `first\n\nsecond ${long}`)]),
    ]).segments;
    expect(segment.preview).not.toContain('\n');
    expect(segment.preview.endsWith('…')).toBe(true);
    expect(segment.body).toHaveLength(SEGMENT_BODY_MAX_CHARS);
    expect(segment.truncated).toBe(true);
  });

  it('keeps a tool-only message listed, with an empty preview rather than invented text', () => {
    const [segment] = deriveConversationComposition([
      message('m1', 'assistant', [
        { id: 'b1', type: 'tool_call', toolCallId: 't1', toolName: 'Bash' },
      ]),
    ]).segments;
    expect(segment.preview).toBe('');
    expect(segment.truncated).toBe(false);
    expect(segment.chars).toBe(4);
  });

  it('survives an unserializable tool payload instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const [segment] = deriveConversationComposition([
      message('m1', 'assistant', [
        { id: 'b1', type: 'tool_result', toolCallId: 't1', toolOutput: circular },
      ]),
    ]).segments;
    expect(segment.chars).toBe(0);
  });

  it('reports an empty conversation without dividing by zero', () => {
    const composition = deriveConversationComposition([]);
    expect(composition).toMatchObject({ totalMessages: 0, totalChars: 0, roles: [], segments: [] });
  });
});

describe('formatCharCount / formatShare', () => {
  it('switches units at a thousand and a million', () => {
    expect(formatCharCount(999)).toBe('999');
    expect(formatCharCount(1000)).toBe('1.0k');
    expect(formatCharCount(12_345)).toBe('12.3k');
    expect(formatCharCount(2_500_000)).toBe('2.5M');
  });

  it('floors the share so a sliver never rounds up to a percent it does not have', () => {
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.009)).toBe('0%');
    expect(formatShare(0.999)).toBe('99%');
    expect(formatShare(1)).toBe('100%');
  });
});
