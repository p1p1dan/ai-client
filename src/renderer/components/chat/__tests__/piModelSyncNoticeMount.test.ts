// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PiModelSyncNotice } from '../PiModelSyncNotice';

/**
 * The card a user sees after a login whose model sync failed, mounted for
 * real.
 *
 * Two things only a mount can answer. First, that the failure Main recorded
 * actually reaches the screen — the whole defect was a renderer that was never
 * told. Second, that Retry re-syncs AND then re-reads the catalog: Main
 * invalidates its workers on a successful sync, but the renderer's catalog
 * cache is its own, so a retry that skipped the second call would leave the
 * model menu exactly as empty as before and read as a dead button.
 */

const getStatus = vi.fn();
const sync = vi.fn();
const listPiModels = vi.fn();

vi.hoisted(() => {
  // Hoisted, not `beforeEach`: `@/i18n` pulls in the zustand `persist` settings
  // store, which rehydrates at IMPORT time and calls `settings.read()`. A stub
  // installed in `beforeEach` arrives after that and the mount hangs with no
  // error at all.
  window.electronAPI = {
    settings: { read: async () => null, write: async () => undefined },
    piModels: {
      getStatus: (...args: unknown[]) => getStatusRef.fn(...args),
      sync: (...args: unknown[]) => syncRef.fn(...args),
    },
    chat: { listPiModels: (...args: unknown[]) => listPiModelsRef.fn(...args) },
    auth: { onStateChanged: () => () => undefined },
  } as unknown as typeof window.electronAPI;
});

// The stub above is installed before the spies exist, so it reaches them
// through these boxes rather than closing over an undefined binding.
const getStatusRef = { fn: getStatus };
const syncRef = { fn: sync };
const listPiModelsRef = { fn: listPiModels };

const i18n = { t: (key: string) => key, locale: 'en' };
vi.mock('@/i18n', () => ({ useI18n: () => i18n }));

function failedStatus(kind: string, managed = true) {
  return {
    endpointUrl: 'https://onboarding.example.com/api/v1/models-config',
    managed,
    state: {
      source: 'unavailable',
      endpointUrl: 'https://onboarding.example.com/api/v1/models-config',
      agentDir: '/tmp/agent',
      modelCount: 0,
      providerCount: 0,
      lastAttemptAt: 1,
      syncedAt: null,
    },
    lastFailure: { kind, error: 'fetch failed: ECONNREFUSED', at: 1_700_000_000_000 },
  };
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PiModelSyncNotice));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  getStatus.mockReset();
  sync.mockReset();
  listPiModels.mockReset();
  listPiModels.mockResolvedValue({ models: [{ id: 'dan/deepseek-v4', label: 'DeepSeek V4' }] });
});

describe('PiModelSyncNotice', () => {
  it('explains a failed sync in the user language and keeps the raw error as evidence', async () => {
    getStatus.mockResolvedValue(failedStatus('network'));
    const { container, unmount } = await mount();
    try {
      expect(container.textContent).toContain('Your company models could not be loaded');
      // The next step, not just the complaint.
      expect(container.textContent).toContain('try again');
      // The English diagnostic is present but LABELLED — evidence to forward,
      // never the app's account of what went wrong.
      expect(container.textContent).toContain('Details to send to your administrator:');
      expect(container.textContent).toContain('ECONNREFUSED');
    } finally {
      await unmount();
    }
  });

  it('retries with the forcing sync channel and then re-reads the catalog', async () => {
    getStatus.mockResolvedValue(failedStatus('network'));
    sync.mockResolvedValue({ ok: true, modelCount: 3, providerCount: 1 });
    const { container, unmount } = await mount();
    try {
      const retry = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Retry')
      );
      expect(retry).toBeTruthy();
      await act(async () => {
        retry?.click();
      });
      // `piModels.sync` IS the forcing channel — `ipc/piModels.ts` passes
      // `{ force: true }` — and it is called with no endpoint, so a retry can
      // never rewrite the stored management URL.
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync.mock.calls[0]?.[0]).toBeUndefined();
      expect(listPiModels).toHaveBeenCalledWith({ force: true });
    } finally {
      await unmount();
    }
  });

  it('offers a way back to sign-in, and no Retry, when the account is the problem', async () => {
    getStatus.mockResolvedValue(failedStatus('unauthorized'));
    const { container, unmount } = await mount();
    try {
      const labels = [...container.querySelectorAll('button')].map((b) => b.textContent);
      expect(labels.some((label) => label?.includes('Sign in again'))).toBe(true);
      // A retry would be refused identically every time.
      expect(labels.some((label) => label?.includes('Retry'))).toBe(false);
    } finally {
      await unmount();
    }
  });

  it('renders nothing on the local route', async () => {
    getStatus.mockResolvedValue(failedStatus('credentials-disabled', false));
    const { container, unmount } = await mount();
    try {
      expect(container.textContent).toBe('');
    } finally {
      await unmount();
    }
  });
});
