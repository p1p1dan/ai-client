import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { flattenTurnItems, type Turn } from '../chatTurn';
import { buildTurnCopyText, buildTurnCopyTextFromItems } from '../turnCopy';

let seq = 0;

function message(role: ChatMessage['role'], blocks: ChatBlock[]): ChatMessage {
  seq += 1;
  return { id: `m${seq}`, sessionId: 's1', role, blocks };
}

function block(type: ChatBlock['type'], extra: Partial<ChatBlock> = {}): ChatBlock {
  seq += 1;
  return { id: `b${seq}`, type, ...extra };
}

function turnOf(body: ChatMessage[]): Turn {
  const userMessage = message('user', [block('text', { text: 'my question' })]);
  return { id: userMessage.id, user: userMessage, body };
}

describe('buildTurnCopyText (F-B7)', () => {
  it('F-B7: joins the turn prose blocks with a blank line, in block order', () => {
    const reply = message('assistant', [
      block('text', { text: 'first paragraph' }),
      block('text', { text: 'second paragraph' }),
    ]);
    expect(buildTurnCopyText(turnOf([reply]))).toBe('first paragraph\n\nsecond paragraph');
  });

  it('F-B7: spans every assistant message in the turn, in message order', () => {
    const first = message('assistant', [block('text', { text: 'alpha' })]);
    const second = message('assistant', [block('text', { text: 'beta' })]);
    expect(buildTurnCopyText(turnOf([first, second]))).toBe('alpha\n\nbeta');
  });

  // Tool payloads can carry absolute paths, environment values or secret
  // fragments; "copy this reply" must never become a way to lift them out.
  it('F-B7: excludes tool input, tool output and thinking bodies', () => {
    const reply = message('assistant', [
      block('thinking', { text: 'internal reasoning that must not leak' }),
      block('tool_call', {
        toolCallId: 't1',
        toolName: 'Bash',
        toolInput: { command: 'cat ~/.aws/credentials' },
      }),
      block('tool_result', {
        toolCallId: 't1',
        toolOk: true,
        toolOutput: 'aws_secret_access_key=SECRET',
      }),
      block('text', { text: 'the answer' }),
    ]);
    const copied = buildTurnCopyText(turnOf([reply]));
    expect(copied).toBe('the answer');
    expect(copied).not.toContain('internal reasoning');
    expect(copied).not.toContain('credentials');
    expect(copied).not.toContain('SECRET');
  });

  it('F-B7: an empty turn copies as an empty string', () => {
    expect(buildTurnCopyText(turnOf([]))).toBe('');
    expect(buildTurnCopyText(turnOf([message('assistant', [])]))).toBe('');
  });

  it('F-B7: a text block with no body contributes no stray blank line', () => {
    const reply = message('assistant', [
      block('text', { text: 'kept' }),
      block('text', {}),
      block('text', { text: 'also kept' }),
    ]);
    expect(buildTurnCopyText(turnOf([reply]))).toBe('kept\n\nalso kept');
  });

  it('excludes system/error notices — the reply is copied, not the client banners', () => {
    const reply = message('assistant', [block('text', { text: 'the answer' })]);
    const notice = message('error', [block('text', { text: 'Agent Host exited (code 1)' })]);
    expect(buildTurnCopyText(turnOf([reply, notice]))).toBe('the answer');
  });

  it('excludes the user prompt (§4.6 defines the payload as the reply)', () => {
    const turn = turnOf([message('assistant', [block('text', { text: 'the answer' })])]);
    expect(buildTurnCopyText(turn)).not.toContain('my question');
  });
});

/**
 * Review batch F7: `MessageTimeline` flattens each turn once for rendering and
 * derives the copy payload from those items, instead of re-flattening the whole
 * turn on every render (clock ticks included). The two entry points must stay
 * one payload — a copy button that yields something different from what the
 * `Turn` form was audited to yield would quietly re-open F-B7's exclusion.
 */
describe('buildTurnCopyTextFromItems (F7)', () => {
  const cases: Array<[string, ChatMessage[]]> = [
    ['prose only', [message('assistant', [block('text', { text: 'alpha' })])]],
    [
      'prose across two assistant messages',
      [
        message('assistant', [block('text', { text: 'alpha' })]),
        message('assistant', [block('text', { text: 'beta' })]),
      ],
    ],
    [
      'prose interleaved with tool and thinking blocks',
      [
        message('assistant', [
          block('text', { text: 'before' }),
          block('thinking', { text: 'secret reasoning' }),
          block('tool_call', { toolName: 'Bash', toolInput: { command: 'cat ~/.env' } }),
          block('tool_result', { toolOutput: 'API_KEY=live' }),
          block('text', { text: 'after' }),
        ]),
      ],
    ],
    [
      'a turn ending in an error notice',
      [
        message('assistant', [block('text', { text: 'the answer' })]),
        message('error', [block('text', { text: 'Agent Host exited (code 1)' })]),
      ],
    ],
    ['an empty body', []],
  ];

  for (const [name, body] of cases) {
    it(`F7: matches the Turn form — ${name}`, () => {
      const turn = turnOf(body);
      expect(buildTurnCopyTextFromItems(flattenTurnItems(turn))).toBe(buildTurnCopyText(turn));
    });
  }

  it('F7: still excludes tool payloads when called through the item form', () => {
    const turn = turnOf([
      message('assistant', [
        block('tool_call', { toolName: 'Bash', toolInput: { command: 'cat ~/.env' } }),
        block('tool_result', { toolOutput: 'API_KEY=live' }),
        block('text', { text: 'the answer' }),
      ]),
    ]);
    const copied = buildTurnCopyTextFromItems(flattenTurnItems(turn));
    expect(copied).toBe('the answer');
    expect(copied).not.toContain('API_KEY');
    expect(copied).not.toContain('.env');
  });
});
