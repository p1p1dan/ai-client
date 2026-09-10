/**
 * H/19 U2 — IPC for bringing `~/.pi/agent` over.
 *
 * The renderer is the untrusted side, so the request is validated here field by
 * field. An unknown item kind is REJECTED rather than ignored: a silently
 * dropped kind looks, from the settings page, exactly like a migration that ran
 * and found nothing.
 */

import {
  isMigrationItemKind,
  type MigrationItemKind,
  type MigrationPlan,
  type MigrationRequest,
  type MigrationResult,
} from '@shared/agentMigration';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { applyAgentMigration, inspectAgentMigration } from '../services/agentMigration';

function readRequest(payload: unknown): MigrationRequest {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid migration request');
  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.kinds) || raw.kinds.length === 0) {
    throw new Error('Invalid migration request: kinds');
  }
  const kinds: MigrationItemKind[] = [];
  for (const kind of raw.kinds) {
    if (!isMigrationItemKind(kind)) throw new Error('Invalid migration request: kinds');
    kinds.push(kind);
  }
  if (raw.onConflict !== 'skip' && raw.onConflict !== 'overwrite') {
    throw new Error('Invalid migration request: onConflict');
  }
  return { kinds, onConflict: raw.onConflict };
}

export function registerAgentMigrationHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.AGENT_MIGRATION_INSPECT,
    async (): Promise<MigrationPlan> => inspectAgentMigration()
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_MIGRATION_APPLY,
    (_event, payload: unknown): Promise<MigrationResult> =>
      applyAgentMigration(readRequest(payload))
  );
}
