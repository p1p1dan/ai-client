import { describe, expect, it } from 'vitest';
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
