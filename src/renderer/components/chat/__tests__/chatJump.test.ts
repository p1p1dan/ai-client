// @vitest-environment happy-dom
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatJumpTargetKey, nextChatJump, stepChatJump, useChatJumpStore } from '@/stores/chatJump';
import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';

/**
 * Chat search (stage 4): the jump request, paging the target in, revealing
 * its `data-message-id` anchor, and the find bar stepping through matches.
 */

const mocks = vi.hoisted(() => {
  const readSessionPage = vi.fn();
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined },
    chat: { readSessionPage, loadHistoryPage: vi.fn() },
  } as unknown as typeof window.electronAPI;
  return { readSessionPage };
});

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));

const { ensureChatMessageLoaded, findMessageAnchorByText, revealChatMessage } = await import(
  '../chatJumpReveal'
);
const { LOCATE_MARK_MS } = await import('../locateToolRow');
const { ChatFindBar } = await import('../ChatFindBar');
const { useChatJumpReveal } = await import('../useChatJumpReveal');

const SESSION = 's1';

function message(id: string, role: ChatMessage['role'] = 'user'): ChatMessage {
  return { id, sessionId: SESSION, role, blocks: [{ id: `${id}:t`, type: 'text', text: id }] };
}

function setSession(ids: string[], pagination?: { nextOffset: number; hasMore: boolean }) {
  useChatSessionsStore.setState({
    sessions: [
      {
        id: SESSION,
        projectId: 'p',
        workspaceId: 'w',
        title: 'Chat',
        status: 'idle',
        updatedAt: 0,
      },
    ],
    messages: { [SESSION]: ids.map((id) => message(id)) },
    hostBoundSessionIds: [],
    historyPagination: pagination
      ? {
          [SESSION]: {
            ...pagination,
            hydratedCount: ids.length,
            totalCount: ids.length + (pagination.hasMore ? 80 : 0),
          },
        }
      : {},
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.readSessionPage.mockReset();
  useChatJumpStore.setState({ request: null, lastSeq: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the jump request', () => {
  it('starts at the first match, steps with wrap-around and raises seq every time', () => {
    const first = nextChatJump(0, { sessionId: SESSION, query: 'q', messageKeys: ['a', 'b', 'c'] });
    expect(first).toMatchObject({ index: 0, seq: 1 });
    if (!first) throw new Error('expected a request');
    expect(chatJumpTargetKey(first)).toBe('a');
    const back = stepChatJump(first, -1);
    expect(back).toMatchObject({ index: 2, seq: 2 });
    expect(stepChatJump(back, 1)).toMatchObject({ index: 0, seq: 3 });
    expect(nextChatJump(5, { sessionId: SESSION, query: 'q', messageKeys: [] })).toBeNull();
  });

  it('never reuses a seq after a clear, so the same target reveals again', () => {
    const store = useChatJumpStore.getState();
    store.requestJump({ sessionId: SESSION, query: 'q', messageKeys: ['a'] });
    store.step(1);
    store.clear();
    expect(useChatJumpStore.getState().request).toBeNull();
    store.requestJump({ sessionId: SESSION, query: 'q', messageKeys: ['a'] });
    expect(useChatJumpStore.getState().request?.seq).toBe(3);
  });
});

describe('paging the target in', () => {
  it('pages older history through the timeline path until the message is loaded', async () => {
    setSession(['h:90', 'h:91'], { nextOffset: 80, hasMore: true });
    mocks.readSessionPage.mockImplementation(async ({ offset }: { offset: number }) => {
      // The page lands as a `session.history` event; simulate its effect.
      const older = offset === 80 ? ['h:50'] : ['h:10', 'h:11'];
      setTimeout(() => {
        const state = useChatSessionsStore.getState();
        setSession([...older, ...(state.messages[SESSION] ?? []).map((m) => m.id)], {
          nextOffset: offset + 80,
          hasMore: offset === 80,
        });
      }, 5);
    });
    await expect(ensureChatMessageLoaded(SESSION, 'h:10')).resolves.toBe(true);
    expect(mocks.readSessionPage.mock.calls.map(([input]) => input)).toEqual([
      { sessionId: SESSION, offset: 80, limit: 80 },
      { sessionId: SESSION, offset: 160, limit: 80 },
    ]);
  });

  it('answers at once for a loaded message, and gives up when history runs out or a read fails', async () => {
    setSession(['h:1'], { nextOffset: 1, hasMore: false });
    await expect(ensureChatMessageLoaded(SESSION, 'h:1')).resolves.toBe(true);
    await expect(ensureChatMessageLoaded(SESSION, 'h:missing')).resolves.toBe(false);
    setSession(['h:1'], { nextOffset: 1, hasMore: true });
    mocks.readSessionPage.mockRejectedValue(new Error('read_failed'));
    await expect(ensureChatMessageLoaded(SESSION, 'h:missing')).resolves.toBe(false);
    expect(mocks.readSessionPage).toHaveBeenCalledTimes(1);
  });

  it('stops when the jump is superseded', async () => {
    setSession([], undefined);
    const controller = new AbortController();
    const pending = ensureChatMessageLoaded(SESSION, 'h:1', { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBe(false);
  });

  it('waits out a slow first page once its load has begun', async () => {
    vi.useFakeTimers();
    const { useHistoryLoadingStore } = await import('@/stores/historyLoading');
    setSession([], undefined);
    const pending = ensureChatMessageLoaded(SESSION, 'h:1');
    // The activation starts the load a moment after the jump was asked for.
    await vi.advanceTimersByTimeAsync(100);
    useHistoryLoadingStore.getState().begin(SESSION);
    // Longer than the no-load grace (3 s) before the page lands.
    await vi.advanceTimersByTimeAsync(5_000);
    setSession(['h:0', 'h:1'], { nextOffset: 2, hasMore: false });
    await expect(pending).resolves.toBe(true);
    useHistoryLoadingStore.getState().clear(SESSION);
  });

  it('gives up after a short grace when no first page is coming', async () => {
    vi.useFakeTimers();
    setSession([], undefined);
    const pending = ensureChatMessageLoaded(SESSION, 'h:1');
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(pending).resolves.toBe(false);
  });
});

/** A timeline stand-in: a viewport, a folded work group, and two anchors. */
function timelineDom(): {
  root: HTMLDivElement;
  viewport: HTMLElement;
  scrollTo: ReturnType<typeof vi.fn>;
} {
  const root = document.createElement('div');
  root.innerHTML = `
    <div data-slot="scroll-area-viewport">
      <article data-message-id="h:1">first</article>
      <details><summary>work</summary><div data-message-id="h:2">second</div></details>
    </div>`;
  document.body.append(root);
  const viewport = root.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]'
  ) as HTMLElement;
  const scrollTo = vi.fn();
  viewport.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
  Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true });
  viewport.scrollTop = 100;
  viewport.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
  for (const [id, top] of [
    ['h:1', 650],
    ['h:2', 1250],
  ] as const) {
    const anchor = root.querySelector<HTMLElement>(`[data-message-id="${id}"]`) as HTMLElement;
    anchor.getBoundingClientRect = () => ({ top }) as DOMRect;
  }
  return { root, viewport, scrollTo };
}

describe('revealing the anchor', () => {
  it('scrolls only the viewport to put the message a third down, and marks it briefly', () => {
    vi.useFakeTimers();
    const { root, scrollTo } = timelineDom();
    const onBeforeScroll = vi.fn();
    expect(revealChatMessage(root, 'h:1', { onBeforeScroll })).toBe(true);
    expect(onBeforeScroll).toHaveBeenCalledTimes(1);
    // scrollTop 100 + (650 - 50) - 300 / 3
    expect(scrollTo).toHaveBeenCalledWith({ top: 600 });
    const anchor = root.querySelector('[data-message-id="h:1"]') as HTMLElement;
    expect(anchor.hasAttribute('data-located')).toBe(true);
    vi.advanceTimersByTime(LOCATE_MARK_MS);
    expect(anchor.hasAttribute('data-located')).toBe(false);
    expect(revealChatMessage(root, 'h:nope')).toBe(false);
    root.remove();
  });

  it('opens the folded work group the message sits in first', () => {
    const { root } = timelineDom();
    const summary = root.querySelector('summary') as HTMLElement;
    const clicked = vi.fn();
    summary.addEventListener('click', clicked);
    expect(revealChatMessage(root, 'h:2')).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    root.remove();
  });
});

describe('the find bar', () => {
  let container: HTMLDivElement;
  let root: Root;
  let dom: ReturnType<typeof timelineDom>;

  function Harness({ sessionId }: { sessionId: string | null }) {
    const ref = useRef<HTMLElement | null>(dom.root);
    useChatJumpReveal(sessionId, ref, () => undefined);
    return createElement(ChatFindBar, { sessionId });
  }

  async function render(sessionId: string | null) {
    await act(async () => root.render(createElement(Harness, { sessionId })));
    // Let the reveal's async load settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const bar = () => container.querySelector('[data-chat-find-bar]');
  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`
    ) as HTMLButtonElement;
  const located = () =>
    [...dom.root.querySelectorAll<HTMLElement>('[data-located]')].map((el) => el.dataset.messageId);

  beforeEach(() => {
    setSession(['h:1', 'h:2'], { nextOffset: 2, hasMore: false });
    dom = timelineDom();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    dom.root.remove();
  });

  it('shows the query and position, steps with wrap-around, and reveals each match', async () => {
    await render(SESSION);
    expect(bar()).toBeNull();
    await act(async () =>
      useChatJumpStore
        .getState()
        .requestJump({ sessionId: SESSION, query: '8GE21E15', messageKeys: ['h:1', 'h:2'] })
    );
    await render(SESSION);
    expect(bar()?.textContent).toContain('8GE21E15');
    expect(bar()?.textContent).toContain('1 / 2');
    expect(located()).toEqual(['h:1']);
    await act(async () => button('Next match').click());
    await render(SESSION);
    expect(bar()?.textContent).toContain('2 / 2');
    expect(located()).toContain('h:2');
    await act(async () => button('Next match').click());
    await render(SESSION);
    expect(bar()?.textContent).toContain('1 / 2');
    await act(async () => button('Previous match').click());
    expect(bar()?.textContent).toContain('2 / 2');
    await act(async () => button('Close').click());
    expect(bar()).toBeNull();
    expect(useChatJumpStore.getState().request).toBeNull();
  });

  it('clears when another chat opens, and stays hidden over a chat it is not for', async () => {
    await act(async () =>
      useChatJumpStore
        .getState()
        .requestJump({ sessionId: SESSION, query: 'q', messageKeys: ['h:1'] })
    );
    await render(SESSION);
    expect(bar()).not.toBeNull();
    await render('other');
    expect(bar()).toBeNull();
    expect(useChatJumpStore.getState().request).toBeNull();
  });
});

/**
 * Team A, 2026-10-29: a chat that ran live in this window and was not replayed
 * since renders live ids (`user-*` / `asst-*`), so the index's `h:*` keys are
 * not in its timeline. The jump falls back to the rendered text.
 */
describe('a chat showing live ids (text fallback)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let live: HTMLDivElement;

  function liveDom(): HTMLDivElement {
    const element = document.createElement('div');
    element.innerHTML = `
      <div data-slot="scroll-area-viewport">
        <article data-message-id="user-1">lot 8GE21E15 yield?</article>
        <div data-message-id="asst-1">Checked logs.</div>
        <div data-message-id="asst-1">For 8ge21e15, BIN 7 failed most.</div>
        <div data-message-id="asst-2">8GE21E15 has no override.</div>
      </div>`;
    const viewport = element.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLElement;
    viewport.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo'];
    document.body.append(element);
    return element;
  }

  function Harness({ sessionId }: { sessionId: string }) {
    const ref = useRef<HTMLElement | null>(live);
    useChatJumpReveal(sessionId, ref, () => undefined);
    return createElement(ChatFindBar, { sessionId });
  }

  async function settle(ms = 0) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  const located = () =>
    [...live.querySelectorAll<HTMLElement>('[data-located]')].map((element) => element.textContent);

  beforeEach(async () => {
    setSession(['user-1', 'asst-1', 'asst-2'], { nextOffset: 3, hasMore: false });
    live = liveDom();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness, { sessionId: SESSION })));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    live.remove();
  });

  it('picks the n-th rendered message containing the query, once per message, wrapping', () => {
    const textOf = (index: number) =>
      findMessageAnchorByText(live, ' 8ge21E15 ', index)?.textContent;
    expect(textOf(0)).toBe('lot 8GE21E15 yield?');
    expect(textOf(1)).toBe('For 8ge21e15, BIN 7 failed most.');
    expect(textOf(2)).toBe('8GE21E15 has no override.');
    expect(textOf(3)).toBe('lot 8GE21E15 yield?');
    expect(findMessageAnchorByText(live, 'absent', 0)).toBeNull();
    expect(findMessageAnchorByText(live, '  ', 0)).toBeNull();
  });

  it('reveals the matching text when the h:* key is not in the timeline, and steps through it', async () => {
    await act(async () =>
      useChatJumpStore
        .getState()
        .requestJump({ sessionId: SESSION, query: '8GE21E15', messageKeys: ['h:a', 'h:b'] })
    );
    await settle();
    expect(located()).toEqual(['lot 8GE21E15 yield?']);
    expect(mocks.readSessionPage).not.toHaveBeenCalled();
    await act(async () => useChatJumpStore.getState().step(1));
    await settle();
    expect(located()).toContain('For 8ge21e15, BIN 7 failed most.');
    expect(container.querySelector('[data-chat-find-bar]')?.textContent).toContain('2 / 2');
  });

  it('opens the chat without a find bar when nothing rendered contains the query', async () => {
    await act(async () =>
      useChatJumpStore
        .getState()
        .requestJump({ sessionId: SESSION, query: 'nowhere', messageKeys: ['h:a'] })
    );
    expect(container.querySelector('[data-chat-find-bar]')).not.toBeNull();
    await settle(700);
    expect(located()).toEqual([]);
    expect(useChatJumpStore.getState().request).toBeNull();
    expect(container.querySelector('[data-chat-find-bar]')).toBeNull();
  });
});
