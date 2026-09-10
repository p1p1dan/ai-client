// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ value: null as unknown }));
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: {
      read: async () => disk.value,
      write: async (value: unknown) => {
        disk.value = value;
      },
    },
    app: { setLanguage: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));

import { useSettingsStore } from '../index';

it('defaults on and restores the review switch from persisted settings', async () => {
  await useSettingsStore.persist.rehydrate();
  expect(useSettingsStore.getState().showSessionReview).toBe(true);
  useSettingsStore.getState().setShowSessionReview(false);
  await vi.waitFor(() =>
    expect(disk.value).toMatchObject({
      'aiclient-settings': { state: { showSessionReview: false } },
    })
  );
  const saved = disk.value;
  useSettingsStore.setState({ showSessionReview: true });
  await Promise.resolve();
  disk.value = saved;
  await useSettingsStore.persist.rehydrate();
  expect(useSettingsStore.getState().showSessionReview).toBe(false);
});
