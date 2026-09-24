import { describe, expect, it } from 'vitest';
import { translate } from '../../shared/i18n.ts';
import { RUN_STOP_CUSTOM_TYPE } from '../../shared/types/sessionHistory.ts';
import { paginatePiSessionHistory, projectPiSessionHistory } from '../piSessionTimeline.ts';

function manager(branch: unknown[]) {
  return { getBranch: () => branch };
}

describe('Pi session timeline projection', () => {
  it('projects only the active branch with stable Pi-derived ids and tool results', () => {
    const history = projectPiSessionHistory(
      manager([
        {
          type: 'message',
          id: 'u1',
          parentId: null,
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        },
        {
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: {
            role: 'assistant',
            provider: 'test',
            model: 'model',
            content: [
              { type: 'thinking', thinking: 'plan' },
              { type: 'text', text: 'reading' },
              { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
            ],
            stopReason: 'toolUse',
          },
        },
        {
          type: 'message',
          id: 'r1',
          parentId: 'a1',
          timestamp: '2026-01-01T00:00:02.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'contents' }],
            isError: false,
          },
        },
      ])
    );

    expect(history.map((message) => [message.id, message.entryId, message.role])).toEqual([
      ['h:u1', 'u1', 'user'],
      ['h:a1', 'a1', 'assistant'],
    ]);
    expect(history[1]).toMatchObject({ model: 'test/model' });
    expect(history[1]?.incomplete).toBeUndefined();
    expect(history[1]?.blocks.map((block) => block.type)).toEqual([
      'thinking',
      'text',
      'tool_call',
      'tool_result',
    ]);
    expect(history[1]?.blocks.at(-1)).toMatchObject({
      type: 'tool_result',
      toolCallId: 'call-1',
      ok: true,
      output: 'contents',
    });
  });

  it('keeps compaction and visible custom branch entries as system notices', () => {
    const history = projectPiSessionHistory(
      manager([
        { type: 'compaction', id: 'compact-1', summary: 'Earlier context' },
        {
          type: 'custom_message',
          id: 'custom-1',
          customType: 'extension-note',
          content: 'Visible extension note',
          display: true,
        },
        {
          type: 'custom_message',
          id: 'custom-hidden',
          content: 'hidden',
          display: false,
        },
      ])
    );

    expect(history.map((message) => [message.id, message.role])).toEqual([
      ['h:compact-1', 'system'],
      ['h:custom-1', 'system'],
    ]);
    expect(history[0]?.blocks[0]).toMatchObject({
      type: 'text',
      text: 'Context summary\n\nEarlier context',
    });
  });

  it('marks a true empty assistant leaf incomplete but keeps an empty tool bridge complete', () => {
    const interrupted = projectPiSessionHistory(
      manager([
        {
          type: 'message',
          id: 'u1',
          message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
        },
        { type: 'message', id: 'a-empty', message: { role: 'assistant', content: [] } },
      ])
    );
    expect(interrupted.at(-1)).toMatchObject({
      id: 'h:a-empty',
      incomplete: true,
      stopReason: 'interrupted',
    });

    const bridge = projectPiSessionHistory(
      manager([
        {
          type: 'message',
          id: 'u1',
          message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
        },
        {
          type: 'message',
          id: 'a-tool',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }],
          },
        },
      ])
    );
    expect(bridge.at(-1)).toMatchObject({ id: 'h:a-tool' });
    expect(bridge.at(-1)?.incomplete).toBeUndefined();
  });

  it('paginates backwards from the leaf with bounded limits and empty beyond total', () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
      id: `h:${index}` as const,
      entryId: String(index),
      role: 'user' as const,
      blocks: [],
    }));
    expect(paginatePiSessionHistory(messages, 0, 80)).toMatchObject({
      offset: 0,
      limit: 80,
      totalCount: 205,
      hasMore: true,
    });
    expect(paginatePiSessionHistory(messages, 0, 80).messages[0]?.id).toBe('h:125');
    expect(paginatePiSessionHistory(messages, 80, 80).messages[0]?.id).toBe('h:45');
    expect(paginatePiSessionHistory(messages, 205, 80).messages).toEqual([]);
    expect(paginatePiSessionHistory(messages, 999, 999).limit).toBe(500);
    expect(paginatePiSessionHistory(messages, -1, 0).limit).toBe(1);
  });
});

it('preserves SDK edit patch on history reload', () => {
  const patch = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new';
  const history = projectPiSessionHistory(
    manager([
      {
        type: 'message',
        id: 'a',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 't',
              name: 'edit',
              arguments: { path: 'file', oldText: 'old', newText: 'new' },
            },
          ],
          stopReason: 'toolUse',
        },
      },
      {
        type: 'message',
        id: 'r',
        message: {
          role: 'toolResult',
          toolCallId: 't',
          toolName: 'edit',
          content: [{ type: 'text', text: 'done' }],
          details: { patch },
          isError: false,
        },
      },
    ])
  );
  expect(history[0].blocks.at(-1)).toMatchObject({
    type: 'tool_result',
    output: 'done',
    patch,
  });
});

/**
 * T023 — the imported-history banner.
 *
 * It was a Chinese template literal built in this projector, defended by the
 * (true) observation that a worker has no renderer locale. The fix is not to
 * pick the other language: it is to send both halves of the sentence — the
 * catalog key and its two values — and let the surface that knows the locale
 * assemble it. `text` stays the English rendering so a reader that ignores
 * `notice` still prints something whole.
 *
 * Nothing stored has to change for this: the session file holds a `custom`
 * entry with `sourceKind` / `sourceSessionId` and never the sentence, so an
 * import from last week re-renders in today's wording.
 */
describe('imported-history banner (T023)', () => {
  const projected = () =>
    projectPiSessionHistory(
      manager([
        {
          type: 'custom',
          id: 'p1',
          customType: 'aiclient.legacy-import.provenance',
          data: { sourceKind: 'claude-code', sourceSessionId: 'abc-123' },
        },
      ])
    );

  it('emits a translatable notice with the two values, not a finished sentence', () => {
    const block = projected()[0]?.blocks[0] as {
      type: string;
      text: string;
      notice?: { key: string; params?: Record<string, string> };
    };
    expect(block.notice?.params).toEqual({
      sourceKind: 'claude-code',
      sourceSessionId: 'abc-123',
    });
    expect(block.notice?.key).toContain('{{sourceKind}}');
    expect(block.notice?.key).toContain('{{sourceSessionId}}');
    // The whole point: nothing Chinese crosses the worker boundary any more.
    expect(/[一-鿿]/.test(block.text)).toBe(false);
    expect(/[一-鿿]/.test(block.notice?.key ?? '')).toBe(false);
  });

  it('renders both languages from that one notice', () => {
    const block = projected()[0]?.blocks[0] as {
      text: string;
      notice: { key: string; params: Record<string, string> };
    };
    // English is already in `text`, byte for byte — a surface that never
    // learned about `notice` is not broken by this change, just untranslated.
    expect(translate('en', block.notice.key, block.notice.params)).toBe(block.text);
    expect(block.text).toContain('imported from a claude-code session (abc-123)');

    const chinese = translate('zh', block.notice.key, block.notice.params);
    expect(chinese).toContain('这段历史从 claude-code 会话 abc-123 导入');
    // A missing dictionary entry makes `translate` return the key, which would
    // still read like a sentence — so assert it actually changed.
    expect(chinese).not.toBe(block.notice.key);
  });
});

describe('run-stop records in history replay', () => {
  const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
  const user = (id: string, parentId: string | null, text: string, second: number) => ({
    type: 'message',
    id,
    parentId,
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const assistant = (
    id: string,
    parentId: string,
    content: unknown[],
    stopReason: string,
    second: number
  ) => ({
    type: 'message',
    id,
    parentId,
    timestamp: at(second),
    message: { role: 'assistant', content, stopReason },
  });
  const runStop = (id: string, parentId: string, cause: string, second: number) => ({
    type: 'custom',
    id,
    parentId,
    timestamp: at(second),
    customType: RUN_STOP_CUSTOM_TYPE,
    data: { cause, runId: `run-${id}` },
  });

  it("puts the cause on the run's last assistant message and on nothing else", () => {
    const history = projectPiSessionHistory(
      manager([
        user('u1', null, 'first', 1),
        assistant(
          'a1',
          'u1',
          [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }],
          'toolUse',
          2
        ),
        {
          type: 'message',
          id: 'r1',
          parentId: 'a1',
          timestamp: at(3),
          message: {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'contents' }],
            isError: false,
          },
        },
        assistant('a2', 'r1', [{ type: 'text', text: 'still reading' }], 'stop', 4),
        runStop('s1', 'a2', 'interjected', 5),
        user('u2', 's1', 'the interjection', 6),
        assistant('a3', 'u2', [{ type: 'text', text: 'partial' }], 'aborted', 7),
        runStop('s2', 'a3', 'user_stop', 8),
        user('u3', 's2', 'third', 9),
        assistant('a4', 'u3', [{ type: 'text', text: 'done' }], 'stop', 10),
      ])
    );

    expect(
      history.map((message) => [message.entryId, message.role, message.stopCause ?? null])
    ).toEqual([
      ['u1', 'user', null],
      ['a1', 'assistant', null],
      ['a2', 'assistant', 'interjected'],
      ['u2', 'user', null],
      ['a3', 'assistant', 'user_stop'],
      ['u3', 'user', null],
      ['a4', 'assistant', null],
    ]);
    // The record itself is not a message of any kind.
    expect(history.some((message) => message.entryId === 's1' || message.entryId === 's2')).toBe(
      false
    );
  });

  it('does not reach back into the previous turn when the stopped run had no reply yet', () => {
    const history = projectPiSessionHistory(
      manager([
        user('u1', null, 'first', 1),
        assistant('a1', 'u1', [{ type: 'text', text: 'answer' }], 'stop', 2),
        user('u2', 'a1', 'second', 3),
        runStop('s1', 'u2', 'user_stop', 4),
      ])
    );
    expect(history.every((message) => message.stopCause === undefined)).toBe(true);
  });

  it('ignores a record whose cause this build does not know', () => {
    const history = projectPiSessionHistory(
      manager([
        user('u1', null, 'first', 1),
        assistant('a1', 'u1', [{ type: 'text', text: 'answer' }], 'stop', 2),
        runStop('s1', 'a1', 'something_newer', 3),
      ])
    );
    expect(history[1]?.stopCause).toBeUndefined();
  });
});
