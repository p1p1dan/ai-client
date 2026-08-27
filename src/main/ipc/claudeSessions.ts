import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import {
  type ClaudeSessionRoot,
  ClaudeSessionScanner,
  resolveLegacyClaudeSessionRoot,
} from '../services/claude/ClaudeSessionScanner';

/**
 * D60 collapsed this back to a single root.
 *
 * It used to prepend a managed `<userData>/claude-home` root ahead of the
 * user's own, because managed mode had globally redirected
 * `CLAUDE_CONFIG_DIR` at that directory and sessions written under it would
 * otherwise be invisible. With the redirection gone there is only ever one
 * place Claude Code writes sessions, and `resolveLegacyClaudeSessionRoot()`
 * already resolves it correctly for both cases: `CLAUDE_CONFIG_DIR` when the
 * USER set it, `~/.claude` otherwise.
 *
 * Sessions recorded under an old managed home are not migrated. They were
 * only ever reachable while the flag was on, they are history rather than
 * state, and re-homing them would mean writing into a directory we are in the
 * middle of retiring.
 */
function resolveClaudeSessionRoots(): ClaudeSessionRoot[] {
  return [resolveLegacyClaudeSessionRoot()];
}

const scanner = new ClaudeSessionScanner({ resolveRoots: resolveClaudeSessionRoots });

export function registerClaudeSessionsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CLAUDE_SESSIONS_LIST_PROJECTS, async () => {
    return scanner.scanProjects();
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_SESSIONS_GET_PROJECT_SESSIONS, async (_event, projectId) => {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return [];
    }
    return scanner.getSessionsForProject(projectId);
  });
}
