import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { beforeEach, expect, it } from 'vitest';
import { applyRuntimeEvents, useChatSessionsStore } from '../chatSessions';

let seq = 0;
function apply(event: RuntimeEvent) {
  const state = useChatSessionsStore.getState();
  useChatSessionsStore.setState(applyRuntimeEvents(state, [event]));
}
function event(type: RuntimeEvent['type'], payload: unknown, sessionId = 's'): RuntimeEvent {
  return { type, payload, sessionId, timestamp: Date.now(), seq: ++seq } as RuntimeEvent;
}
beforeEach(() => {
  seq = 0;
  useChatSessionsStore.setState({
    activeSessionId: 's',
    lastError: null,
    sessions: ['s', 'other'].map((id) => ({
      id,
      workspaceId: 'w',
      projectId: 'p',
      title: id,
      status: 'running',
      updatedAt: 0,
    })),
    messages: { s: [{ id: 'm', sessionId: 's', role: 'assistant', blocks: [] }] },
  });
});
it.each([
  '529',
  '400',
  '429',
])('clears %s failure and retry on actual recovered output then completion', (code) => {
  apply(event('session.failed', { error: `HTTP ${code}` }));
  expect(useChatSessionsStore.getState().lastError).toBe(`HTTP ${code}`);
  apply(
    event('session.status', {
      status: 'running',
      retry: { attempt: 1, maxRetries: 3, delayMs: 200, errorStatus: code, error: 'upstream' },
    })
  );
  expect(useChatSessionsStore.getState().sessions[0].activity?.phase).toBe('retry');
  apply(event('message.delta', { messageId: 'm', blockId: 'b', text: 'recovered' }));
  const state = useChatSessionsStore.getState();
  expect(state.lastError).toBeNull();
  expect(state.sessions[0].runtimeError).toBeUndefined();
  expect(state.sessions[0].retry).toBeUndefined();
  expect(state.sessions[0].activity?.phase).toBe('output');
  apply(event('session.completed', {}));
  expect(useChatSessionsStore.getState().sessions[0].activity).toBeUndefined();
});
it('preserves terminal failure and keeps another session recovery from clearing it', () => {
  apply(event('session.failed', { error: 'exhausted' }));
  apply(event('session.completed', {}, 'other'));
  expect(useChatSessionsStore.getState().lastError).toBe('exhausted');
  useChatSessionsStore.getState().selectSession('other');
  expect(useChatSessionsStore.getState().lastError).toBeNull();
  expect(useChatSessionsStore.getState().sessions.find((s) => s.id === 's')?.runtimeError).toBe(
    'exhausted'
  );
});
it('uses tool, confirmation, thinking events and clears all live state on stop', () => {
  apply(
    event('tool.started', {
      messageId: 'm',
      toolCallId: 't',
      name: 'read',
      input: { path: 'src/app.ts' },
    })
  );
  expect(useChatSessionsStore.getState().sessions[0].activity).toMatchObject({
    phase: 'tool',
    tool: 'read · src/app.ts',
  });
  apply(event('session.status', { status: 'waiting_permission' }));
  expect(useChatSessionsStore.getState().sessions[0].activity?.phase).toBe('confirmation');
  apply(event('thinking.delta', { messageId: 'm', blockId: 'thinking', text: 'reason' }));
  expect(useChatSessionsStore.getState().sessions[0].activity?.phase).toBe('thinking');
  apply(event('session.stopped', {}));
  expect(useChatSessionsStore.getState().sessions[0].activity).toBeUndefined();
});
