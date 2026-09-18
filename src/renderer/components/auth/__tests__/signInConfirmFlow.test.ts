// @vitest-environment happy-dom

import { AUTH_OPEN_ONBOARDING_EVENT } from '@shared/authGate';
import { translate } from '@shared/i18n';
import type { AuthSignInRequestResult } from '@shared/types/auth';
import { act, createElement, Fragment, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The safety net in front of `auth:requestSignIn`, driven for real.
 *
 * `a72e0337` made every 登录 button work, and in doing so gave the app its
 * first way to unmount `<App/>` while somebody is using it — which kills every
 * terminal in the tree. The user's ruling was 「这个肯定是不行的。需要安全的
 * 退出」 plus 「先弹确认框，列明会丢什么」, so what is pinned here is the
 * behaviour that ruling asks for:
 *
 *  - the numbers on the dialog are the real ones,
 *  - cancel changes NOTHING (no IPC, no routing event),
 *  - the IPC only ever fires after a yes,
 *  - and with nothing to lose there is no dialog at all.
 *
 * `window.electronAPI` is stubbed in `vi.hoisted` because zustand's `persist`
 * middleware rehydrates at module-import time and calls `settings.read()` while
 * doing it; a stub installed in `beforeEach` loses that race and the suite
 * hangs for ten seconds with no error.
 */

const electron = vi.hoisted(() => {
  const requestSignIn = vi.fn<() => Promise<AuthSignInRequestResult>>(async () => ({ ok: true }));
  window.electronAPI = {
    // `Dialog`/`AlertDialog` run `useTrafficLightsGuard`, which reads
    // `env.platform` on mount — without it the popup throws instead of opening.
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    auth: { requestSignIn },
  } as unknown as typeof window.electronAPI;
  return { requestSignIn };
});

const toasts: { title: string; description?: string }[] = [];
vi.mock('@/components/ui/toast', () => ({
  toastManager: { add: (toast: { title: string; description?: string }) => toasts.push(toast) },
}));
// The real `translate`, at the locale whose catalog is the key itself: the
// English sentence comes back with `{{count}}` substituted, which is exactly
// what has to be asserted (a mock that returned the bare key would pass while
// the dialog printed no numbers at all).
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate('en', key, params),
    locale: 'en',
  }),
}));

let SignInConfirmHost: typeof import('../SignInConfirmHost')['SignInConfirmHost'];
let useSignInRequest: typeof import('@/hooks/useSignInRequest')['useSignInRequest'];
let stores: {
  editor: typeof import('@/stores/editor')['useEditorStore'];
  terminal: typeof import('@/stores/terminal')['useTerminalStore'];
  terminalWrite: typeof import('@/stores/terminalWrite')['useTerminalWriteStore'];
  chat: typeof import('@/stores/chatSessions')['useChatSessionsStore'];
  confirm: typeof import('@/stores/signInConfirm');
};

let root: Root;
let container: HTMLDivElement;
let routeEvents: number;
let lastResult: boolean | null;

function countRouteEvent() {
  routeEvents += 1;
}

beforeAll(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ({ SignInConfirmHost } = await import('../SignInConfirmHost'));
  ({ useSignInRequest } = await import('@/hooks/useSignInRequest'));
  stores = {
    editor: (await import('@/stores/editor')).useEditorStore,
    terminal: (await import('@/stores/terminal')).useTerminalStore,
    terminalWrite: (await import('@/stores/terminalWrite')).useTerminalWriteStore,
    chat: (await import('@/stores/chatSessions')).useChatSessionsStore,
    confirm: await import('@/stores/signInConfirm'),
  };
});

/** A button that asks for the sign-in screen, plus the host that answers. */
function Probe({ prompt, withHost }: { prompt?: 'session-expired' | 'skip'; withHost: boolean }) {
  const { requestSignIn } = useSignInRequest();
  const [, force] = useState(0);
  return createElement(
    Fragment,
    null,
    createElement(
      'button',
      {
        type: 'button',
        id: 'ask',
        onClick: () => {
          void requestSignIn(prompt ? { prompt } : undefined).then((granted) => {
            lastResult = granted;
            force((n) => n + 1);
          });
        },
      },
      'ask'
    ),
    withHost ? createElement(SignInConfirmHost) : null
  );
}

function render(props: { prompt?: 'session-expired' | 'skip'; withHost?: boolean } = {}) {
  act(() => {
    root.render(createElement(Probe, { prompt: props.prompt, withHost: props.withHost ?? true }));
  });
}

function clickAsk(): Promise<void> {
  return act(async () => {
    container.querySelector<HTMLButtonElement>('#ask')?.click();
  });
}

/** The portalled dialog lives on `document.body`, not inside `container`. */
function dialogText(): string {
  return document.querySelector('[data-slot="alert-dialog-popup"]')?.textContent ?? '';
}

function dialogButton(label: string): HTMLButtonElement {
  const popup = document.querySelector('[data-slot="alert-dialog-popup"]');
  const found = [...(popup?.querySelectorAll('button') ?? [])].find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!found) throw new Error(`no "${label}" button in: ${dialogText()}`);
  return found;
}

function setLosses(input: {
  dirtyTabs?: number;
  shellTerminals?: number;
  agentTerminals?: number;
  runningTurns?: number;
}) {
  stores.editor.setState({
    tabs: Array.from({ length: input.dirtyTabs ?? 0 }, (_, i) => ({
      path: `/f${i}`,
      title: `f${i}`,
      content: 'x',
      isDirty: true,
    })),
    worktreeStates: {},
    currentWorktreePath: null,
  });
  stores.terminal.setState({
    sessions: Array.from({ length: input.shellTerminals ?? 0 }, (_, i) => ({
      id: `t${i}`,
      title: `t${i}`,
      cwd: '/tmp',
    })) as never,
  });
  stores.terminalWrite.setState({
    writers: new Map(
      Array.from({ length: input.agentTerminals ?? 0 }, (_, i) => [`a${i}`, () => undefined])
    ),
  });
  stores.chat.setState({
    sessions: Array.from({ length: input.runningTurns ?? 0 }, (_, i) => ({
      id: `s${i}`,
      projectId: 'p',
      workspaceId: 'w',
      title: `s${i}`,
      status: 'running',
      updatedAt: 0,
    })) as never,
  });
}

beforeEach(() => {
  toasts.length = 0;
  routeEvents = 0;
  lastResult = null;
  electron.requestSignIn.mockClear();
  electron.requestSignIn.mockResolvedValue({ ok: true });
  stores.confirm.resetSignInConfirmForTests();
  setLosses({});
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

describe('the confirmation in front of a sign-in request', () => {
  it('lists the real counts instead of a vague warning', async () => {
    setLosses({ dirtyTabs: 3, shellTerminals: 2, agentTerminals: 1, runningTurns: 1 });
    render();
    await clickAsk();

    const text = dialogText();
    // Every number the user needs to weigh the decision, and each attached to
    // the thing it counts.
    expect(text).toContain('1 chat(s) are mid-turn');
    expect(text).toContain('3 terminal(s) will close');
    expect(text).toContain('3 file(s) have unsaved edits');
    // The one true reassurance. "Your chats are unaffected" was the tempting
    // version and it does not survive checking — the turn survives, the
    // renderer's view of it does not.
    expect(text).toContain('Chat history is safe');
    expect(text).not.toContain('chats are not affected');
    // Nothing has happened yet.
    expect(electron.requestSignIn).not.toHaveBeenCalled();
    expect(routeEvents).toBe(0);
  });

  it('counts both terminal kinds as one number', async () => {
    setLosses({ shellTerminals: 4, agentTerminals: 3 });
    render();
    await clickAsk();
    expect(dialogText()).toContain('7 terminal(s) will close');
  });

  it('changes absolutely nothing when it is cancelled', async () => {
    setLosses({ shellTerminals: 1, dirtyTabs: 2 });
    const before = {
      tabs: stores.editor.getState().tabs,
      terminals: stores.terminal.getState().sessions,
    };
    render();
    await clickAsk();

    await act(async () => {
      dialogButton('Cancel').click();
    });

    // The whole point of the cancel: Main is never asked, so the credential
    // mode is not rewritten and the entry latch is not dropped.
    expect(electron.requestSignIn).not.toHaveBeenCalled();
    expect(routeEvents).toBe(0);
    expect(lastResult).toBe(false);
    // Declining is not a failure — narrating the user's own choice back at
    // them as an error toast is noise.
    expect(toasts).toEqual([]);
    // And no store was touched on the way past.
    expect(stores.editor.getState().tabs).toBe(before.tabs);
    expect(stores.terminal.getState().sessions).toBe(before.terminals);
    expect(stores.confirm.useSignInConfirmStore.getState().open).toBe(false);
  });

  it('asks Main only after the user says yes', async () => {
    setLosses({ shellTerminals: 1 });
    render();
    await clickAsk();
    expect(electron.requestSignIn).not.toHaveBeenCalled();

    await act(async () => {
      dialogButton('Continue to sign-in').click();
    });

    expect(electron.requestSignIn).toHaveBeenCalledTimes(1);
    expect(routeEvents).toBe(1);
    expect(lastResult).toBe(true);
    expect(dialogText()).toBe('');
  });

  it('skips the dialog entirely when there is nothing to lose', async () => {
    // Nothing open, nothing running. An empty confirmation box has no content
    // to weigh and only teaches the user to click through the next one.
    render();
    await clickAsk();

    expect(dialogText()).toBe('');
    expect(electron.requestSignIn).toHaveBeenCalledTimes(1);
    expect(routeEvents).toBe(1);
  });

  it('re-frames itself for the automatic credentials-invalid push', async () => {
    setLosses({ shellTerminals: 1 });
    render({ prompt: 'session-expired' });
    await clickAsk();

    const text = dialogText();
    // Nobody pressed anything, so "are you sure?" would ask the user to confirm
    // a decision that was made for them. It states the fact instead.
    expect(text).toContain('Your sign-in has expired');
    expect(text).not.toContain('Going to the sign-in screen closes this workspace');
    // Still the same losses, and still a way out — deferring is what lets
    // someone save their work before going.
    expect(text).toContain('1 terminal(s) will close');
    await act(async () => {
      dialogButton('Not now').click();
    });
    expect(electron.requestSignIn).not.toHaveBeenCalled();
    expect(routeEvents).toBe(0);
  });

  it('does not ask twice when the caller already did', async () => {
    // Logout's own confirm lists the same losses, and a second dialog would
    // arrive after the vault was already cleared — a "cancel" that cannot undo
    // anything.
    setLosses({ shellTerminals: 2, dirtyTabs: 1 });
    render({ prompt: 'skip' });
    await clickAsk();

    expect(dialogText()).toBe('');
    expect(electron.requestSignIn).toHaveBeenCalledTimes(1);
  });

  it('refuses rather than routing when the prompt cannot be shown', async () => {
    // Fail-closed on purpose. Fail-open would kill the user's terminals with no
    // warning at all — precisely when the safety net is the thing that broke.
    setLosses({ shellTerminals: 1 });
    render({ withHost: false });
    await clickAsk();

    expect(electron.requestSignIn).not.toHaveBeenCalled();
    expect(routeEvents).toBe(0);
    expect(lastResult).toBe(false);
    // Loud, not silent: a silent no-op here is the exact defect `a72e0337` fixed.
    expect(toasts.map((toast) => toast.title)).toEqual(['Could not open the sign-in screen']);
  });
});
