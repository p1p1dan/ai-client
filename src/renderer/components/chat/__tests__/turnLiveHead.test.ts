import { englishTranslate, zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import type { TurnItem } from '../chatTurn';
import type { ToolRun } from '../toolCard';
import {
  deriveTurnLivePhase,
  formatTerminalLiveActivity,
  formatTerminalLiveTail,
  formatTurnLiveLine,
  liveClockText,
  turnElapsedText,
} from '../turnLiveHead';
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

  // Decision 211 (user, 2026-11-09): one word for one state wherever it is drawn —
  // the thought row's English `Thinking…`, the CLI's spinner verbs — and the clock
  // in the thought row's units. The running icon goes before it; no `✻` of its own.
  it('puts the verb first, then the clock, and no ↑/↓ counts (2026-10-19)', () => {
    expect(formatTurnLiveLine({ kind: 'connecting' }, clock)).toBe('Connecting… 3s');
    expect(formatTurnLiveLine({ kind: 'thinking', promptChars: 15 }, clock)).toBe('Thinking… 3s');
    expect(formatTurnLiveLine({ kind: 'replying', replyChars: 1234 }, clock)).toBe('Replying… 3s');
    expect(formatTurnLiveLine({ kind: 'tool', verb: 'Running' }, clock)).toBe('Running… 3s');
    expect(
      formatTurnLiveLine({ kind: 'thinking', promptChars: 0 }, { minutes: 1, seconds: 5 })
    ).toBe('Thinking… 1m 5s');
    // The fallback still names itself: a bare clock reads as a stopwatch.
    expect(formatTurnLiveLine({ kind: 'working' }, { minutes: 2, seconds: 0 })).toBe('Working… 2m');
  });

  it('never translates the words: no 「思考中」 beside an English `Thinking…`', () => {
    const words = [
      formatTurnLiveLine({ kind: 'thinking', promptChars: 0 }, clock),
      formatTerminalLiveActivity({ kind: 'thinking', promptChars: 0 }, null),
      formatTerminalLiveActivity({ kind: 'working' }, null),
      formatTerminalLiveActivity({ kind: 'connecting' }, null),
    ].join(' ');
    expect(words).not.toMatch(/[一-鿿]/);
  });

  it('omits what it does not have: no clock, nothing sent or received yet', () => {
    expect(formatTurnLiveLine({ kind: 'thinking', promptChars: 0 }, null)).toBe('Thinking…');
    expect(formatTurnLiveLine({ kind: 'replying', replyChars: 0 }, clock)).toBe('Replying… 3s');
    expect(turnElapsedText(englishTranslate, null)).toBeNull();
    expect(liveClockText(null)).toBeNull();
  });

  it('keeps the settled bill’s clock in the reader’s words', () => {
    expect(turnElapsedText(zh, { minutes: 1, seconds: 5 })).toBe('1 分 5 秒');
  });
});

/**
 * Decision 208, terminal style (user ruling 2026-11-03, the comparison
 * mockup's ①): 「✻ 跑测试… (12 秒 · esc 中断)」 — the running step in its own
 * words, how long, and how to stop it. Decision 211: `12s`, and the tail rides
 * on the live row when there is one.
 */
describe('[D208-LIVE] the terminal style live line', () => {
  it('names the running step in its own words, else the phase', () => {
    expect(formatTerminalLiveActivity({ kind: 'tool', verb: 'Running' }, '跑测试')).toBe('跑测试…');
    // A step with nothing to say for itself falls back to its verb, untranslated.
    expect(formatTerminalLiveActivity({ kind: 'tool', verb: 'Running' }, null)).toBe('Running…');
    // Decision 211: the thought row's word, not 「思考中」.
    expect(formatTerminalLiveActivity({ kind: 'thinking', promptChars: 0 }, null)).toBe(
      'Thinking…'
    );
    expect(formatTerminalLiveActivity({ kind: 'replying', replyChars: 3 }, null)).toBe('Replying…');
    expect(formatTerminalLiveActivity({ kind: 'working' }, null)).toBe('Working…');
    expect(formatTerminalLiveActivity({ kind: 'connecting' }, null)).toBe('Connecting…');
  });

  it('closes on how long and how to stop it, and on the stop alone with no clock', () => {
    expect(formatTerminalLiveTail(zh, { minutes: 0, seconds: 12 })).toBe('(12s · esc 中断)');
    expect(formatTerminalLiveTail(zh, { minutes: 1, seconds: 5 })).toBe('(1m 5s · esc 中断)');
    expect(formatTerminalLiveTail(zh, { minutes: 10, seconds: 37 })).toBe('(10m 37s · esc 中断)');
    expect(formatTerminalLiveTail(zh, null)).toBe('(esc 中断)');
  });
});
