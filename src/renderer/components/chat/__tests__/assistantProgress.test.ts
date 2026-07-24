import { describe, expect, it } from 'vitest';
import { classifyAssistantProgress } from '../assistantProgress';

function event(type: string, payload?: Record<string, unknown>) {
  return { type, sessionId: 'session-live', payload };
}

describe('classifyAssistantProgress', () => {
  it('ignores the echoed USER message from EventNormalizer.beginTurn', () => {
    const ids = new Set<string>();
    expect(
      classifyAssistantProgress(event('message.started', { messageId: 'u-1', role: 'user' }), ids)
    ).toBe('ignore');
    expect(
      classifyAssistantProgress(
        event('message.delta', { messageId: 'u-1', blockId: 'b', text: 'hi' }),
        ids
      )
    ).toBe('ignore');
    expect(classifyAssistantProgress(event('message.completed', { messageId: 'u-1' }), ids)).toBe(
      'ignore'
    );
    expect(ids.size).toBe(0);
  });

  it('counts assistant message.started and its subsequent deltas', () => {
    const ids = new Set<string>();
    expect(
      classifyAssistantProgress(
        event('message.started', { messageId: 'a-1', role: 'assistant' }),
        ids
      )
    ).toBe('assistant');
    expect(ids.has('a-1')).toBe(true);
    expect(
      classifyAssistantProgress(
        event('message.delta', { messageId: 'a-1', blockId: 'b', text: 'PONG' }),
        ids
      )
    ).toBe('assistant');
    expect(classifyAssistantProgress(event('message.completed', { messageId: 'a-1' }), ids)).toBe(
      'assistant'
    );
  });

  it('ignores assistant-looking deltas that have no matching envelope (out of order)', () => {
    const ids = new Set<string>();
    expect(
      classifyAssistantProgress(event('message.delta', { messageId: 'ghost', text: 'x' }), ids)
    ).toBe('ignore');
    expect(classifyAssistantProgress(event('message.completed', { messageId: 'ghost' }), ids)).toBe(
      'ignore'
    );
  });

  it('counts tool / permission / question / thinking as unambiguous assistant-turn signals', () => {
    const ids = new Set<string>();
    expect(
      classifyAssistantProgress(
        event('tool.started', { messageId: 'a-1', toolCallId: 't1', name: 'Write' }),
        ids
      )
    ).toBe('assistant');
    expect(
      classifyAssistantProgress(
        event('tool.completed', { messageId: 'a-1', toolCallId: 't1', ok: true }),
        ids
      )
    ).toBe('assistant');
    expect(
      classifyAssistantProgress(
        event('permission.requested', { permissionId: 'p1', toolName: 'Write' }),
        ids
      )
    ).toBe('assistant');
    expect(
      classifyAssistantProgress(
        event('question.requested', { questionId: 'q1', prompt: 'pick' }),
        ids
      )
    ).toBe('assistant');
    expect(
      classifyAssistantProgress(
        event('thinking.delta', { messageId: 'a-1', blockId: 'tb', text: 'hmm' }),
        ids
      )
    ).toBe('assistant');
  });

  it('ignores session lifecycle, status, and host.error events', () => {
    const ids = new Set<string>();
    expect(classifyAssistantProgress(event('session.created'), ids)).toBe('ignore');
    expect(classifyAssistantProgress(event('session.status', { status: 'running' }), ids)).toBe(
      'ignore'
    );
    expect(classifyAssistantProgress(event('session.completed'), ids)).toBe('ignore');
    expect(
      classifyAssistantProgress(event('host.error', { code: 'x', message: 'boom' }), ids)
    ).toBe('ignore');
    expect(ids.size).toBe(0);
  });
});
