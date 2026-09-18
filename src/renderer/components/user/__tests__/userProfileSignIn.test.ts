// @vitest-environment happy-dom

import { AUTH_OPEN_ONBOARDING_EVENT } from '@shared/authGate';
import { translate } from '@shared/i18n';
import type { AuthSignInRequestResult } from '@shared/types/auth';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The account card's 登录 button, clicked for real.
 *
 * The defect it regressed on was invisible from every other angle: on a machine
 * running `Use my own setup` the button dispatched a routing event, the gate
 * re-decided the same shell it already had, and absolutely nothing happened —
 * no screen change, no error, not a line in the main-process log. So the fact
 * worth pinning is an ORDER: the credential mode has to change in Main first,
 * and the routing event may only follow a request that was actually granted.
 *
 * `window.electronAPI` is stubbed in `vi.hoisted` rather than `beforeEach`
 * because zustand's `persist` middleware rehydrates at module-import time and
 * calls `settings.read()` while doing it; a stub installed later loses that
 * race and the suite hangs for ten seconds with no error.
 */

const electron = vi.hoisted(() => {
  const requestSignIn = vi.fn<() => Promise<AuthSignInRequestResult>>(async () => ({ ok: true }));
  const logout = vi.fn<() => Promise<boolean>>(async () => true);
  window.electronAPI = {
    // `Dialog` runs `useTrafficLightsGuard`, which reads `env.platform` on
    // mount — without it the logout confirm throws instead of opening.
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    auth: { requestSignIn },
    onboarding: { logout },
  } as unknown as typeof window.electronAPI;
  return { requestSignIn, logout };
});

const toasts: { title: string }[] = [];
vi.mock('@/components/ui/toast', () => ({
  toastManager: { add: (toast: { title: string }) => toasts.push(toast) },
}));
// The real `translate` at the locale whose catalog is the key itself: English
// text comes back unchanged (so every assertion below still reads as a key)
// while `{{count}}` placeholders are actually substituted — which is the whole
// point of the loss lines in the logout confirm.
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate('en', key, params),
    locale: 'en',
  }),
}));
vi.mock('@/hooks/useUsageStats', () => ({
  useUsageStats: () => ({ data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

let UserProfileCard: typeof import('../UserProfileCard')['UserProfileCard'];
let SignInConfirmHost: typeof import('@/components/auth/SignInConfirmHost')['SignInConfirmHost'];
let confirmStore: typeof import('@/stores/signInConfirm');
let terminalStore: typeof import('@/stores/terminal')['useTerminalStore'];
let root: Root;
let container: HTMLDivElement;
let routeEvents: number;
let onRequestClose: ReturnType<typeof vi.fn>;

function countRouteEvent() {
  routeEvents += 1;
}

beforeAll(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ({ UserProfileCard } = await import('../UserProfileCard'));
  ({ SignInConfirmHost } = await import('@/components/auth/SignInConfirmHost'));
  confirmStore = await import('@/stores/signInConfirm');
  terminalStore = (await import('@/stores/terminal')).useTerminalStore;
});

beforeEach(() => {
  toasts.length = 0;
  routeEvents = 0;
  electron.requestSignIn.mockClear();
  electron.requestSignIn.mockResolvedValue({ ok: true });
  electron.logout.mockClear();
  electron.logout.mockResolvedValue(true);
  confirmStore.resetSignInConfirmForTests();
  terminalStore.setState({ sessions: [] });
  onRequestClose = vi.fn();
  window.addEventListener(AUTH_OPEN_ONBOARDING_EVENT, countRouteEvent);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  window.removeEventListener(AUTH_OPEN_ONBOARDING_EVENT, countRouteEvent);
  act(() => root.unmount());
  container.remove();
});

function renderSignedOut(): HTMLButtonElement {
  act(() => {
    root.render(
      createElement(UserProfileCard, {
        presentation: { tone: 'signed-out', email: null },
        onRequestClose,
      })
    );
  });
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('Sign in')
  );
  if (!button) throw new Error('the signed-out card rendered no sign-in button');
  return button;
}

describe('the account card sign-in button', () => {
  it('asks Main to leave the local credential mode before routing anywhere', async () => {
    const button = renderSignedOut();
    await act(async () => {
      button.click();
    });

    expect(electron.requestSignIn).toHaveBeenCalledTimes(1);
    // The routing event is downstream of the granted request, never a
    // substitute for it: on its own it re-decides the same shell forever.
    expect(routeEvents).toBe(1);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });

  it('says so when the request is refused, and stays put', async () => {
    electron.requestSignIn.mockResolvedValue({ ok: false, reason: 'credentials-unresolved' });
    const button = renderSignedOut();
    await act(async () => {
      button.click();
    });

    // Silence here would be the original defect wearing a different hat.
    expect(toasts.map((toast) => toast.title)).toEqual(['Could not open the sign-in screen']);
    expect(routeEvents).toBe(0);
    // The card stays open, so the toast is not explaining itself over a
    // surface that has already closed.
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('reports an IPC that rejects outright rather than swallowing it', async () => {
    electron.requestSignIn.mockRejectedValue(new Error('channel closed'));
    const button = renderSignedOut();
    await act(async () => {
      button.click();
    });

    expect(toasts.map((toast) => toast.title)).toEqual(['Could not open the sign-in screen']);
    expect(routeEvents).toBe(0);
  });

  it('is disabled while the switch is in flight, so a second click cannot race it', async () => {
    let release: (result: AuthSignInRequestResult) => void = () => undefined;
    electron.requestSignIn.mockReturnValue(
      new Promise<AuthSignInRequestResult>((resolve) => {
        release = resolve;
      })
    );
    const button = renderSignedOut();
    await act(async () => {
      button.click();
    });

    expect(button.disabled).toBe(true);
    await act(async () => {
      button.click();
      release({ ok: true });
    });
    expect(electron.requestSignIn).toHaveBeenCalledTimes(1);
  });
});

/**
 * Logout is the one path that must NOT grow a second confirmation.
 *
 * It already had one, and it ends in the same `requestSignIn` — so left alone
 * the user would answer "are you sure" twice for one decision, and the second
 * box would arrive AFTER the vault was cleared, where "cancel" can no longer
 * undo anything. The merge is what is pinned here: one dialog, and it carries
 * the numbers.
 */
describe('the account card logout confirmation', () => {
  function renderSignedIn(): HTMLButtonElement {
    act(() => {
      root.render(
        createElement(
          Fragment,
          null,
          createElement(UserProfileCard, {
            presentation: { tone: 'signed-in', email: 'someone@jcdz.cc' },
            onRequestClose,
          }),
          createElement(SignInConfirmHost)
        )
      );
    });
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Logout'
    );
    if (!button) throw new Error('the signed-in card rendered no logout button');
    return button;
  }

  function popupText(): string {
    return document.querySelector('[data-slot="dialog-popup"]')?.textContent ?? '';
  }

  function popupButton(label: string): HTMLButtonElement {
    const popup = document.querySelector('[data-slot="dialog-popup"]');
    const found = [...(popup?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.textContent?.trim() === label
    );
    if (!found) throw new Error(`no "${label}" button in: ${popupText()}`);
    return found;
  }

  it('spells out what logging out costs, with numbers', async () => {
    terminalStore.setState({
      sessions: [
        { id: 't1', title: 't1', cwd: '/tmp' },
        { id: 't2', title: 't2', cwd: '/tmp' },
      ] as never,
    });
    const logoutButton = renderSignedIn();
    await act(async () => {
      logoutButton.click();
    });

    const text = popupText();
    expect(text).toContain('2 terminal(s) will close');
    // Nothing has happened yet — this is still just a question.
    expect(electron.logout).not.toHaveBeenCalled();
    expect(electron.requestSignIn).not.toHaveBeenCalled();
  });

  it('never promises a surviving turn here, unlike the re-login confirm', async () => {
    // `performLogoutSequence` terminates every session and invalidates the
    // worker BEFORE it clears the vault, so the re-login wording ("the turn
    // keeps running in the background") would be a promise this path breaks.
    const chat = (await import('@/stores/chatSessions')).useChatSessionsStore;
    chat.setState({
      sessions: [
        {
          id: 's1',
          projectId: 'p',
          workspaceId: 'w',
          title: 's1',
          status: 'running',
          updatedAt: 0,
        },
      ] as never,
    });
    try {
      const logoutButton = renderSignedIn();
      await act(async () => {
        logoutButton.click();
      });
      const text = popupText();
      expect(text).toContain('1 chat(s) are mid-turn and will be stopped');
      expect(text).not.toContain('keeps running in the background');
    } finally {
      chat.setState({ sessions: [] });
    }
  });

  it('asks once, not twice — confirming goes straight through to logout and the sign-in request', async () => {
    terminalStore.setState({ sessions: [{ id: 't1', title: 't1', cwd: '/tmp' }] as never });
    const logoutButton = renderSignedIn();
    await act(async () => {
      logoutButton.click();
    });

    await act(async () => {
      popupButton('Logout').click();
    });

    expect(electron.logout).toHaveBeenCalledTimes(1);
    expect(electron.requestSignIn).toHaveBeenCalledTimes(1);
    expect(routeEvents).toBe(1);
    // The give-away that a second confirmation would leave behind.
    expect(document.querySelector('[data-slot="alert-dialog-popup"]')).toBeNull();
    expect(confirmStore.useSignInConfirmStore.getState().open).toBe(false);
  });

  it('does nothing at all when the confirmation is cancelled', async () => {
    terminalStore.setState({ sessions: [{ id: 't1', title: 't1', cwd: '/tmp' }] as never });
    const logoutButton = renderSignedIn();
    await act(async () => {
      logoutButton.click();
    });

    await act(async () => {
      popupButton('Cancel').click();
    });

    expect(electron.logout).not.toHaveBeenCalled();
    expect(electron.requestSignIn).not.toHaveBeenCalled();
    expect(routeEvents).toBe(0);
  });
});
