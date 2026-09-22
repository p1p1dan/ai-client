// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// T067: the stub fills `{{…}}` the way the real translator does. The banner's
// copy is catalog keys WITH parameters now, so a stub that returned the key
// verbatim would assert against 'Upstream error {{status}}' and call it a
// render — the identity stub was only ever right for parameterless keys.
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate }) }));
vi.mock('@/stores/settings', () => {
  const state = { showToolDiff: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../useResolvedSessionModel', () => {
  const resolve = () => undefined;
  return { useResolvedSessionModel: () => resolve };
});
vi.mock('../sessionIndex/useResumeSession', () => ({ useResumeSession: () => () => undefined }));

// T093: only `stopChatSession` is replaced, through `importOriginal` — the
// rest of that module is real, because other nodes in this timeline's import
// graph use it and a wholesale factory would hand them empty stubs.
const { stopSpy } = vi.hoisted(() => ({ stopSpy: vi.fn(async () => undefined) }));
vi.mock('@/stores/chatSessionActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/chatSessionActions')>()),
  stopChatSession: stopSpy,
}));

// `SessionTreeDialog` no longer needs a stub here: 2026-09-18 moved it (and the
// button that opens it) to `workspace-shell/SessionBar.tsx`, so this timeline
// does not pull it into the module graph at all.

import { useChatSessionsStore } from '@/stores/chatSessions';
import { MessageTimeline } from '../MessageTimeline';

it('closes the process on completion, keeps the final answer outside, and allows reopening', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [
      { id: 's', title: 's', projectId: 'p', workspaceId: 'w', status: 'running', updatedAt: 0 },
    ],
    messages: {
      s: [
        {
          id: 'u',
          sessionId: 's',
          role: 'user',
          blocks: [{ id: 'ut', type: 'text', text: 'Prompt' }],
        },
        {
          id: 'a',
          sessionId: 's',
          role: 'assistant',
          blocks: [
            { id: 'th', type: 'thinking', text: 'Reading evidence.' },
            { id: 'at', type: 'text', text: 'FINAL_RESULT' },
          ],
        },
      ],
    },
    lastError: null,
    pendingPermissions: [],
    pendingQuestions: [],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  const render = async (status: 'running' | 'idle') => {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MessageTimeline, { sessionId: 's', status, thinkingEnabled: true })
        )
      )
    );
  };
  try {
    await render('running');
    expect(container.querySelector('details')?.open).toBe(true);
    // A manual live-phase expansion must not carry over into completion.
    await act(async () => container.querySelector('summary')?.click());
    await act(async () => container.querySelector('summary')?.click());
    expect(container.querySelector('details')?.open).toBe(true);
    await act(async () =>
      useChatSessionsStore.setState((state) => ({
        sessions: state.sessions.map((session) => ({ ...session, status: 'idle' })),
      }))
    );
    await render('idle');
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).not.toContain('FINAL_RESULT');
    expect(container.textContent).toContain('FINAL_RESULT');
    expect(container.querySelectorAll('details')).toHaveLength(1);
    await act(async () => container.querySelector('summary')?.click());
    expect(details?.open).toBe(true);
    await render('idle');
    expect(details?.open).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  }
});
