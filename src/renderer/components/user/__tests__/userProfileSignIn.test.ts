// @vitest-environment happy-dom

import { AUTH_OPEN_ONBOARDING_EVENT } from '@shared/authGate';
import type { AuthSignInRequestResult } from '@shared/types/auth';
import { act, createElement } from 'react';
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
  window.electronAPI = {
    settings: { read: async () => null, write: async () => undefined },
    auth: { requestSignIn },
  } as unknown as typeof window.electronAPI;
  return { requestSignIn };
});

const toasts: { title: string }[] = [];
vi.mock('@/components/ui/toast', () => ({
  toastManager: { add: (toast: { title: string }) => toasts.push(toast) },
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/hooks/useUsageStats', () => ({
  useUsageStats: () => ({ data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

let UserProfileCard: typeof import('../UserProfileCard')['UserProfileCard'];
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
});

beforeEach(() => {
  toasts.length = 0;
  routeEvents = 0;
  electron.requestSignIn.mockClear();
  electron.requestSignIn.mockResolvedValue({ ok: true });
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
