// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerPermissionTrigger } from '../ComposerPermissionTrigger';
import { readDefaultTier, readSessionTier, writeDefaultTier } from '../sessionPreferenceStore';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let root: Root;
let container: HTMLDivElement;
const setPermissionTier = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', { chat: { setPermissionTier } });
  setPermissionTier.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  writeDefaultTier('handsoff');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const trigger = () => container.querySelector<HTMLButtonElement>('button')!;
const popup = () => document.querySelector('[data-slot="menu-popup"]');
const tierItem = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).find((item) =>
    item.textContent?.startsWith(label)
  )!;
const confirmationButton = (label: string) =>
  Array.from(popup()!.querySelectorAll('button')).find((button) => button.textContent === label)!;

async function click(element: HTMLElement) {
  await act(() => element.click());
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function render(sessionId: string | null = 'permission-test') {
  await act(() =>
    root.render(
      createElement(ComposerPermissionTrigger, { sessionId, hostState: 'ready', mode: 'session' })
    )
  );
  await click(trigger());
  expect(popup()).not.toBeNull();
}

function expectClosed() {
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  expect(popup()).toBeNull();
  expect(document.querySelector('[data-base-ui-portal]')).toBeNull();
  expect(document.querySelector('.fixed.inset-0.z-40')).toBeNull();
}

describe('permission menu interaction', () => {
  it.each([
    ['Read-only', 'readonly'],
    ['Pragmatic', 'pragmatic'],
    ['Hands-off', 'handsoff'],
  ])('closes and can reopen after selecting %s', async (label, tier) => {
    await render();
    await click(tierItem(label));
    expectClosed();
    expect(trigger().textContent).toBe(label);
    // Selecting the already active tier need not dispatch a redundant change.
    if (tier !== 'handsoff') {
      expect(readSessionTier('permission-test')).toBe(tier);
      expect(setPermissionTier).toHaveBeenCalledWith({ sessionId: 'permission-test', tier });
    }
    await click(trigger());
    expect(tierItem(label).getAttribute('aria-checked')).toBe('true');
    await click(tierItem(label));
    expectClosed();
  });

  it('saves the startup default without needing a session', async () => {
    await render(null);
    await click(tierItem('Read-only'));
    expectClosed();
    expect(readDefaultTier()).toBe('readonly');
    expect(setPermissionTier).not.toHaveBeenCalled();
  });

  it.each(['Escape', 'outside'])('dismisses on %s without changing the tier', async (method) => {
    await render();
    await act(() => {
      if (method === 'Escape') {
        popup()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        document
          .querySelector('.fixed.inset-0.z-40')!
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }
    });
    expectClosed();
    expect(setPermissionTier).not.toHaveBeenCalled();
  });

  it('keeps full access unapplied until confirmed and supports cancel', async () => {
    await render();
    await click(tierItem('Full access'));
    expect(popup()!.textContent).toContain('Remove limits on this chat?');
    expect(setPermissionTier).not.toHaveBeenCalled();
    await click(confirmationButton('Cancel'));
    expect(tierItem('Hands-off').getAttribute('aria-checked')).toBe('true');
    await click(tierItem('Full access'));
    await click(confirmationButton('Apply'));
    expectClosed();
    expect(readSessionTier('permission-test')).toBe('fullopen');
    expect(setPermissionTier).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'permission-test',
      tier: 'fullopen',
    });
  });

  it('clears an abandoned full access confirmation before reopening', async () => {
    await render();
    await click(tierItem('Full access'));
    await act(() => {
      popup()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expectClosed();
    await click(trigger());
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(4);
    expect(setPermissionTier).not.toHaveBeenCalled();
  });

  it('closes even if the runtime rejects the tier update', async () => {
    setPermissionTier.mockRejectedValue(new Error('session unavailable'));
    await render();
    await click(tierItem('Read-only'));
    expectClosed();
  });
});
