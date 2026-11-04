// @vitest-environment happy-dom
/**
 * Decision 209 §3: the side chat's own window — an `about:blank` window this
 * page draws into. Its styles mirror the main page's and follow their
 * changes; it falls back to docking when it cannot open; the user closing
 * it closes the side chat; Ctrl+; inside it still works.
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { setSideChatTransport, useSideChatStore } from '@/stores/sideChat';
import { mirrorDocumentStyles } from '../sideChat/popoutWindow';
import { SideChatWindow } from '../sideChat/SideChatWindow';
import { INITIAL_SIDE_CHAT } from '../sideChat/sideChatModel';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('@/components/chat/sessionStartDeps', () => ({
  sessionStartEffects: {
    start: async () => ({ kind: 'refused', reason: 'no-session' }),
    isRunning: () => true,
    forgetRunning: () => undefined,
  },
}));
vi.mock('@/components/chat/MessageTimeline', () => ({
  TurnTextItem: ({ text }: { text: string }) => createElement('div', null, text),
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('mirrorDocumentStyles', () => {
  function documents() {
    const source = document.implementation.createHTMLDocument('main');
    const target = document.implementation.createHTMLDocument('side');
    source.head.innerHTML =
      '<meta charset="utf-8"><style id="a">.a{color:red}</style><link rel="stylesheet" href="data:text/css,.x{}">';
    source.documentElement.className = 'dark';
    source.documentElement.setAttribute('style', '--ui-font-size: 14px');
    return { source, target };
  }

  it('copies a <base>, then every style and stylesheet link, and the root attributes', () => {
    const { source, target } = documents();
    const stop = mirrorDocumentStyles(source, target);
    const nodes = [...target.head.children];
    expect(nodes.map((node) => node.tagName)).toEqual(['BASE', 'STYLE', 'LINK']);
    expect(nodes[0]?.getAttribute('href')).toBe(source.baseURI);
    expect(nodes[2]?.getAttribute('href')).toBe('data:text/css,.x{}');
    expect(target.documentElement.className).toBe('dark');
    expect(target.documentElement.getAttribute('style')).toBe('--ui-font-size: 14px');
    stop();
  });

  it('follows a theme switch, a rewritten style, an added and a removed one', async () => {
    const { source, target } = documents();
    const stop = mirrorDocumentStyles(source, target);
    source.documentElement.className = 'light';
    const style = source.getElementById('a');
    if (style) style.textContent = '.a{color:blue}';
    const added = source.createElement('style');
    added.textContent = '.b{}';
    source.head.append(added);
    source.head.querySelector('link')?.remove();
    await settle();
    expect(target.documentElement.className).toBe('light');
    const styles = [...target.head.querySelectorAll('style')].map((node) => node.textContent);
    expect(styles).toEqual(['.a{color:blue}', '.b{}']);
    expect(target.head.querySelector('link')).toBeNull();
    stop();
    source.documentElement.className = 'dark';
    await settle();
    expect(target.documentElement.className).toBe('light');
  });
});

describe('SideChatWindow', () => {
  let root: Root | null = null;

  function fakePopup() {
    const events = new EventTarget();
    const doc = document.implementation.createHTMLDocument('');
    const popup = {
      document: doc,
      closed: false,
      close: vi.fn(() => {
        popup.closed = true;
      }),
      focus: vi.fn(),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatch: (event: Event) => events.dispatchEvent(event),
    };
    return popup;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setSideChatTransport({ ask: () => new Promise(() => undefined), cancel: () => undefined });
    useSideChatStore.setState({ ...INITIAL_SIDE_CHAT });
    useChatSessionsStore.setState({ activeSessionId: 's1' });
    useSideChatStore.getState().openFor('s1');
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    setSideChatTransport(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(SideChatWindow)));
    return container;
  }

  it('cannot open its window: the side chat docks instead', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await mount();
    expect(useSideChatStore.getState()).toMatchObject({ open: true, form: 'dock' });
  });

  it('draws the side chat into its own window, titled, and closes the window on unmount', async () => {
    const popup = fakePopup();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const container = await mount();
    expect(open.mock.calls[0]?.[0]).toBe('about:blank');
    expect(open.mock.calls[0]?.[1]).toBe('aiclient-side-chat');
    expect(container.querySelector('[data-side-chat]')).toBeNull();
    expect(popup.document.querySelector('[data-side-chat="window"]')).not.toBeNull();
    expect(popup.document.title).toBe('旁问');
    expect(popup.focus).toHaveBeenCalled();
    await act(async () => root?.unmount());
    root = null;
    expect(popup.close).toHaveBeenCalled();
    // Closing it from here is not the user closing the side chat.
    expect(useSideChatStore.getState().open).toBe(true);
  });

  it('the user closing the window closes the side chat', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    await mount();
    await act(async () => popup.dispatch(new Event('pagehide')));
    expect(useSideChatStore.getState().open).toBe(false);
  });

  it('Ctrl+; pressed inside the window works as in the main one', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    await mount();
    await act(async () =>
      popup.dispatch(new KeyboardEvent('keydown', { code: 'Semicolon', key: ';', ctrlKey: true }))
    );
    expect(useSideChatStore.getState().open).toBe(false);
  });
});
