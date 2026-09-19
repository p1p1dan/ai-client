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

it('renders retry after the long output and preserves a reader scrolled upward', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const retry = { attempt: 2, maxRetries: 3, delayMs: 1000, error: 'upstream', errorStatus: '529' };
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [
      {
        id: 's',
        title: 's',
        projectId: 'p',
        workspaceId: 'w',
        status: 'running',
        updatedAt: 0,
        retry,
        activity: { phase: 'retry', since: Date.now(), retry },
      },
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
          blocks: [{ id: 'at', type: 'text', text: `${'Long answer\n\n'.repeat(60)}THE_END` }],
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
  try {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MessageTimeline, {
            sessionId: 's',
            status: 'running',
            thinkingEnabled: false,
          })
        )
      )
    );
    expect(container.textContent!.indexOf('THE_END')).toBeLessThan(
      container.textContent!.indexOf('Upstream error 529')
    );
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => 3000 },
      clientHeight: { configurable: true, get: () => 300 },
    });
    await act(async () => {
      viewport.scrollTop = 200;
      viewport.dispatchEvent(new Event('scroll'));
      viewport.dispatchEvent(new Event('scroll'));
    });
    await act(async () => {
      useChatSessionsStore.setState((s) => ({
        messages: {
          ...s.messages,
          s: s.messages.s.map((message) =>
            message.id === 'a'
              ? {
                  ...message,
                  blocks: [{ id: 'at', type: 'text', text: 'continued '.repeat(1500) }],
                }
              : message
          ),
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(viewport.scrollTop).toBe(200);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  }
});

/**
 * T093 (decision 029 clause 3) — «立即放弃» aborts the session the banner
 * belongs to.
 *
 * The T091 defect this guards against, in the one place it is cheapest to
 * reintroduce: the store used to re-resolve `activeSessionId` for itself, so a
 * button in a BACKGROUND timeline stopped whatever happened to be in the
 * foreground. This timeline renders one session — the prop — and the banner's
 * button has to hand that id back.
 */
it("the give-up button stops the banner's own session, not the active one", async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stopSpy.mockClear();
  const retryAt = Date.now() + 10_000;
  const retry = {
    attempt: 2,
    maxRetries: 3,
    delayMs: 10_000,
    retryAt,
    error: 'upstream',
    errorStatus: '503',
  };
  useChatSessionsStore.setState({
    // The foreground session is a DIFFERENT one, which is the whole point.
    activeSessionId: 'foreground',
    sessions: [
      {
        id: 'foreground',
        title: 'foreground',
        projectId: 'p',
        workspaceId: 'w',
        status: 'running',
        updatedAt: 0,
      },
      {
        id: 'background',
        title: 'background',
        projectId: 'p',
        workspaceId: 'w',
        status: 'running',
        updatedAt: 0,
        retry,
        activity: { phase: 'retry', since: Date.now(), retry },
      },
    ],
    messages: {
      background: [
        {
          id: 'u',
          sessionId: 'background',
          role: 'user',
          blocks: [{ id: 'ut', type: 'text', text: 'Prompt' }],
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
  try {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MessageTimeline, {
            sessionId: 'background',
            status: 'running',
            thinkingEnabled: false,
          })
        )
      )
    );
    // The countdown is on screen, not folded behind a disclosure: a live
    // number nobody can see would leave the banner exactly as frozen as it
    // looked before this change.
    expect(container.textContent).toMatch(/Next attempt in \d+s/);

    const giveUp = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Give up now')
    );
    expect(giveUp, 'the retry banner renders no give-up button').toBeTruthy();
    await act(async () => {
      giveUp!.click();
    });
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledWith('background');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  }
});
