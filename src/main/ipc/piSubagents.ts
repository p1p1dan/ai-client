/**
 * P5-2-5 — IPC for the subagent management UI.
 *
 * Thin on purpose: every handler validates its payload, calls one service
 * method, and answers with the WHOLE catalog. Returning the full view after a
 * mutation is what lets the renderer drop an optimistic edit and adopt the
 * truth in one step — and the truth includes what the save did to everything
 * else, like a rename that stopped shadowing a builtin and brought it back.
 *
 * Nothing here restarts a worker. Definitions are re-read at the top of every
 * top-level run (the contract's "每个顶层用户 run 重新读取活动定义"), so an edit
 * lands on the next turn by itself, and a running delegate keeps the snapshot it
 * started with. Invalidating workers on every keystroke in this page would kill
 * live sessions to apply a change they will pick up anyway.
 */

import { mkdir } from 'node:fs/promises';
import {
  isSubagentPermission,
  MAX_SUBAGENT_MAX_TURNS,
  SUBAGENT_THINKING_LEVELS,
  type SubagentThinkingLevel,
} from '@shared/subagentDefinition';
import { IPC_CHANNELS } from '@shared/types';
import type { SubagentCatalogView, SubagentSaveRequest } from '@shared/types/subagentManagement';
import { ipcMain, shell } from 'electron';
import { SubagentCatalogService } from '../services/agent-host/subagentCatalog';
import { getAppPiAgentDir } from '../services/piModelConfig';
import { readSharedSettings } from '../services/SharedSessionState';
import { mergeSettingsPatch } from './settings';

const service = new SubagentCatalogService({
  agentDir: () => getAppPiAgentDir(),
  readSettings: () => readSharedSettings(),
  writeSettings: (patch) => mergeSettingsPatch(patch),
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid subagent request');
  }
  return value as Record<string, unknown>;
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string') throw new Error(`Invalid subagent request: ${key}`);
  return value;
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid subagent request: ${key}`);
  return value;
}

/**
 * Read one save request.
 *
 * Rejects rather than coerces, field by field, for the reason the whole feature
 * exists: a management surface that quietly accepted a bad `permission` and
 * wrote the default instead would widen or narrow a delegate's approval gear
 * without anybody deciding to.
 */
function readSaveRequest(payload: unknown): SubagentSaveRequest {
  const raw = asRecord(payload);
  const tools = raw.tools;
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) {
    throw new Error('Invalid subagent request: tools');
  }

  const thinking = optionalString(raw, 'thinkingLevel');
  if (thinking && !(SUBAGENT_THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error('Invalid subagent request: thinkingLevel');
  }
  const permission = optionalString(raw, 'permission');
  if (permission && !isSubagentPermission(permission)) {
    throw new Error('Invalid subagent request: permission');
  }

  let model: SubagentSaveRequest['model'];
  if (raw.model !== undefined && raw.model !== null) {
    const pin = asRecord(raw.model);
    model = {
      provider: requireString(pin, 'provider'),
      modelId: requireString(pin, 'modelId'),
    };
  }

  let maxTurns: number | undefined;
  if (raw.maxTurns !== undefined && raw.maxTurns !== null) {
    const value = raw.maxTurns;
    // Absent is unlimited, and so is 0 — the UI's "clear the cap" sends either.
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('Invalid subagent request: maxTurns');
    }
    if (value > MAX_SUBAGENT_MAX_TURNS) throw new Error('Invalid subagent request: maxTurns');
    if (value > 0) maxTurns = value;
  }

  return {
    name: requireString(raw, 'name'),
    ...(optionalString(raw, 'previousName')
      ? { previousName: optionalString(raw, 'previousName') as string }
      : {}),
    description: requireString(raw, 'description'),
    tools: tools as string[],
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking as SubagentThinkingLevel } : {}),
    ...(permission && isSubagentPermission(permission) ? { permission } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    prompt: requireString(raw, 'prompt'),
  };
}

export function registerPiSubagentHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.PI_SUBAGENTS_LIST,
    async (): Promise<SubagentCatalogView> => service.read()
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_SUBAGENTS_SAVE,
    async (_event, payload: unknown): Promise<SubagentCatalogView> =>
      service.save(readSaveRequest(payload))
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_SUBAGENTS_DELETE,
    async (_event, payload: unknown): Promise<SubagentCatalogView> =>
      service.remove(requireString(asRecord(payload), 'name'))
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_SUBAGENTS_SET_ENABLED,
    async (_event, payload: unknown): Promise<SubagentCatalogView> => {
      const raw = asRecord(payload);
      if (typeof raw.enabled !== 'boolean') throw new Error('Invalid subagent request: enabled');
      return service.setEnabled(requireString(raw, 'name'), raw.enabled);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_SUBAGENTS_CLEAR_STALE,
    async (): Promise<SubagentCatalogView> => service.clearStaleDisabled()
  );

  /**
   * Show a definition in the OS file manager.
   *
   * With no name it opens the directory itself, which is the answer to "where
   * do I put one" — and the directory is created first, because revealing a
   * path that does not exist yet is how that button does nothing on a fresh
   * install.
   */
  ipcMain.handle(IPC_CHANNELS.PI_SUBAGENTS_REVEAL, async (_event, payload: unknown) => {
    const name = payload === undefined ? undefined : optionalString(asRecord(payload), 'name');
    const catalog = await service.read();
    if (!name) {
      await mkdir(catalog.directory, { recursive: true });
      const error = await shell.openPath(catalog.directory);
      if (error) throw new Error(`Failed to open the subagents folder: ${error}`);
      return;
    }
    const filePath =
      catalog.rows.find((row) => row.name === name)?.filePath ??
      catalog.broken.find((row) => row.name === name)?.filePath;
    if (!filePath) {
      throw new Error(`"${name}" ships with the app, so it has no file to show`);
    }
    shell.showItemInFolder(filePath);
  });
}
