/**
 * docs/plantree/plans/claude-plugins — Settings → Plugins → Claude plugins
 * and Claude MCP servers. Every change is one bundled-CLI command against the
 * user layer (`ClaudePluginService`); nothing here writes the CLI's files.
 *
 * The renderer is untrusted: ids, names and sources are checked by the service
 * before they reach the CLI's argv (no shell), and a repository path must be an
 * absolute existing directory or it is dropped.
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import type {
  ClaudeAvailablePlugin,
  ClaudeCliResult,
  ClaudeMcpServerInput,
  ClaudeMcpState,
  ClaudePluginsState,
} from '@shared/claudePlugins';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { claudeSdkBundledCli, claudeSdkConfigDir } from '../services/agent-host/claudeSdkEngine';
import { ClaudePluginService } from '../services/claudePlugins/ClaudePluginService';
import { buildClaudeCliEnvironment, createClaudeCliRun } from '../services/claudePlugins/claudeCli';
import { notifyClaudeUserLayerChanged } from '../services/claudePlugins/userLayerEvents';
import { getEngineProxySetting } from '../services/proxy/ProxyConfig';

function repositoryOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return undefined;
  try {
    return statSync(value).isDirectory() ? value : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function mcpInput(payload: unknown): ClaudeMcpServerInput | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const input = payload as Record<string, unknown>;
  const name = text(input.name).trim();
  if (input.transport === 'stdio') {
    const args = Array.isArray(input.args) ? input.args.filter((a) => typeof a === 'string') : [];
    return {
      name,
      transport: 'stdio',
      command: text(input.command),
      args,
      env: stringMap(input.env),
    };
  }
  if (input.transport === 'http' || input.transport === 'sse') {
    return {
      name,
      transport: input.transport,
      url: text(input.url),
      headers: stringMap(input.headers),
    };
  }
  return null;
}

let service: ClaudePluginService | null = null;

function claudePlugins(): ClaudePluginService {
  service ??= new ClaudePluginService({
    run: createClaudeCliRun({
      cliPath: claudeSdkBundledCli,
      defaultCwd: claudeSdkConfigDir,
      env: () =>
        buildClaudeCliEnvironment({
          inherited: process.env,
          configDir: claudeSdkConfigDir(),
          proxy: getEngineProxySetting(),
          gitBashPath: process.env.AICLIENT_GIT_BASH_PATH?.trim() || undefined,
        }),
    }),
    configDir: claudeSdkConfigDir,
    onChanged: notifyClaudeUserLayerChanged,
  });
  return service;
}

export function registerClaudePluginHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_STATE,
    (_event, repo: unknown): Promise<ClaudePluginsState> =>
      claudePlugins().state(repositoryOf(repo))
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_AVAILABLE,
    (): Promise<ClaudeAvailablePlugin[]> => claudePlugins().available()
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_INSTALL,
    (_event, id: unknown): Promise<ClaudeCliResult> => claudePlugins().install(text(id))
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_SET_ENABLED,
    (_event, id: unknown, enabled: unknown): Promise<ClaudeCliResult> =>
      claudePlugins().setEnabled(text(id), enabled === true)
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_UNINSTALL,
    (_event, id: unknown): Promise<ClaudeCliResult> => claudePlugins().uninstall(text(id))
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_UPDATE,
    (_event, id: unknown): Promise<ClaudeCliResult> => claudePlugins().update(text(id))
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_ADD_MARKETPLACE,
    (_event, source: unknown): Promise<ClaudeCliResult> =>
      claudePlugins().addMarketplace(text(source))
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_REMOVE_MARKETPLACE,
    (_event, name: unknown): Promise<ClaudeCliResult> =>
      claudePlugins().removeMarketplace(text(name))
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_UPDATE_MARKETPLACE,
    (_event, name: unknown): Promise<ClaudeCliResult> =>
      claudePlugins().updateMarketplace(text(name))
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_MCP_STATE,
    (_event, repo: unknown): Promise<ClaudeMcpState> => claudePlugins().mcpState(repositoryOf(repo))
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_MCP_ADD,
    (_event, payload: unknown): Promise<ClaudeCliResult> => {
      const input = mcpInput(payload);
      return input
        ? claudePlugins().addMcpServer(input)
        : Promise.resolve({ ok: false, error: 'Not a server' });
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_MCP_REMOVE,
    (_event, name: unknown): Promise<ClaudeCliResult> => claudePlugins().removeMcpServer(text(name))
  );
}
