/** The Plugins page's view of installed plugins, and its IPC (plugin-system README §3.5). */

import type { PluginStatus } from './api.ts';
import type { PluginPermission, PluginSettingContrib } from './manifest.ts';

export type PluginRunState = 'stopped' | 'starting' | 'running' | 'failed';

export interface PluginSettingView {
  setting: PluginSettingContrib;
  /** For a secret, `true`/`false` (set or not), never the value. */
  value: unknown;
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  permissions: PluginPermission[];
  netHosts: string[];
  enabled: boolean;
  state: PluginRunState;
  /** Restarts since the plugin last stayed up 60s. */
  restartCount: number;
  lastError?: string;
  status?: PluginStatus;
  services: Array<{ id: string; title?: string; state: 'stopped' | 'running' | 'failed' }>;
  settings: PluginSettingView[];
}

export type PluginInstallResult = { ok: true; plugin: PluginView } | { ok: false; error: string };

export const PLUGIN_IPC = {
  list: 'plugins:list',
  /** Main opens the file picker, so the renderer never names a path. */
  pickAndInstall: 'plugins:pickAndInstall',
  setEnabled: 'plugins:setEnabled',
  uninstall: 'plugins:uninstall',
  setSetting: 'plugins:setSetting',
  /** Pushed to every window: the full list after any change. */
  changed: 'plugins:changed',
} as const;
