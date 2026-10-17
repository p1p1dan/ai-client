// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { describe, expect, it, vi } from 'vitest';

// Persisted stores rehydrate at import: give them the bridge they read first.
vi.hoisted(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: { onRuntimeEvent: () => () => undefined },
  };
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));

const { autoTurnHeadLabel } = await import('../DshTimelineRows');

// Route B S-6 (ruling 24): a ScheduleWakeup / cron prompt coming due opens a turn of its own.
describe('the head of a turn a schedule started', () => {
  const zh = (key: string, params?: Record<string, string | number>) =>
    translate('zh', key, params);
  it('says a scheduled task came due, not that a background task finished', () => {
    const view = { origin: { kind: 'scheduled' as const }, detail: '', expandable: false };
    expect(autoTurnHeadLabel(view, zh)).toBe('定时任务到点，自动继续');
    expect(autoTurnHeadLabel({ ...view, origin: { kind: 'job' } }, zh)).toBe(
      '后台任务已结束，自动继续'
    );
  });
});
