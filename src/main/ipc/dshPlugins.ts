/**
 * dsh-rebase P1-10c — Settings → Extensions → Plugins (decisions 108, 110,
 * 115 and 117).
 *
 * Two channels and nothing else: `list` reads, `setEnabled` stores one
 * per-plugin override. There is no install and no removal (decisions 058,
 * 059): the plugins are the allowlisted ones this build ships. One event goes
 * the other way (P1-7e e5, decision 143): `changed`, the page's whole new
 * state, sent to every window after each host start that replaced the plugin
 * report — a restart a switch caused, or the first chat's start — so an open
 * page follows it instead of showing what it read when it opened.
 *
 * The user's choice and the host's state go only through the three calls of
 * `services/agent-host/dshHostPlugins.ts` (decision 108 rule 7): the
 * selection is never written to the settings file here, and the host is
 * never restarted here — `setDshPluginSelection` asks `WorkerManager` for
 * that, which waits until no session has work in flight. The allowlist
 * itself (versions, source kind, tool classes, reviews) is read from the
 * app's own install tree (`pluginCatalog.ts`).
 *
 * The renderer is untrusted: a name must be a plugin this build ships, and
 * `enabled` a boolean, or the request is refused before anything is written.
 */

import type { DshPluginsState, SetDshPluginEnabledRequest } from '@shared/dshPluginSettings';
import type { DshPluginReport } from '@shared/dshPlugins';
import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, ipcMain } from 'electron';
import {
  getDshPluginReport,
  getDshPluginSelection,
  onDshPluginReport,
  setDshPluginSelection,
} from '../services/agent-host/dshHostPlugins';
import {
  type DshPluginCatalog,
  readCurrentDshPluginCatalog,
} from '../services/dshPlugins/pluginCatalog';
import { buildDshPluginsState, withOverride } from '../services/dshPlugins/pluginsView';

export interface DshPluginIpcDeps {
  catalog: () => DshPluginCatalog;
  getSelection: () => Record<string, boolean> | undefined;
  setSelection: (overrides: Record<string, boolean> | undefined) => boolean;
  report: () => DshPluginReport | undefined;
  /** Be told when a host start replaced the report; returns the unsubscribe. */
  onReport: (listener: () => void) => () => void;
  /** Hand the page's new state to every window. */
  broadcast: (state: DshPluginsState) => void;
}

function broadcastToWindows(state: DshPluginsState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC_CHANNELS.DSH_PLUGINS_CHANGED, state);
    } catch {
      // The window may be closing mid-send.
    }
  }
}

const productionDeps: DshPluginIpcDeps = {
  catalog: () => readCurrentDshPluginCatalog(),
  getSelection: () => getDshPluginSelection(),
  setSelection: (overrides) => setDshPluginSelection(overrides),
  report: () => getDshPluginReport(),
  onReport: (listener) => onDshPluginReport(listener),
  broadcast: broadcastToWindows,
};

function readRequest(payload: unknown): SetDshPluginEnabledRequest {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Invalid plugin request');
  }
  const { name, enabled } = payload as Record<string, unknown>;
  if (typeof name !== 'string' || name === '') throw new Error('Invalid plugin request: name');
  if (typeof enabled !== 'boolean') throw new Error('Invalid plugin request: enabled');
  return { name, enabled };
}

function stateOf(deps: DshPluginIpcDeps, catalog: DshPluginCatalog): DshPluginsState {
  return buildDshPluginsState({
    catalog,
    overrides: deps.getSelection(),
    report: deps.report(),
  });
}

export function listDshPlugins(deps: DshPluginIpcDeps = productionDeps): DshPluginsState {
  return stateOf(deps, deps.catalog());
}

/**
 * Store the user's choice for one shipped plugin, keeping every other
 * override, and answer with the page's new state. Refused for a name the
 * catalog does not list — including a delisted one: the page has no control
 * for those, so nothing legitimate sends it.
 */
export function setDshPluginEnabled(
  payload: unknown,
  deps: DshPluginIpcDeps = productionDeps
): DshPluginsState {
  const { name, enabled } = readRequest(payload);
  const catalog = deps.catalog();
  if (!catalog.plugins.some((plugin) => plugin.name === name)) {
    throw new Error(`Invalid plugin request: ${JSON.stringify(name)} is not an available plugin`);
  }
  deps.setSelection(withOverride(deps.getSelection(), name, enabled));
  return stateOf(deps, catalog);
}

/**
 * Registers the two channels and starts pushing `changed`; returns the
 * unsubscribe from the report (the app never calls it: the handlers live as
 * long as Main does).
 */
export function registerDshPluginHandlers(deps: DshPluginIpcDeps = productionDeps): () => void {
  const unsubscribe = deps.onReport(() => {
    let state: DshPluginsState;
    try {
      state = listDshPlugins(deps);
    } catch (error) {
      console.warn('[dsh-plugins] could not read the plugin state after a host start', error);
      return;
    }
    deps.broadcast(state);
  });
  ipcMain.handle(
    IPC_CHANNELS.DSH_PLUGINS_LIST,
    async (): Promise<DshPluginsState> => listDshPlugins(deps)
  );
  ipcMain.handle(
    IPC_CHANNELS.DSH_PLUGINS_SET_ENABLED,
    async (_event, payload: unknown): Promise<DshPluginsState> => setDshPluginEnabled(payload, deps)
  );
  return unsubscribe;
}
