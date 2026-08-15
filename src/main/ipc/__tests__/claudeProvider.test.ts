import type { ClaudeProvider, ClaudeSettings, RepositoryRuntimeContext } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type ApplyProviderHandlerDeps,
  createApplyProviderHandler,
  createReadSettingsHandler,
  type ReadSettingsHandlerDeps,
} from '../claudeProvider';

/**
 * D47 S2b §1 Provider ①② — drives the REAL `createReadSettingsHandler` /
 * `createApplyProviderHandler` production seams (S1 §2.3 pattern), not rule
 * copies, so a mutation that skips the managed-mode trim/refusal is caught
 * through the exact functions `registerClaudeProviderHandlers` hands to
 * `ipcMain.handle`.
 */

const LOCAL_CONTEXT: RepositoryRuntimeContext = { kind: 'local', repoPath: undefined };
const REMOTE_CONTEXT: RepositoryRuntimeContext = {
  kind: 'remote',
  repoPath: 'remote-virtual-path',
  connectionId: 'conn-1',
};

const FULL_PROVIDER_EXTRACTED: Partial<ClaudeProvider> = {
  baseUrl: 'https://example.com/v1',
  authToken: 'super-secret-token',
  defaultSonnetModel: 'claude-sonnet-x',
  defaultOpusModel: 'claude-opus-x',
  defaultHaikuModel: 'claude-haiku-x',
};

const FULL_SETTINGS: ClaudeSettings = {
  env: {
    ANTHROPIC_BASE_URL: FULL_PROVIDER_EXTRACTED.baseUrl,
    ANTHROPIC_AUTH_TOKEN: FULL_PROVIDER_EXTRACTED.authToken,
  },
  hooks: { some: 'hook' },
};

function readSettingsDeps(
  overrides: Partial<ReadSettingsHandlerDeps> = {}
): ReadSettingsHandlerDeps {
  return {
    resolveContext: vi.fn(() => LOCAL_CONTEXT),
    readLocalSettings: vi.fn(() => FULL_SETTINGS),
    extractLocalProvider: vi.fn(() => FULL_PROVIDER_EXTRACTED),
    readRemoteSettings: vi.fn(async () => FULL_SETTINGS),
    extractRemoteProvider: vi.fn(() => FULL_PROVIDER_EXTRACTED),
    isManagedCredentialsEnabled: vi.fn(() => false),
    ...overrides,
  };
}

describe('createReadSettingsHandler — local context', () => {
  it('managed-off: returns the full settings + extracted (baseline, unchanged behavior)', async () => {
    const deps = readSettingsDeps({ isManagedCredentialsEnabled: () => false });
    const handler = createReadSettingsHandler(deps);

    const result = await handler(undefined, undefined);

    expect(result).toEqual({ settings: FULL_SETTINGS, extracted: FULL_PROVIDER_EXTRACTED });
  });

  it('managed-on: settings is null and extracted is whitelist-trimmed — no authToken, no raw settings', async () => {
    const deps = readSettingsDeps({ isManagedCredentialsEnabled: () => true });
    const handler = createReadSettingsHandler(deps);

    const result = await handler(undefined, undefined);

    expect(result.settings).toBeNull();
    expect(result.extracted).toEqual({
      baseUrl: FULL_PROVIDER_EXTRACTED.baseUrl,
      defaultSonnetModel: FULL_PROVIDER_EXTRACTED.defaultSonnetModel,
      defaultOpusModel: FULL_PROVIDER_EXTRACTED.defaultOpusModel,
      defaultHaikuModel: FULL_PROVIDER_EXTRACTED.defaultHaikuModel,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('authToken');
    expect(serialized).not.toContain(FULL_PROVIDER_EXTRACTED.authToken as string);
    expect(serialized).not.toContain('hooks');
  });

  it('managed-on with no extracted provider: extracted stays null (no crash on null input)', async () => {
    const deps = readSettingsDeps({
      isManagedCredentialsEnabled: () => true,
      extractLocalProvider: () => null,
    });
    const handler = createReadSettingsHandler(deps);

    const result = await handler(undefined, undefined);

    expect(result).toEqual({ settings: null, extracted: null });
  });
});

describe('createReadSettingsHandler — remote context (I8: never trimmed)', () => {
  it('managed-on has no effect on the remote branch — full settings/extracted pass through', async () => {
    const deps = readSettingsDeps({
      resolveContext: () => REMOTE_CONTEXT,
      isManagedCredentialsEnabled: () => true,
    });
    const handler = createReadSettingsHandler(deps);

    const result = await handler(undefined, 'remote-virtual-path');

    expect(result).toEqual({ settings: FULL_SETTINGS, extracted: FULL_PROVIDER_EXTRACTED });
    expect(deps.readRemoteSettings).toHaveBeenCalledWith('remote-virtual-path');
    expect(deps.readLocalSettings).not.toHaveBeenCalled();
  });
});

const SAMPLE_PROVIDER: ClaudeProvider = {
  id: 'p1',
  name: 'Test Provider',
  baseUrl: 'https://example.com/v1',
  authToken: 'token-abc',
};

function applyDeps(overrides: Partial<ApplyProviderHandlerDeps> = {}): ApplyProviderHandlerDeps {
  return {
    resolveContext: vi.fn(() => LOCAL_CONTEXT),
    readRemoteSettings: vi.fn(async () => FULL_SETTINGS),
    writeRemoteSettings: vi.fn(async () => true),
    applyProviderToSettings: vi.fn((settings) => settings),
    applyLocalProvider: vi.fn(() => true),
    isManagedCredentialsEnabled: vi.fn(() => false),
    ...overrides,
  };
}

describe('createApplyProviderHandler — return type stays boolean', () => {
  it('managed-off local: delegates to applyLocalProvider and returns its boolean', async () => {
    const deps = applyDeps({ isManagedCredentialsEnabled: () => false });
    const handler = createApplyProviderHandler(deps);

    const result = await handler(undefined, undefined, SAMPLE_PROVIDER);

    expect(result).toBe(true);
    expect(deps.applyLocalProvider).toHaveBeenCalledWith(SAMPLE_PROVIDER);
  });

  it('managed-on local: refuses without calling applyLocalProvider — returns false', async () => {
    const deps = applyDeps({ isManagedCredentialsEnabled: () => true });
    const handler = createApplyProviderHandler(deps);

    const result = await handler(undefined, undefined, SAMPLE_PROVIDER);

    expect(result).toBe(false);
    expect(deps.applyLocalProvider).not.toHaveBeenCalled();
  });

  it('remote context: managed-on has no effect — remote apply still proceeds (I8)', async () => {
    const deps = applyDeps({
      resolveContext: () => REMOTE_CONTEXT,
      isManagedCredentialsEnabled: () => true,
    });
    const handler = createApplyProviderHandler(deps);

    const result = await handler(undefined, 'remote-virtual-path', SAMPLE_PROVIDER);

    expect(result).toBe(true);
    expect(deps.writeRemoteSettings).toHaveBeenCalled();
    expect(deps.applyLocalProvider).not.toHaveBeenCalled();
  });
});
