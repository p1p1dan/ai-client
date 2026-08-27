import type { ClaudeProvider, ClaudeSettings, RepositoryRuntimeContext } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { type BrowserWindow, ipcMain } from 'electron';
import { resolveManagedCredentialsEnabled } from '../services/auth/credentialMode';
import {
  applyProvider,
  applyProviderToClaudeSettings,
  extractProviderFromClaudeSettings,
  extractProviderFromSettings,
  readClaudeSettings,
  trimManagedProviderExtracted,
  unwatchClaudeSettings,
  watchClaudeSettings,
} from '../services/claude/ClaudeProviderManager';
import {
  readRepositoryClaudeSettings,
  writeRepositoryClaudeSettings,
} from '../services/remote/RemoteEnvironmentService';
import { resolveRepositoryRuntimeContext } from '../services/repository/RepositoryContextResolver';

export interface ClaudeProviderReadSettingsResult {
  settings: ClaudeSettings | null;
  extracted: Partial<ClaudeProvider> | null;
}

export interface ReadSettingsHandlerDeps {
  resolveContext: (repoPath?: string) => RepositoryRuntimeContext;
  readLocalSettings: () => ClaudeSettings | null;
  extractLocalProvider: () => Partial<ClaudeProvider> | null;
  readRemoteSettings: (repoPath?: string) => Promise<ClaudeSettings | null>;
  extractRemoteProvider: (
    settings: ClaudeSettings | null | undefined
  ) => Partial<ClaudeProvider> | null;
  isManagedCredentialsEnabled: () => boolean;
}

/**
 * D47 S2b §1 Provider ① — pure factory (S1 §2.3 seam pattern, e.g.
 * `createVerifyAndRegisterHandler`): tests drive this real production seam
 * with fake deps, so a mutation that skips the managed-mode trim is caught
 * through the exact function wired to `ipcMain.handle`, not a rule copy.
 * Remote context is never trimmed (I8 — remote repos are not managed-home
 * subjects).
 */
export function createReadSettingsHandler(deps: ReadSettingsHandlerDeps) {
  return async (_event: unknown, repoPath?: string): Promise<ClaudeProviderReadSettingsResult> => {
    const context = deps.resolveContext(repoPath);
    if (context.kind === 'remote') {
      const settings = await deps.readRemoteSettings(repoPath);
      const extracted = deps.extractRemoteProvider(settings);
      return { settings, extracted };
    }

    const settings = deps.readLocalSettings();
    const extracted = deps.extractLocalProvider();
    if (deps.isManagedCredentialsEnabled()) {
      return { settings: null, extracted: trimManagedProviderExtracted(extracted) };
    }
    return { settings, extracted };
  };
}

export interface ApplyProviderHandlerDeps {
  resolveContext: (repoPath?: string) => RepositoryRuntimeContext;
  readRemoteSettings: (repoPath?: string) => Promise<ClaudeSettings | null>;
  writeRemoteSettings: (repoPath: string | undefined, data: ClaudeSettings) => Promise<boolean>;
  applyProviderToSettings: (settings: ClaudeSettings, provider: ClaudeProvider) => ClaudeSettings;
  applyLocalProvider: (provider: ClaudeProvider) => boolean;
  isManagedCredentialsEnabled: () => boolean;
}

/**
 * D47 S2b §1 Provider ② — return type stays `Promise<boolean>` (existing
 * renderer consumers all branch on truthiness: `ProviderList.tsx`,
 * `SessionBar.tsx`, `ActionPanel.tsx`). Managed local writes are refused
 * because in managed mode `~/.claude/settings.json`'s managed-home
 * counterpart is Main-owned (writes must go through `managedFileWriter`'s
 * serialized queue) — a direct `applyProvider()` write would race it.
 * Remote context is never blocked (I8).
 */
export function createApplyProviderHandler(deps: ApplyProviderHandlerDeps) {
  return async (
    _event: unknown,
    repoPath: string | undefined,
    provider: ClaudeProvider
  ): Promise<boolean> => {
    const context = deps.resolveContext(repoPath);
    if (context.kind === 'remote') {
      const settings = (await deps.readRemoteSettings(repoPath)) ?? {};
      return deps.writeRemoteSettings(repoPath, deps.applyProviderToSettings(settings, provider));
    }

    if (deps.isManagedCredentialsEnabled()) {
      console.warn(
        '[ClaudeProvider] Managed credentials enabled: refusing local provider apply ' +
          '(managed settings.json is Main-owned).'
      );
      return false;
    }

    return deps.applyLocalProvider(provider);
  };
}

export function registerClaudeProviderHandlers(): void {
  // 读取当前 Claude settings
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROVIDER_READ_SETTINGS,
    createReadSettingsHandler({
      resolveContext: resolveRepositoryRuntimeContext,
      readLocalSettings: readClaudeSettings,
      extractLocalProvider: extractProviderFromSettings,
      readRemoteSettings: readRepositoryClaudeSettings,
      extractRemoteProvider: extractProviderFromClaudeSettings,
      isManagedCredentialsEnabled: () => resolveManagedCredentialsEnabled(),
    })
  );

  // 应用 Provider 配置
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROVIDER_APPLY,
    createApplyProviderHandler({
      resolveContext: resolveRepositoryRuntimeContext,
      readRemoteSettings: readRepositoryClaudeSettings,
      writeRemoteSettings: writeRepositoryClaudeSettings,
      applyProviderToSettings: applyProviderToClaudeSettings,
      applyLocalProvider: applyProvider,
      isManagedCredentialsEnabled: () => resolveManagedCredentialsEnabled(),
    })
  );
}

// Keep a reference to the window for dynamic watcher toggling
let watcherWindow: BrowserWindow | null = null;

/**
 * Initialize provider watcher (only starts watching if enabled)
 */
export function initClaudeProviderWatcher(window: BrowserWindow, enabled: boolean): void {
  watcherWindow = window;
  if (enabled) {
    watchClaudeSettings(window);
  }
}

/**
 * Toggle provider watcher based on setting change
 */
export function toggleClaudeProviderWatcher(enabled: boolean): void {
  if (enabled && watcherWindow && !watcherWindow.isDestroyed()) {
    watchClaudeSettings(watcherWindow);
  } else {
    unwatchClaudeSettings();
  }
}
