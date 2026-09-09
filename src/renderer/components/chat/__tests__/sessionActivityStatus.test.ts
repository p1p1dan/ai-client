// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { SessionActivityStatus } from '../SessionActivityStatus';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, p?: Record<string, number>) =>
      p ? key.replace('{{seconds}}', String(p.seconds)) : key,
  }),
}));
it('renders real retry countdown and switches sessions without stale status or timers', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  useChatSessionsStore.setState({
    sessions: [
      {
        id: 'a',
        projectId: 'p',
        workspaceId: 'w',
        title: 'a',
        status: 'running',
        updatedAt: 0,
        activity: {
          phase: 'retry',
          since: 10000,
          retry: { attempt: 2, maxRetries: 3, delayMs: 5000, error: '529', errorStatus: '529' },
        },
      },
      { id: 'b', projectId: 'p', workspaceId: 'w', title: 'b', status: 'idle', updatedAt: 0 },
    ],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SessionActivityStatus, { sessionId: 'a' })));
    expect(container.textContent).toContain('Retrying · 2/3 · Retry in 5s');
    await act(async () => vi.advanceTimersByTime(2000));
    expect(container.textContent).toContain('Retry in 3s');
    await act(async () => root.render(createElement(SessionActivityStatus, { sessionId: 'b' })));
    expect(container.textContent).toBe('');
    await act(async () => root.render(createElement(SessionActivityStatus, { sessionId: 'a' })));
    await act(async () =>
      useChatSessionsStore.setState((s) => ({
        sessions: s.sessions.map((item) =>
          item.id === 'a' ? { ...item, status: 'idle', activity: undefined } : item
        ),
      }))
    );
    expect(container.textContent).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('shows a Pi extension dialog as waiting for confirmation until its actual acknowledgement', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const { useExtensionUiStore } = await import('@/stores/extensionUi');
  useChatSessionsStore.setState({
    sessions: [
      {
        id: 's',
        title: 's',
        projectId: 'p',
        workspaceId: 'w',
        status: 'running',
        updatedAt: 0,
        activity: { phase: 'tool', tool: 'ask', since: Date.now() },
      },
    ],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    useExtensionUiStore.setState({
      pending: [
        {
          runtimeId: 'r',
          uiRequestId: 'q',
          sessionId: 's',
          receivedAt: Date.now(),
          dialog: { method: 'input', title: 'Your answer' },
        },
      ],
    });
    await act(async () => root.render(createElement(SessionActivityStatus, { sessionId: 's' })));
    expect(container.textContent).toContain('Waiting for confirmation');
    await act(async () => useExtensionUiStore.setState({ pending: [] }));
    expect(container.textContent).toContain('Running tool');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
