import { englishTranslate, zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import type { TurnItem } from '../chatTurn';
import type { ToolRun } from '../toolCard';
import { deriveTurnLivePhase, formatTurnLiveLine, turnElapsedText } from '../turnLiveHead';
import type { TurnCurrentAction } from '../turnProcessFold';

// S-6 feedback 11c (user, 2026-10-17): the running turn's one line, verb first.
const zh = (key: string, params?: Record<string, string | number>) =>
  englishTranslate(zhTranslations[key] ?? key, params);

const text = (value: string): TurnItem =>
  ({
    kind: 'text',
    block: { id: value, type: 'text', text: value },
    blockIndex: 0,
    messageId: 'm',
  }) as TurnItem;
const thinking: TurnItem = {
  kind: 'toolGroup',
  entries: [{ kind: 'thinking', block: { id: 't', type: 'thinking', text: '…' }, blockIndex: 0 }],
  blockIndex: 0,
  messageId: 'm',
} as TurnItem;
const running: TurnCurrentAction = {
  run: { toolName: 'Bash', status: 'running' } as ToolRun,
  verb: 'Running',
  state: 'running',
};
const refused: TurnCurrentAction = { ...running, state: 'refused', verb: 'Run' };

describe('deriveTurnLivePhase', () => {
  it('connecting while the send handshakes, whatever else is on screen', () => {
    expect(
      deriveTurnLivePhase({ send: { phase: 'handshake', promptChars: 5 }, items: [], action: null })
    ).toEqual({ kind: 'connecting' });
  });

  it('thinking, with what was sent, until the first byte', () => {
    expect(
      deriveTurnLivePhase({ send: { phase: 'awaiting', promptChars: 15 }, items: [], action: null })
    ).toEqual({ kind: 'thinking', promptChars: 15 });
  });

  it('a running tool says its own verb', () => {
    expect(deriveTurnLivePhase({ send: null, items: [text('a')], action: running })).toEqual({
      kind: 'tool',
      verb: 'Running',
    });
  });

  it('replying while text streams, counting every reply character so far', () => {
    expect(
      deriveTurnLivePhase({
        send: null,
        items: [text('ab'), thinking, text('cde')],
        action: refused,
      })
    ).toEqual({ kind: 'replying', replyChars: 5 });
  });

  it('thinking after a thought or a finished tool call: the model works out what is next', () => {
    expect(deriveTurnLivePhase({ send: null, items: [text('a'), thinking], action: null })).toEqual(
      {
        kind: 'thinking',
        promptChars: 0,
      }
    );
    expect(deriveTurnLivePhase({ send: null, items: [thinking], action: refused })).toEqual({
      kind: 'thinking',
      promptChars: 0,
    });
  });

  it('falls back to working when nothing more specific is known', () => {
    expect(deriveTurnLivePhase({ send: null, items: [], action: null })).toEqual({
      kind: 'working',
    });
  });
});

describe('formatTurnLiveLine', () => {
  const clock = { minutes: 0, seconds: 3 };

  it('puts the verb first, then the clock, then the counts', () => {
    expect(formatTurnLiveLine(englishTranslate, { kind: 'connecting' }, clock)).toBe(
      '✻ Connecting to the chat engine… 3s'
    );
    expect(formatTurnLiveLine(englishTranslate, { kind: 'thinking', promptChars: 15 }, clock)).toBe(
      '✻ Thinking 3s · ↑ 15 chars'
    );
    expect(
      formatTurnLiveLine(englishTranslate, { kind: 'replying', replyChars: 1234 }, clock)
    ).toBe('✻ Replying 3s · ↓ 1.2k chars');
    expect(formatTurnLiveLine(englishTranslate, { kind: 'tool', verb: 'Running' }, clock)).toBe(
      '✻ Running 3s'
    );
  });

  it('reads in Chinese', () => {
    expect(formatTurnLiveLine(zh, { kind: 'connecting' }, { minutes: 0, seconds: 1 })).toBe(
      '✻ 正在连接对话引擎… 1 秒'
    );
    expect(formatTurnLiveLine(zh, { kind: 'thinking', promptChars: 15 }, clock)).toBe(
      '✻ 思考中 3 秒 · ↑ 15 字符'
    );
    expect(
      formatTurnLiveLine(zh, { kind: 'replying', replyChars: 1234 }, { minutes: 1, seconds: 5 })
    ).toBe('✻ 回复中 1 分 5 秒 · ↓ 1.2k 字符');
    expect(
      formatTurnLiveLine(zh, { kind: 'tool', verb: 'Running' }, { minutes: 2, seconds: 0 })
    ).toBe('✻ 运行中 2 分');
  });

  it('omits what it does not have: no clock, nothing sent or received yet', () => {
    expect(formatTurnLiveLine(englishTranslate, { kind: 'thinking', promptChars: 0 }, null)).toBe(
      '✻ Thinking'
    );
    expect(formatTurnLiveLine(englishTranslate, { kind: 'replying', replyChars: 0 }, clock)).toBe(
      '✻ Replying 3s'
    );
    expect(turnElapsedText(englishTranslate, null)).toBeNull();
  });
});
