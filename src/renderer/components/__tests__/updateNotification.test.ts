// @vitest-environment happy-dom
import type { UpdateStatus } from '@shared/types/updater';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { showUpdateReminder, subscribeUpdater, useUpdaterStore } from '@/stores/updater';
import { UpdateNotification } from '../UpdateNotification';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

it('keeps an entry after Later, reopens the dialog, and requests restart only on click', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const install = vi.fn().mockResolvedValue(undefined);
  window.electronAPI = {
    env: { platform: 'linux' },
    updater: {
      onStatus: () => () => {},
      getStatus: async () => ({ status: 'downloaded', info: { version: '2' } }),
      quitAndInstall: install,
    },
  } as unknown as typeof window.electronAPI;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === label
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  try {
    await act(async () => root.render(createElement(UpdateNotification)));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await click('Later');
    expect(install).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="status"] button')!.click()
    );
    await click('Restart now');
    expect(install).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('keeps failed checks off the reminder but offers retry for a failed download', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useUpdaterStore.setState({ status: null });
  let receive!: (status: UpdateStatus) => void;
  const download = vi.fn().mockResolvedValue(undefined);
  window.electronAPI = {
    env: { platform: 'linux' },
    updater: {
      onStatus: (callback: (status: UpdateStatus) => void) => {
        receive = callback;
        return () => {};
      },
      getStatus: async () => ({ status: 'error', error: 'offline' }),
      downloadUpdate: download,
    },
  } as unknown as typeof window.electronAPI;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(UpdateNotification)));
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => receive({ status: 'error', info: { version: '2' }, error: 'reset' }));
    const entry = container.querySelector<HTMLButtonElement>('[role="status"] button');
    expect(entry?.textContent).toBe('Update failed · v2');
    await act(async () => entry!.click());
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    await act(async () => retry!.click());
    expect(download).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('does not let an old snapshot overwrite a live update and shares one subscription', async () => {
  let receive!: (status: UpdateStatus) => void;
  let resolve!: (status: UpdateStatus) => void;
  const cleanup = vi.fn();
  const onStatus = vi.fn((callback: (status: UpdateStatus) => void) => {
    receive = callback;
    return cleanup;
  });
  window.electronAPI = {
    env: { platform: 'linux' },
    updater: {
      onStatus,
      getStatus: () =>
        new Promise<UpdateStatus>((done) => {
          resolve = done;
        }),
    },
  } as unknown as typeof window.electronAPI;
  const first = subscribeUpdater();
  const second = subscribeUpdater();
  receive({ status: 'downloaded', info: { version: '2' } });
  resolve({ status: 'available', info: { version: '2' } });
  await Promise.resolve();
  expect(useUpdaterStore.getState().status?.status).toBe('downloaded');
  expect(onStatus).toHaveBeenCalledOnce();
  first();
  expect(cleanup).not.toHaveBeenCalled();
  second();
  expect(cleanup).toHaveBeenCalledOnce();
});

it('hides until the next launch, stays hidden for a newer version, and a manual check brings it back', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useUpdaterStore.setState({ status: null, reminderHidden: false });
  let receive!: (status: UpdateStatus) => void;
  window.electronAPI = {
    env: { platform: 'linux' },
    updater: {
      onStatus: (callback: (status: UpdateStatus) => void) => {
        receive = callback;
        return () => {};
      },
      getStatus: async () => ({ status: 'downloading', info: { version: '2' } }),
    },
  } as unknown as typeof window.electronAPI;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const entry = () => container.querySelector<HTMLButtonElement>('[role="status"] button');
  try {
    await act(async () => root.render(createElement(UpdateNotification)));
    expect(entry()?.textContent).toBe('Downloading update · v2');
    const hide = container.querySelector<HTMLButtonElement>(
      '[role="status"] button[aria-label="Hide until next launch"]'
    );
    await act(async () => hide!.click());
    expect(container.querySelector('[role="status"]')).toBeNull();
    // Decision 213: a newer version landing later in this launch stays quiet.
    await act(async () => receive({ status: 'downloaded', info: { version: '3' } }));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // A manual check in Settings brings the pill back without popping the dialog.
    await act(async () => showUpdateReminder());
    expect(entry()?.textContent).toBe('Update ready · v3');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useUpdaterStore.setState({ reminderHidden: false });
    vi.unstubAllGlobals();
  }
});
