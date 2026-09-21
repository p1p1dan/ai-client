import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  bucketForBlock,
  deriveCompositionArcs,
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

/**
 * 2026-09-20 user report — the composition panel's second breakdown.
 *
 * The scenario these tests are built around is the real one from the report:
 * the by-role chart said 「助手 99% / 用户 0%」 and the cause was that every file
 * the agent read was a block on an assistant message. So the central assertion
 * is not "the buckets add up" (they must, and that is checked) but "the tool
 * traffic is separated out of the assistant bucket", which is the thing the old
 * chart could not do.
 */
describe('deriveConversationComposition buckets (2026-09-20)', () => {
  function toolCall(id: string, chars: number): ChatBlock {
    return {
      id,
      type: 'tool_call',
      toolCallId: id,
      toolName: 'Read',
      toolInput: 'x'.repeat(chars),
    };
  }

  it('separates tool output from the assistant bucket it rides on', () => {
    const composition = deriveConversationComposition([
      message('m1', 'user', [text('b1', 'u'.repeat(10))]),
      message('m2', 'assistant', [text('b2', 'a'.repeat(20)), toolCall('t1', 900)]),
    ]);
    const byId = new Map(composition.buckets.map((bucket) => [bucket.id, bucket]));
    expect(byId.get('user')?.chars).toBe(10);
    expect(byId.get('assistant')?.chars).toBe(20);
    expect(byId.get('tools')?.chars ?? 0).toBeGreaterThan(900);
    // The reading the report complained about: by SENDER the assistant holds
    // essentially everything…
    const assistantRole = composition.roles.find((role) => role.role === 'assistant');
    expect(assistantRole?.share ?? 0).toBeGreaterThan(0.9);
    // …while by CONTENT the tool bucket, not the prose, is the largest one.
    expect(composition.buckets[0]?.id).toBe('tools');
    expect(byId.get('assistant')?.share ?? 1).toBeLessThan(0.05);
  });

  it('counts the user message as instructions only when it is prose', () => {
    const composition = deriveConversationComposition([
      message('m1', 'user', [text('b1', 'do the thing')]),
      message('m2', 'assistant', [text('b2', 'done')]),
    ]);
    const byId = new Map(composition.buckets.map((bucket) => [bucket.id, bucket]));
    expect(byId.get('user')?.chars).toBe('do the thing'.length);
    expect(byId.get('assistant')?.chars).toBe('done'.length);
    expect(byId.has('tools')).toBe(false);
  });

  it("counts a user message's non-text blocks as tools, not as instruction", () => {
    // A tool result can arrive on a user-role message; it is still tool traffic.
    const composition = deriveConversationComposition([
      message('m1', 'user', [
        text('b1', 'ok'),
        { id: 'b2', type: 'tool_result', toolCallId: 't1', toolOutput: 'z'.repeat(50) },
      ]),
    ]);
    const byId = new Map(composition.buckets.map((bucket) => [bucket.id, bucket]));
    expect(byId.get('user')?.chars).toBe(2);
    expect(byId.get('tools')?.chars).toBe(50);
  });

  it('gives thinking its own bucket and app chrome to tools', () => {
    const composition = deriveConversationComposition([
      message('m1', 'assistant', [
        { id: 'b1', type: 'thinking', text: 't'.repeat(30) },
        { id: 'b2', type: 'question', questionId: 'q1', questions: [] },
        { id: 'b3', type: 'permission_request', permissionId: 'p1' },
      ]),
    ]);
    const byId = new Map(composition.buckets.map((bucket) => [bucket.id, bucket]));
    expect(byId.get('thinking')?.chars).toBe(30);
    expect(byId.has('assistant')).toBe(false);
    expect(byId.get('tools')?.blocks).toBe(2);
  });

  it('keeps the two breakdowns summing to the same total', () => {
    const composition = deriveConversationComposition([
      message('m1', 'user', [text('b1', 'u'.repeat(7))]),
      message('m2', 'assistant', [
        text('b2', 'a'.repeat(11)),
        { id: 'b3', type: 'thinking', text: 't'.repeat(13) },
        toolCall('t1', 17),
      ]),
      message('m3', 'assistant', [text('b4', 'b'.repeat(19))]),
    ]);
    const bucketTotal = composition.buckets.reduce((sum, bucket) => sum + bucket.chars, 0);
    const roleTotal = composition.roles.reduce((sum, role) => sum + role.chars, 0);
    expect(bucketTotal).toBe(composition.totalChars);
    expect(roleTotal).toBe(composition.totalChars);
  });

  it('orders buckets largest first, breaking ties by the fixed reading order', () => {
    // Every bucket holds exactly 10 characters, so only the tie-break decides —
    // and it must be the declared reading order, not insertion order (which
    // here is thinking → tools → assistant → user, i.e. the reverse).
    const ten = (id: string, type: ChatBlock['type'], role: ChatMessage['role']) =>
      message(id, role, [{ id: `${id}-b`, type, text: 'x'.repeat(10) }]);
    const composition = deriveConversationComposition([
      ten('m1', 'thinking', 'assistant'),
      message('m2', 'assistant', [
        { id: 'm2-b', type: 'tool_result', toolCallId: 't1', toolOutput: 'x'.repeat(10) },
      ]),
      ten('m3', 'text', 'assistant'),
      ten('m4', 'text', 'user'),
    ]);
    const byChars = composition.buckets.map((bucket) => bucket.chars);
    expect(byChars).toEqual([10, 10, 10, 10]);
    expect(composition.buckets.map((bucket) => bucket.id)).toEqual([
      'user',
      'assistant',
      'tools',
      'thinking',
    ]);
  });

  it('drops a bucket that holds nothing rather than reporting it at 0%', () => {
    const composition = deriveConversationComposition([
      message('m1', 'user', [text('b1', 'only prose')]),
    ]);
    expect(composition.buckets.map((bucket) => bucket.id)).toEqual(['user']);
    expect(composition.buckets[0]?.share).toBe(1);
  });
});

describe('bucketForBlock', () => {
  it('sends prose to the sender side and everything else to its content bucket', () => {
    expect(bucketForBlock('text', 'user')).toBe('user');
    expect(bucketForBlock('text', 'assistant')).toBe('assistant');
    expect(bucketForBlock('thinking', 'assistant')).toBe('thinking');
    for (const type of ['tool_call', 'tool_result', 'permission_request'] as const) {
      expect(bucketForBlock(type, 'assistant')).toBe('tools');
    }
  });
});

/**
 * The donut's geometry, shared by both breakdowns since 2026-09-20 (it used to
 * take `ConversationRoleShare[]`; it now takes any `{key, share}` slice, which
 * is what let the content-kind ring reuse it instead of growing a second copy
 * of the accumulated-offset loop).
 */
describe('deriveCompositionArcs', () => {
  it('lays arcs end to end from the accumulated share', () => {
    const arcs = deriveCompositionArcs([
      { key: 'a', share: 0.5 },
      { key: 'b', share: 0.25 },
      { key: 'c', share: 0.25 },
    ]);
    expect(arcs.map((arc) => [arc.key, arc.dash, arc.offset])).toEqual([
      ['a', 50, -0],
      ['b', 25, -50],
      ['c', 25, -75],
    ]);
  });

  it('gives a zero-share slice no ring and shifts nothing after it', () => {
    const arcs = deriveCompositionArcs([
      { key: 'a', share: 0.5 },
      { key: 'none', share: 0 },
      { key: 'b', share: 0.5 },
    ]);
    expect(arcs[1]?.dash).toBe(0);
    expect(arcs[2]?.offset).toBe(-50);
  });

  it('clamps a negative share instead of drawing backwards', () => {
    expect(deriveCompositionArcs([{ key: 'a', share: -0.3 }])[0]?.dash).toBe(0);
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
