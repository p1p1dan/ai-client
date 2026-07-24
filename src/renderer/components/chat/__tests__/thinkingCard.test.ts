import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  deriveThinkingCard,
  isThinkingCapable,
  isTurnActive,
  type ThinkingCardViewModel,
} from '../thinkingCard';

function message(blocks: ChatBlock[]): ChatMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'assistant',
    blocks,
  } as ChatMessage;
}

function thinkingBlock(extra: Partial<ChatBlock> = {}): ChatBlock {
  return { id: 'tb1', type: 'thinking', text: '', ...extra } as ChatBlock;
}

describe('deriveThinkingCard (T-04)', () => {
  it('returns null for non-thinking block (text)', () => {
    const msg = message([{ id: 'b1', type: 'text', text: 'hi' }]);
    expect(deriveThinkingCard(msg, 0, true)).toBeNull();
  });

  it('returns null when blockIndex is out of range', () => {
    const msg = message([thinkingBlock()]);
    expect(deriveThinkingCard(msg, 99, true)).toBeNull();
  });

  it('marks thinking as streaming when it is the last block and turn is active', () => {
    const msg = message([thinkingBlock({ text: 'Let me ' })]);
    expect(deriveThinkingCard(msg, 0, true)).toEqual<ThinkingCardViewModel>({
      state: 'streaming',
      text: 'Let me ',
    });
  });

  it('marks thinking as done when turn is idle even if it is the last block', () => {
    const msg = message([thinkingBlock({ text: 'Plan done.' })]);
    expect(deriveThinkingCard(msg, 0, false)).toEqual<ThinkingCardViewModel>({
      state: 'done',
      text: 'Plan done.',
    });
  });

  it('marks thinking as done when a later block already arrived (mid-turn: tool/text after)', () => {
    const msg = message([
      thinkingBlock({ text: 'thinking...' }),
      { id: 'tool1', type: 'tool_call', toolName: 'Bash', text: '' } as ChatBlock,
    ]);
    expect(deriveThinkingCard(msg, 0, true)).toEqual<ThinkingCardViewModel>({
      state: 'done',
      text: 'thinking...',
    });
  });

  it('maintains streaming text accumulation shape (delta leaves block in place, text grows)', () => {
    const msg = message([thinkingBlock({ text: 'Step 1. Step 2. Step 3.' })]);
    expect(deriveThinkingCard(msg, 0, true)).toEqual<ThinkingCardViewModel>({
      state: 'streaming',
      text: 'Step 1. Step 2. Step 3.',
    });
  });

  it('handles empty text thinking block (started but no delta yet)', () => {
    const msg = message([thinkingBlock({ text: '' })]);
    expect(deriveThinkingCard(msg, 0, true)).toEqual<ThinkingCardViewModel>({
      state: 'streaming',
      text: '',
    });
  });
});

describe('isTurnActive (T-04)', () => {
  it.each(['running', 'starting'])('returns true for %s', (status) => {
    expect(isTurnActive(status)).toBe(true);
  });

  it.each([
    'idle',
    'completed',
    'failed',
    'stopping',
    'disconnected',
    'waiting_permission',
    'waiting_question',
    'unknown',
  ])('returns false for %s', (status) => {
    expect(isTurnActive(status)).toBe(false);
  });
});

describe('isThinkingCapable (T-04 capability gate)', () => {
  it('returns true when thinking flag is explicitly true', () => {
    expect(isThinkingCapable({ thinking: true })).toBe(true);
  });

  it('returns true when capabilities object is undefined (old Host / pre-host.ready — default on)', () => {
    expect(isThinkingCapable(undefined)).toBe(true);
  });

  it('returns true when capabilities exists but thinking flag is missing (default on)', () => {
    expect(isThinkingCapable({})).toBe(true);
  });

  it('returns false only when thinking is explicitly disabled by Host', () => {
    expect(isThinkingCapable({ thinking: false })).toBe(false);
  });
});
