// @vitest-environment happy-dom
import { CLAUDE_SDK_ENGINE_SETTING_KEY } from '@shared/claudeSdkEngine';
import {
  applyDeveloperModeGate,
  DEFAULT_DEVELOPER_MODE_ENABLED,
  DEVELOPER_MODE_SETTING_KEY,
  DEVELOPER_MODE_SETTING_KEYS,
} from '@shared/developerMode';
import { CACHE_CONTROL_ON_TOOLS_SETTING_KEY } from '@shared/types/cacheControlOnTools';
import {
  REQUEST_USER_AGENT_CUSTOM_SETTING_KEY,
  REQUEST_USER_AGENT_MODE_SETTING_KEY,
} from '@shared/types/requestUserAgent';
import { describe, expect, it, vi } from 'vitest';

/**
 * S-6 feedback 10 (claude-sdk-engine README ruling 26): developer mode is off
 * by default, and while it is off every reader sees the three settings it
 * gates at their defaults; the stored values stay, so turning it back on
 * restores them. Main's three reads have their own developer-mode blocks in
 * `main/services/agent-host/__tests__/*Setting.test.ts`.
 */
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
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));

import { effectiveClaudeSdkEngineEnabled } from '../developerMode';
import { useSettingsStore } from '../index';
import { migrateSettings } from '../migration';

const STORED = {
  [CACHE_CONTROL_ON_TOOLS_SETTING_KEY]: true,
  [CLAUDE_SDK_ENGINE_SETTING_KEY]: false,
  [REQUEST_USER_AGENT_MODE_SETTING_KEY]: 'custom',
  [REQUEST_USER_AGENT_CUSTOM_SETTING_KEY]: 'gw/2',
};

describe('the developer-mode gate', () => {
  it('holds exactly the three settings of ruling 26, keyed as the store names them', () => {
    expect(DEVELOPER_MODE_SETTING_KEY).toBe('developerModeEnabled');
    expect([...DEVELOPER_MODE_SETTING_KEYS].sort()).toEqual(
      [
        'claudeSdkEngineEnabled',
        'experimentalCacheControlOnTools',
        'requestUserAgentCustom',
        'requestUserAgentMode',
      ].sort()
    );
    // Web Inspector stays out.
    expect(DEVELOPER_MODE_SETTING_KEYS).not.toContain('webInspectorEnabled');
  });

  it('hides the gated values while off, whatever else is stored, and passes them on once on', () => {
    const others = { theme: 'dark', webInspectorEnabled: true };
    for (const developerModeEnabled of [false, undefined, 'true', 1]) {
      const gated = applyDeveloperModeGate({ ...others, ...STORED, developerModeEnabled });
      for (const key of DEVELOPER_MODE_SETTING_KEYS) {
        expect(gated[key], `${String(developerModeEnabled)} ${key}`).toBeUndefined();
      }
      expect(gated).toMatchObject(others);
    }
    const open = { ...others, ...STORED, developerModeEnabled: true };
    expect(applyDeveloperModeGate(open)).toEqual(open);
  });

  it('never touches the state it reads', () => {
    const state = { ...STORED, developerModeEnabled: false };
    applyDeveloperModeGate(state);
    expect(state).toEqual({ ...STORED, developerModeEnabled: false });
  });
});

describe('the renderer reads the engine switch through the gate', () => {
  it('is the default while developer mode is off, and the stored value once it is on', () => {
    expect(
      effectiveClaudeSdkEngineEnabled({
        developerModeEnabled: false,
        claudeSdkEngineEnabled: false,
      })
    ).toBe(true);
    expect(
      effectiveClaudeSdkEngineEnabled({ developerModeEnabled: true, claudeSdkEngineEnabled: false })
    ).toBe(false);
    expect(
      effectiveClaudeSdkEngineEnabled({ developerModeEnabled: true, claudeSdkEngineEnabled: true })
    ).toBe(true);
  });
});

describe('the developer mode setting', () => {
  it('starts off and keeps a stored boolean, turning anything else into the default', () => {
    expect(DEFAULT_DEVELOPER_MODE_ENABLED).toBe(false);
    const current = useSettingsStore.getState();
    expect(current.developerModeEnabled).toBe(false);
    expect(migrateSettings({ developerModeEnabled: true }, current).developerModeEnabled).toBe(
      true
    );
    expect(migrateSettings({ developerModeEnabled: false }, current).developerModeEnabled).toBe(
      false
    );
    for (const value of ['true', 1, null, {}]) {
      expect(
        migrateSettings({ developerModeEnabled: value } as never, current).developerModeEnabled,
        String(value)
      ).toBe(false);
    }
    expect(migrateSettings({ language: 'zh' }, current).developerModeEnabled).toBe(false);
  });

  it('is persisted, and switching it leaves the stored values of the settings it gates alone', async () => {
    await useSettingsStore.persist.rehydrate();
    useSettingsStore.setState({
      experimentalCacheControlOnTools: true,
      claudeSdkEngineEnabled: false,
      requestUserAgentMode: 'custom',
      requestUserAgentCustom: 'gw/2',
    });
    const { setDeveloperModeEnabled } = useSettingsStore.getState();
    setDeveloperModeEnabled(true);
    await vi.waitFor(() =>
      expect(disk.value).toMatchObject({
        'aiclient-settings': { state: { developerModeEnabled: true } },
      })
    );
    setDeveloperModeEnabled(false);
    await vi.waitFor(() =>
      expect(disk.value).toMatchObject({
        'aiclient-settings': { state: { developerModeEnabled: false, ...STORED } },
      })
    );
    expect(useSettingsStore.getState()).toMatchObject(STORED);
    expect(effectiveClaudeSdkEngineEnabled(useSettingsStore.getState())).toBe(true);
    setDeveloperModeEnabled(true);
    expect(effectiveClaudeSdkEngineEnabled(useSettingsStore.getState())).toBe(false);
  });
});
