// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_SDK_ENGINE_SETTING_KEY,
  DEFAULT_CLAUDE_SDK_ENGINE_ENABLED,
} from '@shared/claudeSdkEngine';
import { zhTranslations } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings';
import { migrateSettings } from '@/stores/settings/migration';
import { ClaudeSdkEngineSection } from '../ClaudeSdkEngineSection';

/**
 * Route B, S-1 (claude-sdk-engine topics/s1-engine-selection.md decisions 1
 * and 10): the settings half of the Claude engine switch. The store starts on
 * (the default Main applies when the key is absent), the switch writes the
 * boolean Main reads under `claudeSdkEngineEnabled`, and a hand-edited value
 * that is not a boolean comes back as the default.
 *
 * The `electronAPI` stub lives in `vi.hoisted` for the reason
 * `experimentalCacheControlSection.test.ts` gives.
 */
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

const TITLE = 'Claude engine';
const LABEL = 'Run Claude models on the official Agent SDK';
/** The row's visible label; the full sentence is the switch's accessible name. */
const ROW_LABEL = 'Use Agent SDK';
const DESCRIPTION =
  'When on, new Claude chats run on the official Claude Agent SDK; when off, they run on the built-in engine like other models. Applies to new chats; existing chats keep the engine they started on.';

describe('Claude engine switch (route B, S-1)', () => {
  it('starts on, says what it changes, and writes the switch to the store', async () => {
    // The store field is the key Main reads, and its default is the shared one.
    expect(CLAUDE_SDK_ENGINE_SETTING_KEY).toBe('claudeSdkEngineEnabled');
    expect(DEFAULT_CLAUDE_SDK_ENGINE_ENABLED).toBe(true);
    expect(useSettingsStore.getState().claudeSdkEngineEnabled).toBe(true);

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const toggle = () => container.querySelector<HTMLElement>('[role="switch"]');
    try {
      await act(async () => {
        root.render(createElement(ClaudeSdkEngineSection));
      });
      expect(container.textContent).toContain(TITLE);
      expect(container.textContent).toContain(ROW_LABEL);
      expect(container.textContent).toContain(DESCRIPTION);
      // Hard constraint 4: the product never calls it Claude Code.
      expect(container.textContent).not.toContain('Claude Code');
      expect(toggle()?.getAttribute('aria-label')).toBe(LABEL);
      expect(toggle()?.hasAttribute('data-checked')).toBe(true);

      await act(async () => toggle()?.click());
      expect(useSettingsStore.getState().claudeSdkEngineEnabled).toBe(false);
      expect(toggle()?.hasAttribute('data-checked')).toBe(false);

      await act(async () => toggle()?.click());
      expect(useSettingsStore.getState().claudeSdkEngineEnabled).toBe(true);
      expect(toggle()?.hasAttribute('data-checked')).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useSettingsStore.setState({ claudeSdkEngineEnabled: true });
      vi.unstubAllGlobals();
    }
  });

  it('keeps a stored boolean and turns anything else into the default on load', () => {
    const current = useSettingsStore.getState();
    expect(migrateSettings({ claudeSdkEngineEnabled: false }, current).claudeSdkEngineEnabled).toBe(
      false
    );
    expect(migrateSettings({ claudeSdkEngineEnabled: true }, current).claudeSdkEngineEnabled).toBe(
      true
    );
    for (const value of ['false', 0, null, {}]) {
      const migrated = migrateSettings(
        { claudeSdkEngineEnabled: value } as never,
        current
      ).claudeSdkEngineEnabled;
      expect(migrated, String(value)).toBe(DEFAULT_CLAUDE_SDK_ENGINE_ENABLED);
    }
    // An install that never touched it.
    expect(migrateSettings({ language: 'zh' }, current).claudeSdkEngineEnabled).toBe(true);
  });

  it('sits on the Models page, next to the other model-request settings', () => {
    // happy-dom replaces `URL`, so the path is built from the repo root.
    const page = readFileSync(
      path.join(process.cwd(), 'src/renderer/components/settings/PiModelManagementSettings.tsx'),
      'utf8'
    );
    const at = page.indexOf('<ClaudeSdkEngineSection />');
    expect(at).toBeGreaterThan(page.indexOf('<RequestUserAgentSection />'));
    expect(at).toBeLessThan(page.indexOf('<ExperimentalCacheControlSection />'));
  });

  it('has the Chinese copy the design names', () => {
    expect(zhTranslations[TITLE]).toBe('Claude 模型引擎');
    expect(zhTranslations[LABEL]).toBe('Claude 模型使用官方 Agent SDK');
    expect(zhTranslations[ROW_LABEL]).toBe('使用 Agent SDK');
    expect(zhTranslations[DESCRIPTION]).toBe(
      '开启后，新建的 Claude 对话由官方 Claude Agent SDK 驱动；关闭则与其他模型一样由内置引擎驱动。只影响新对话，已有对话保持创建时的引擎。'
    );
  });
});
