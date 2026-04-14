import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { ClaudeSessionScanner } from '../services/claude/ClaudeSessionScanner';

const scanner = new ClaudeSessionScanner();

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
