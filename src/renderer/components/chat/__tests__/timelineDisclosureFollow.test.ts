// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * C3 (devbox point check 2026-09-24, `17-c3-thought.json`): opening a row at
 * the bottom of a live turn must not let the NEXT streamed paragraph scroll
 * the row away.
 *
 * Measured before the fix: the click left scrollTop alone (the disclosure's
 * own resize matched the height `preserveDisclosurePosition` recorded), but the
 * follow flag stayed armed, so ~160ms later the first new paragraph was
 * followed by its own height PLUS the whole panel's — 466px for a thought, and
 * its header left the viewport within half a second.
 *
 * happy-dom has no layout, so the scroll viewport's geometry is simulated: a
 * base height, plus a fixed height per open row panel, plus streamed growth.
 * The ResizeObserver is a fake the test fires by hand, which is exactly the
 * moment the real follower runs.
 */
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
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => undefined }));
vi.mock('../sessionIndex/useResumeSession', () => ({ useResumeSession: () => () => undefined }));

import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { MessageTimeline } from '../MessageTimeline';

const CLIENT_HEIGHT = 700;
const BASE_HEIGHT = 2000;
const ROW_PANEL_HEIGHT = 400;
const PROCESS_BODY_HEIGHT = 300;
const PARAGRAPH = 30;

const VIEWPORT = '[data-slot="scroll-area-viewport"]';

let growth = 0;
const scrollTops = new WeakMap<Element, number>();
const isViewport = (el: Element) => el.getAttribute('data-slot') === 'scroll-area-viewport';

function simulatedScrollHeight(viewport: Element): number {
  const panels = viewport.querySelectorAll('[data-slot="collapsible-panel"]').length;
  const openProcess = [...viewport.querySelectorAll('details')].filter((d) => d.open).length;
  return BASE_HEIGHT + growth + panels * ROW_PANEL_HEIGHT + openProcess * PROCESS_BODY_HEIGHT;
}

function findDescriptor(name: string): PropertyDescriptor | undefined {
  let proto: object | null = HTMLElement.prototype;
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor) return descriptor;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

const originals = new Map<string, PropertyDescriptor | undefined>();

function installGeometry() {
  for (const name of ['scrollHeight', 'clientHeight', 'scrollTop']) {
    originals.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  }
  const fallback = (name: string) => findDescriptor(name);
  const scrollHeightBase = fallback('scrollHeight');
  const clientHeightBase = fallback('clientHeight');
  const scrollTopBase = fallback('scrollTop');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isViewport(this) ? simulatedScrollHeight(this) : scrollHeightBase?.get?.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isViewport(this) ? CLIENT_HEIGHT : clientHeightBase?.get?.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return isViewport(this) ? (scrollTops.get(this) ?? 0) : scrollTopBase?.get?.call(this);
    },
    set(this: HTMLElement, value: number) {
      if (!isViewport(this)) {
        scrollTopBase?.set?.call(this, value);
        return;
      }
      const max = Math.max(0, simulatedScrollHeight(this) - CLIENT_HEIGHT);
      scrollTops.set(this, Math.min(Math.max(0, value), max));
    },
  });
}

function restoreGeometry() {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  originals.clear();
}

class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  targets: Element[] = [];
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
  }
}

beforeEach(() => {
  growth = 0;
  FakeResizeObserver.all = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  installGeometry();
});

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  restoreGeometry();
  vi.unstubAllGlobals();
});

/** A turn the user interjected on: its process stays open, so its rows are on screen. */
const MESSAGES: ChatMessage[] = [
  { id: 'u1', sessionId: 's', role: 'user', blocks: [{ id: 'u1:t', type: 'text', text: 'go' }] },
  {
    id: 'a1',
    sessionId: 's',
    role: 'assistant',
    stopCause: 'interjected',
    blocks: [
      { id: 'th', type: 'thinking', text: 'Weighing the two builds.' },
      {
        id: 'c1',
        type: 'tool_call',
        toolCallId: 'c1',
        toolName: 'bash',
        toolInput: { command: 'pnpm build' },
      },
      {
        id: 'c1:r',
        type: 'tool_result',
        toolCallId: 'c1',
        toolOk: true,
        toolOutput: 'BUILD_OUTPUT',
      },
      { id: 'tx', type: 'text', text: 'Here is where it stands.' },
    ],
  },
];

async function renderTimeline() {
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [
      { id: 's', title: 's', projectId: 'p', workspaceId: 'w', status: 'idle', updatedAt: 0 },
    ],
    messages: { s: MESSAGES },
    lastError: null,
    pendingPermissions: [],
    pendingQuestions: [],
  } as never);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageTimeline, { sessionId: 's', status: 'idle', thinkingEnabled: true })
      )
    )
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  };
  const viewport = container.querySelector<HTMLElement>(VIEWPORT);
  expect(viewport, 'the timeline renders its scroll viewport').not.toBeNull();
  const vp = viewport as HTMLElement;
  const follower = FakeResizeObserver.all.find(
    (observer) =>
      observer.targets.includes(vp) &&
      observer.targets.some((target) => target !== vp && vp.contains(target))
  );
  expect(follower, 'the timeline observes its content and viewport').toBeDefined();
  /** One ResizeObserver delivery — the instant the real follower decides. */
  const fireResize = () => act(async () => follower?.callback([], follower as never));
  /** A streamed paragraph lands under the viewport. */
  const stream = async () => {
    growth += PARAGRAPH;
    await fireResize();
  };
  const bottom = () => vp.scrollHeight - CLIENT_HEIGHT;
  const trigger = (text: string) => {
    const found = [
      ...container.querySelectorAll<HTMLElement>('[data-slot="collapsible-trigger"]'),
    ].find((el) => el.textContent?.includes(text));
    expect(found, `a row reading "${text}"`).toBeDefined();
    return found as HTMLElement;
  };
  const clickRow = async (text: string) => {
    await act(async () => trigger(text).click());
    await fireResize();
  };
  /** The reader scrolls to `top` themselves. */
  const userScrollTo = (top: number) =>
    act(async () => {
      vp.scrollTop = top;
      vp.dispatchEvent(new Event('scroll'));
    });
  return { viewport: vp, container, fireResize, stream, bottom, clickRow, userScrollTo };
}

it('[C3-FOLLOW-1] streaming at the bottom keeps following — the baseline the fix must not break', async () => {
  const { viewport, stream, bottom } = await renderTimeline();
  expect(viewport.scrollTop).toBe(bottom());
  await stream();
  expect(viewport.scrollTop, 'new content is followed').toBe(bottom());
  await stream();
  expect(viewport.scrollTop).toBe(bottom());
});

it('[C3-FOLLOW-2] opening a thought at the bottom pauses following until the reader scrolls back down', async () => {
  const { viewport, stream, bottom, clickRow, userScrollTo } = await renderTimeline();
  await stream();
  const reading = viewport.scrollTop;
  expect(reading).toBe(bottom());

  await clickRow('Thought');
  expect(viewport.scrollTop, 'the disclosure itself does not scroll').toBe(reading);

  // The measured defect: the NEXT paragraph used to pull the page down by its
  // own height plus the panel's, taking the header just clicked with it.
  await stream();
  expect(viewport.scrollTop, 'the opened thought stays where it was read').toBe(reading);
  await stream();
  expect(viewport.scrollTop).toBe(reading);

  // The reader's own return to the bottom is what resumes following.
  await userScrollTo(bottom());
  await stream();
  expect(viewport.scrollTop, 'following resumed after the reader came back').toBe(bottom());
});

it('[C3-FOLLOW-3] a tool row obeys the same rule, and closing a row leaves following as it was', async () => {
  const { viewport, stream, bottom, clickRow, userScrollTo } = await renderTimeline();
  const reading = viewport.scrollTop;
  await clickRow('pnpm build');
  await stream();
  expect(viewport.scrollTop, 'an opened tool row is not scrolled away').toBe(reading);

  // Back at the bottom and following again, then the row is closed: a close
  // is not a reason to stop following.
  await userScrollTo(bottom());
  await clickRow('pnpm build');
  await stream();
  expect(viewport.scrollTop, 'a close does not pause following').toBe(bottom());
});

it('[C3-FOLLOW-4] opening the turn process head by a click pauses following too', async () => {
  const { viewport, container, fireResize, stream, bottom } = await renderTimeline();
  const summary = container.querySelector('summary');
  expect(summary, 'the process head').not.toBeNull();
  // See `turnEndOpenInteraction.test.ts` for why a plain Event, not `.click()`.
  const clickHead = async () => {
    await act(async () => summary?.dispatchEvent(new Event('click', { bubbles: true })));
    await fireResize();
  };
  expect(container.querySelector('details')?.open, 'an interjected turn opens by default').toBe(
    true
  );
  await clickHead(); // close — following untouched
  await stream();
  expect(viewport.scrollTop).toBe(bottom());

  const reading = viewport.scrollTop;
  await clickHead(); // open
  expect(container.querySelector('details')?.open).toBe(true);
  expect(viewport.scrollTop, 'the opened process is not followed to its end').toBe(reading);
  await stream();
  expect(viewport.scrollTop).toBe(reading);
});
