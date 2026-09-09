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

it('defaults off and restores the diff switch from persisted settings', async () => {
  await useSettingsStore.persist.rehydrate();
  expect(useSettingsStore.getState().showToolDiff).toBe(false);
  useSettingsStore.getState().setShowToolDiff(true);
  await vi.waitFor(() =>
    expect(disk.value).toMatchObject({ 'aiclient-settings': { state: { showToolDiff: true } } })
  );
  const saved = disk.value;
  useSettingsStore.setState({ showToolDiff: false });
  await Promise.resolve();
  disk.value = saved;
  await useSettingsStore.persist.rehydrate();
  expect(useSettingsStore.getState().showToolDiff).toBe(true);
});
