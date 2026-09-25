/**
 * DEV-ONLY engine switch (dsh-rebase plan, P0-3): run a chat session's worker
 * slot on the DeepSeek Harness host instead of the native worker.
 *
 * On only when BOTH hold: `AICLIENT_DEV_ENGINE=dsh` in Main's environment, and
 * the app is unpackaged. Anything else — unset, another value, a packaged
 * build, or an `app` that cannot be read — keeps the native worker, so with
 * the switch unset nothing on the session path differs from before.
 *
 * The DSH host (`src/dsh-host/host.ts`, a separate npm subpackage) is spawned
 * on plain Node with an IPC channel, like the packaged Windows worker, and
 * serves the same worker RPC through its `aiclient-bridge` row. Only chat
 * sessions come here (`createPiWorkerSlot`); one-shot completions and imports
 * keep the native worker.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PI_WORKER_GENERATION_ENV } from '@shared/types/workerRpc';
import { app } from 'electron';
import { createNodeProcessWorkerTransport, type WorkerTransport } from './WorkerTransport';

export const DEV_ENGINE_ENV = 'AICLIENT_DEV_ENGINE';

/** Variables the host inherits from Main; everything else is left behind. */
const INHERITED_ENV = [
  'PATH',
  'Path',
  'LANG',
  'LC_ALL',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'windir',
  'ComSpec',
  // Where the dev gateway route points and the key it sends (see the bundle's
  // llm-pi-ai row); absent means the discard port.
  'AICLIENT_DSH_GATEWAY_URL',
  'AICLIENT_DSH_GATEWAY_KEY',
];

export function isDevDshEngineSelected(
  env: NodeJS.ProcessEnv = process.env,
  isPackaged: boolean = app?.isPackaged ?? true
): boolean {
  return !isPackaged && env[DEV_ENGINE_ENV] === 'dsh';
}

export interface DevDshHostLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function buildDevDshHostLaunch(input: {
  generation: number;
  appPath: string;
  userDataPath: string;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
}): DevDshHostLaunch {
  const env = input.env ?? process.env;
  const exists = input.exists ?? existsSync;
  const bundledNode = path.join(
    input.appPath,
    'out-node-runtime',
    process.platform === 'win32' ? 'node.exe' : 'node'
  );
  const command = env.AICLIENT_DSH_NODE || (exists(bundledNode) ? bundledNode : 'node');
  // App-private, never a user workspace: the host reads `.env` from its own
  // launch directory and hands those variables to tools (P0-2 finding).
  const dshHome = env.AICLIENT_DSH_HOME || path.join(input.userDataPath, 'dsh-home-dev');
  const hostEnv: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = env[key];
    if (value !== undefined) hostEnv[key] = value;
  }
  Object.assign(hostEnv, {
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_DSH_BRIDGE: '1',
    [PI_WORKER_GENERATION_ENV]: String(input.generation),
  });
  return {
    command,
    args: ['--expose-internals', path.join(input.appPath, 'src', 'dsh-host', 'host.ts')],
    cwd: dshHome,
    env: hostEnv,
  };
}

/** Spawn the DSH host for one WorkerSlot generation. */
export function forkDevDshHost(options: { generation: number }): {
  process: ChildProcess;
  transport: WorkerTransport;
} {
  const launch = buildDevDshHostLaunch({
    generation: options.generation,
    appPath: app.getAppPath(),
    userDataPath: app.getPath('userData'),
  });
  mkdirSync(launch.cwd, { recursive: true });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  return { process: child, transport: createNodeProcessWorkerTransport(child) };
}
