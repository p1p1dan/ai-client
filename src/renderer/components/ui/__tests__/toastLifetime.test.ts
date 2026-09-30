// @vitest-environment happy-dom
/**
 * dsh-rebase P1-7e e3 (problem 11, decision 142): toasts go away by
 * themselves, are never piled up without end, and never sit on the composer.
 *
 * The point-check saw the capacity-reclaim toast stay for good, then several
 * stacked over the composer and the right-hand terminal. Base UI's own timers
 * pause while the window is blurred and come back only on a focus event aimed
 * at an element; the lifetime is kept by `toast.tsx` itself now: 5 s (errors
 * and warnings 10 s), held while the pointer or the keyboard focus is on the
 * stack, `timeout: 0` for a toast that stays until closed.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

const { ToastProvider, TOAST_STACK_LIMIT, toastLifetimeMs, toastManager } = await import(
  '../toast'
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(children: ReactNode = null) {
  const host = document.createElement('div');
  document.body.append(host);
  const created = createRoot(host);
  container = host;
  root = created;
  await act(async () => created.render(createElement(ToastProvider, null, children)));
}

/** Toasts on screen that are not on their way out. */
function standing(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="toast"]')].filter(
    (toast) => !toast.hasAttribute('data-ending-style')
  );
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function viewport(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]');
  if (!found) throw new Error('no toast viewport');
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a toast’s lifetime (P1-7e problem 11)', () => {
  it('[E3-11-LIFETIME] by type, an explicit timeout wins, a loading toast stays', () => {
    expect(toastLifetimeMs({ type: 'info' })).toBe(5_000);
    expect(toastLifetimeMs({ type: 'success' })).toBe(5_000);
    expect(toastLifetimeMs({})).toBe(5_000);
    expect(toastLifetimeMs({ type: 'error' })).toBe(10_000);
    expect(toastLifetimeMs({ type: 'warning' })).toBe(10_000);
    expect(toastLifetimeMs({ type: 'error', timeout: 3_000 })).toBe(3_000);
    expect(toastLifetimeMs({ type: 'info', timeout: 0 })).toBeNull();
    expect(toastLifetimeMs({ type: 'loading' })).toBeNull();
  });

  it('[E3-11-DISMISS] an info toast goes after 5 s, an error after 10 s — a blurred window does not hold them', async () => {
    await mount();
    await act(async () => {
      toastManager.add({ type: 'info', title: 'A conversation moved to the background' });
      toastManager.add({ type: 'error', title: 'The goal was not changed' });
    });
    expect(standing()).toHaveLength(2);
    // What stalled Base UI's own timers.
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    await advance(4_000);
    expect(standing()).toHaveLength(2);
    await advance(1_600);
    expect(standing().map((toast) => toast.textContent)).toEqual([
      expect.stringContaining('The goal was not changed'),
    ]);
    await advance(5_000);
    expect(standing()).toHaveLength(0);
  });

  it('[E3-11-HOLD] held while the pointer is on it; goes once it leaves; timeout 0 stays', async () => {
    await mount();
    await act(async () => {
      toastManager.add({ type: 'info', title: 'Copied' });
      toastManager.add({ type: 'info', title: 'Sticky', timeout: 0 });
    });
    await act(async () => {
      viewport().dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      viewport().dispatchEvent(new PointerEvent('pointerenter'));
    });
    await advance(8_000);
    expect(standing()).toHaveLength(2);
    await act(async () => {
      viewport().dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
      viewport().dispatchEvent(new PointerEvent('pointerleave'));
    });
    await advance(600);
    expect(standing().map((toast) => toast.textContent)).toEqual([
      expect.stringContaining('Sticky'),
    ]);
    await advance(60_000);
    expect(standing()).toHaveLength(1);
  });

  it('[E3-11-STACK] at most three are shown; the ones past it are hidden and not clickable', async () => {
    await mount();
    await act(async () => {
      for (let index = 1; index <= 5; index += 1) {
        toastManager.add({ type: 'info', title: `Toast ${index}` });
      }
    });
    const shown = standing().filter((toast) => !toast.hasAttribute('data-limited'));
    expect(TOAST_STACK_LIMIT).toBe(3);
    expect(shown).toHaveLength(3);
    for (const toast of standing().filter((item) => item.hasAttribute('data-limited'))) {
      expect(toast.className).toContain('data-limited:invisible');
    }
    await advance(5_600);
    expect(standing()).toHaveLength(0);
  });

  it('[E3-11-AVOID] the stack sits above anything marked data-toast-avoid (the composer)', async () => {
    const composer = document.createElement('div');
    composer.setAttribute('data-toast-avoid', '');
    document.body.append(composer);
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({
      top: window.innerHeight - 150,
      left: 300,
      width: 600,
      height: 150,
      right: 900,
      bottom: window.innerHeight,
    } as DOMRect);
    await mount();
    expect(viewport().style.getPropertyValue('--toast-avoid-bottom')).toBe('0px');
    await act(async () => {
      toastManager.add({ type: 'info', title: 'A conversation moved to the background' });
    });
    expect(viewport().style.getPropertyValue('--toast-avoid-bottom')).toBe('150px');
    expect(viewport().className).toContain(
      'data-[position*=bottom]:bottom-[max(var(--toast-inset),calc(var(--toast-avoid-bottom,0px)+--spacing(2)))]'
    );
  });
});
