import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS, type VflowProjectInitializedEvent } from '@shared/types';
import { app, BrowserWindow } from 'electron';
import { killProcessTree } from '../../utils/processUtils';
import { getEnvForCommand } from '../../utils/shell';

const isWindows = process.platform === 'win32';

function spawnVflow(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: getEnvForCommand(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isWindows,
    });

    let stderr = '';
    const timeout = setTimeout(() => {
      killProcessTree(child);
      reject(new Error('vflow init timed out'));
    }, 30000);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `vflow init exited with code ${code}`));
      }
    });
  });
}

function getEmbeddedCliPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'vflow', 'cli.mjs');
  }
  return path.join(app.getAppPath(), 'resources', 'vflow', 'cli.mjs');
}

/**
 * Broadcast a "project initialized" event to every renderer window so the UI
 * can surface a toast. Fire-and-forget: we never block init on the broadcast.
 */
function broadcastProjectInitialized(cwd: string): void {
  const payload: VflowProjectInitializedEvent = { cwd };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    try {
      win.webContents.send(IPC_CHANNELS.VFLOW_PROJECT_INITIALIZED, payload);
    } catch (error) {
      // A renderer that's mid-teardown can throw; not worth interrupting init.
      console.warn('[vflow] Failed to broadcast project-initialized to a window:', error);
    }
  }
}

class VflowService {
  private readonly attemptedPaths = new Set<string>();

  async ensureInitialized(cwd: string): Promise<void> {
    const key = cwd.replace(/\\/g, '/').toLowerCase();
    if (this.attemptedPaths.has(key)) {
      return;
    }
    this.attemptedPaths.add(key);

    if (fs.existsSync(path.join(cwd, '.vflow'))) {
      return;
    }

    // Try globally installed vflow first, fall back to embedded copy
    try {
      await spawnVflow('vflow', ['init', '.', '--yes'], cwd);
      console.log('[vflow] Initialized (global):', cwd);
      broadcastProjectInitialized(cwd);
      return;
    } catch {
      // Global vflow unavailable, try embedded fallback
    }

    const embeddedCli = getEmbeddedCliPath();
    if (!fs.existsSync(embeddedCli)) {
      console.warn('[vflow] No global vflow and no embedded fallback found');
      return;
    }

    try {
      await spawnVflow(process.execPath, [embeddedCli, 'init', '.', '--yes'], cwd);
      console.log('[vflow] Initialized (embedded fallback):', cwd);
      broadcastProjectInitialized(cwd);
    } catch (error) {
      console.warn('[vflow] Init failed for', cwd, error);
    }
  }
}

export const vflowService = new VflowService();
