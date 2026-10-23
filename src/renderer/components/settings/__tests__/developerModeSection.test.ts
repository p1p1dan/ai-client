// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { zhTranslations } from '@shared/i18n';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings';
import { AdvancedSettings } from '../AdvancedSettings';
import { DeveloperModeSection } from '../DeveloperModeSection';
import { DeveloperModelSections } from '../PiModelManagementSettings';

/**
 * S-6 feedback 10 (claude-sdk-engine README ruling 26): the developer mode
 * switch sits in plain sight on the Advanced page, starts off, and the three
 * Models-page settings it gates are only rendered while it is on. The values
 * they read while it is off are covered by
 * `stores/settings/__tests__/developerMode.test.ts`.
 *
 * The `electronAPI` stub lives in `vi.hoisted` for the reason
 * `experimentalCacheControlSection.test.ts` gives.
 */
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux', appVersion: '1.1.0' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

const TITLE = 'Developer mode';
const SWITCH_LABEL = 'Enable developer mode';
const DESCRIPTION =
  'Shows settings meant for development and testing below: request identity (User-Agent), the Agent SDK engine switch with its automatic compaction threshold and empty system message fix, caching tool definitions and the chat list title. While off, they are hidden and run on their defaults; values you set are kept and apply again when you turn it back on.';
/** The titles of the three gated sections. */
const GATED_TITLES = [
  'Request identity (User-Agent)',
  'Agent SDK engine',
  'Cache breakpoint on tool definitions',
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useSettingsStore.setState({ developerModeEnabled: false });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSettingsStore.setState({
    developerModeEnabled: false,
    experimentalCacheControlOnTools: false,
    claudeSdkEngineEnabled: true,
    requestUserAgentMode: 'default',
    requestUserAgentCustom: '',
  });
  vi.unstubAllGlobals();
});

const developerSwitch = () =>
  container.querySelector<HTMLElement>(`[role="switch"][aria-label="${SWITCH_LABEL}"]`);

describe('developer mode (S-6 feedback 10)', () => {
  it('is on the Advanced page, off by default', async () => {
    await act(async () => {
      root.render(createElement(AdvancedSettings));
    });
    expect(container.textContent).toContain(TITLE);
    expect(container.textContent).toContain(DESCRIPTION);
    expect(developerSwitch()).not.toBeNull();
    expect(developerSwitch()?.hasAttribute('data-checked')).toBe(false);
  });

  it('hides the three gated settings while off and shows them once on, keeping their values', async () => {
    useSettingsStore.setState({ claudeSdkEngineEnabled: false });
    // The switch's own description names the three, so they render apart from it.
    await act(async () => {
      root.render(
        createElement(
          Fragment,
          null,
          createElement(DeveloperModeSection),
          createElement(
            'section',
            { 'data-testid': 'models' },
            createElement(DeveloperModelSections)
          )
        )
      );
    });
    const models = () => container.querySelector('[data-testid="models"]');
    expect(models()?.childElementCount).toBe(0);

    await act(async () => developerSwitch()?.click());
    expect(useSettingsStore.getState().developerModeEnabled).toBe(true);
    for (const title of GATED_TITLES) expect(models()?.textContent).toContain(title);
    // The engine switch shows the value stored before developer mode was on.
    const engineSwitch = models()?.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Run Anthropic-protocol models on the official Agent SDK"]'
    );
    expect(engineSwitch?.hasAttribute('data-checked')).toBe(false);

    await act(async () => developerSwitch()?.click());
    expect(useSettingsStore.getState().developerModeEnabled).toBe(false);
    expect(models()?.childElementCount).toBe(0);
    expect(useSettingsStore.getState().claudeSdkEngineEnabled).toBe(false);
  });

  it('gates the three sections, drawn under the switch on the Advanced page', () => {
    // happy-dom replaces `URL`, so the path is built from the repo root.
    const page = readFileSync(
      path.join(process.cwd(), 'src/renderer/components/settings/PiModelManagementSettings.tsx'),
      'utf8'
    );
    const gate = page.slice(page.indexOf('export function DeveloperModelSections'));
    for (const section of [
      '<RequestUserAgentSection />',
      '<ClaudeSdkEngineSection />',
      '<ExperimentalCacheControlSection />',
    ]) {
      expect(page.split(section).length - 1, section).toBe(1);
      expect(gate).toContain(section);
    }
    // User, 2026-10-23: no developer setting on the Models page any more.
    expect(page).not.toContain('<DeveloperModelSections />');
    const advancedPage = readFileSync(
      path.join(process.cwd(), 'src/renderer/components/settings/AdvancedSettings.tsx'),
      'utf8'
    );
    expect(advancedPage).toContain('<DeveloperModeSection />\n      <DeveloperModelSections />');
    // Web Inspector stays outside developer mode.
    const advanced = readFileSync(
      path.join(process.cwd(), 'src/renderer/components/settings/DeveloperModeSection.tsx'),
      'utf8'
    );
    expect(advanced).not.toContain('WebInspector');
  });

  it('has Chinese copy', () => {
    expect(zhTranslations[TITLE]).toBe('开发人员模式');
    expect(zhTranslations[SWITCH_LABEL]).toBe('启用开发人员模式');
    expect(zhTranslations[DESCRIPTION]).toBe(
      '在下方显示供开发与测试用的设置：请求标识（User-Agent）、Agent SDK 引擎开关及其自动压缩阈值和空 system 消息修复、缓存工具定义和对话列表标题行。关闭时这些设置隐藏，并按默认值生效；你改过的值会保留，重新打开后恢复生效。'
    );
  });
});
