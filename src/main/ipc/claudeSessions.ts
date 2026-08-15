import * as os from 'node:os';
import * as path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { app, ipcMain } from 'electron';
import { resolveManagedCredentialsEnabled } from '../services/auth/AuthStateService';
import { getManagedClaudeHomeDir } from '../services/auth/claudeHome';
import {
  type ClaudeSessionRoot,
  ClaudeSessionScanner,
  resolveLegacyClaudeSessionRoot,
} from '../services/claude/ClaudeSessionScanner';

/**
 * Lazy dual-root resolver (D47 S2b §1 Scanner): flag-off returns the
 * pre-refactor single legacy root unchanged. Flag-on prepends the managed
 * `<userData>/claude-home` root ahead of literal `~/.claude` — NOT
 * `resolveLegacyClaudeSessionRoot()`, because when the flag is on
 * `CLAUDE_CONFIG_DIR` itself has been globally redirected to the managed
 * home by `main/index.ts`'s two-phase startup, so re-reading it here would
 * just point back at the managed root and silently drop the legacy one.
 * Invoked fresh on every call — never captured at module-load time — so the
 * module-level singleton below stays correct regardless of when the flag
 * settles relative to import order (ESM hoisting, D47 S2 §0.1).
 */
function resolveClaudeSessionRoots(): ClaudeSessionRoot[] {
  if (!resolveManagedCredentialsEnabled()) {
    return [resolveLegacyClaudeSessionRoot()];
  }
  const managed: ClaudeSessionRoot = {
    dir: getManagedClaudeHomeDir(app.getPath('userData')),
    kind: 'managed',
  };
  const legacy: ClaudeSessionRoot = { dir: path.join(os.homedir(), '.claude'), kind: 'legacy' };
  return [managed, legacy];
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
