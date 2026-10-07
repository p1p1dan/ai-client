// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase decision 156 (decision 145 §18, for every dialog) — where focus
 * lands when a dialog opens and its caller did not say.
 *
 * A `DialogPanel` wraps its content in a `ScrollArea`; the viewport is
 * tabbable so the keyboard can scroll it, and Base UI's default initial focus
 * (the first tabbable element) put the focus, and its ring, on that scroll
 * region. Mounted here, because what decides it is Base UI's focus manager
 * and the scroll area's own `tabIndex`, not anything a source scan can see.
 */

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogInitialFocus,
} from '../dialog';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(popup: ReturnType<typeof h>): Promise<void> {
  await act(async () => root.render(h(Dialog, { open: true }, popup)));
  await settle();
}

function viewport(): HTMLElement {
  const node = document.body.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
  expect(node, 'the panel scroll region').not.toBeNull();
  return node as HTMLElement;
}

function focused(): HTMLElement | null {
  return document.activeElement as HTMLElement | null;
}

const longText = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long notice.`).join(' ');

describe('a dialog opens with focus off its scroll region (decision 156)', () => {
  it("[DLG-FOCUS-0] control: Base UI's own default lands on the scroll region", async () => {
    await open(
      h(
        DialogPopup,
        { initialFocus: true },
        h(DialogHeader, null, h(DialogTitle, null, 'A long notice')),
        h(DialogPanel, null, h('p', null, longText)),
        h(DialogFooter, null, h('button', { type: 'button' }, 'Cancel'))
      )
    );
    expect(focused()).toBe(viewport());
  });

  it('[DLG-FOCUS-1] a panel first and a footer after: focus on the first footer button', async () => {
    await open(
      h(
        DialogPopup,
        null,
        h(DialogHeader, null, h(DialogTitle, null, 'A long notice')),
        h(DialogPanel, null, h('p', null, longText)),
        h(
          DialogFooter,
          null,
          h('button', { type: 'button' }, 'Cancel'),
          h('button', { type: 'button' }, 'Continue')
        )
      )
    );
    // The scenario: the scroll region is the popup's first tabbable element.
    expect(viewport().tabIndex).toBe(0);
    expect(focused()?.textContent).toBe('Cancel');
    expect(focused()?.closest('[data-slot="scroll-area-viewport"]')).toBeNull();
    // Still reachable by keyboard: the region keeps its place in the Tab order.
    expect(viewport().getAttribute('tabindex')).toBe('0');
  });

  it('[DLG-FOCUS-2] a field inside the panel takes focus ahead of the footer', async () => {
    await open(
      h(
        DialogPopup,
        null,
        h(DialogHeader, null, h(DialogTitle, null, 'A form')),
        h(DialogPanel, null, h('input', { 'aria-label': 'Name' })),
        h(DialogFooter, null, h('button', { type: 'button' }, 'Save'))
      )
    );
    expect(focused()?.getAttribute('aria-label')).toBe('Name');
  });

  it('[DLG-FOCUS-3] with nothing else to focus, the popup itself takes it', async () => {
    await open(
      h(
        DialogPopup,
        { showCloseButton: false },
        h(DialogHeader, null, h(DialogTitle, null, 'Read only')),
        h(DialogPanel, null, h('p', null, longText))
      )
    );
    expect(focused()?.getAttribute('data-slot')).toBe('dialog-popup');
  });

  it('[DLG-FOCUS-4] a dialog without a scroll region first keeps the default', async () => {
    await open(
      h(
        DialogPopup,
        null,
        h(DialogHeader, null, h(DialogTitle, null, 'Short'), h('input', { 'aria-label': 'Query' })),
        h(DialogPanel, null, h('p', null, 'Body'))
      )
    );
    expect(focused()?.getAttribute('aria-label')).toBe('Query');
  });

  it("[DLG-FOCUS-5] a caller's own initialFocus still wins", async () => {
    const target = { current: null as HTMLButtonElement | null };
    await open(
      h(
        DialogPopup,
        { initialFocus: target },
        h(DialogPanel, null, h('input', { 'aria-label': 'Name' })),
        h(
          DialogFooter,
          null,
          h(
            'button',
            {
              type: 'button',
              ref: (node: HTMLButtonElement | null) => {
                target.current = node;
              },
            },
            'Done'
          )
        )
      )
    );
    expect(focused()?.textContent).toBe('Done');
  });
});

describe('dialogInitialFocus', () => {
  function popupWith(html: string): HTMLElement {
    const popup = document.createElement('div');
    popup.innerHTML = html;
    document.body.append(popup);
    return popup;
  }

  it('leaves Base UI its own choice when the first tabbable element is not a scroll region', () => {
    const popup = popupWith(
      '<button>One</button><div data-slot="scroll-area-viewport" tabindex="0"></div>'
    );
    expect(dialogInitialFocus(popup, 'mouse')).toBe(true);
    expect(dialogInitialFocus(null, 'keyboard')).toBe(true);
  });

  it('skips scroll regions, disabled and hidden controls', () => {
    const popup = popupWith(
      '<div data-slot="scroll-area-viewport" tabindex="0"><button disabled>Off</button></div>' +
        '<div hidden><button>Hidden</button></div><button tabindex="-1">Out</button><button>Next</button>'
    );
    expect((dialogInitialFocus(popup, 'keyboard') as HTMLElement).textContent).toBe('Next');
  });

  it('focuses the popup on a touch open, as Base UI does', () => {
    const popup = popupWith('<div data-slot="scroll-area-viewport" tabindex="0"></div>');
    expect(dialogInitialFocus(popup, 'touch')).toBe(popup);
    expect(dialogInitialFocus(popup, 'mouse')).toBe(popup);
  });
});
