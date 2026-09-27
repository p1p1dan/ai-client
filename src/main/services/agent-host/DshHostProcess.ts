/**
 * The DSH host process behind one chat WorkerSlot (dsh-rebase P1-1).
 *
 * Every chat session runs on the DeepSeek Harness host, packaged or not
 * (decisions 004 and 009): there is no engine switch and no native fallback.
 * The host (`src/dsh-host/host.ts`, built to `host.js` for packaging by P1-2)
 * runs on the bundled Node with an IPC channel and serves the worker RPC
 * through its `aiclient-bridge` row, so Main's WorkerSlot talks to it exactly
 * as it talked to the native worker. One-shot completions and conversation
 * imports keep the native worker (`PiWorkerProcess.ts`) until P1-12.
 *
 * Three pieces are separate functions because P1-3 keeps them when it replaces
 * the one-process-per-slot `forkDshHost` with a shared host: the layout (which
 * binary runs which entry), the home (decision 008), and the environment.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PI_WORKER_GENERATION_ENV } from '@shared/types/workerRpc';
import { app } from 'electron';
import { getAppStateRoot } from '../appStatePaths';
import { createNodeProcessWorkerTransport, type WorkerTransport } from './WorkerTransport';

/** Thrown when the bundled Node or the host entry is not on disk; never falls back. */
export const DSH_HOST_MISSING = 'DSH_HOST_MISSING';

/** `DSH_HOME` under the app state root: `~/.pilab/<profile>/dsh-home` (decision 008). */
export const DSH_HOME_DIR_NAME = 'dsh-home';

/**
 * Where the host lives. Unpackaged paths are relative to the app path, packaged
 * ones to `process.resourcesPath`. P1-2 delivers the packaged artifacts; if it
 * settles on a different layout, these constants are the one place to change.
 */
export const DSH_HOST_LAYOUT = {
  unpackaged: { nodeDir: 'out-node-runtime', entry: ['src', 'dsh-host', 'host.ts'] },
  packaged: { nodeDir: 'node-runtime', entry: ['dsh-host', 'host.js'] },
} as const;

/** Flags the host needs: its module resolution patches Node internals (see host.ts). */
export const DSH_HOST_NODE_ARGS = ['--expose-internals'] as const;

/**
 * Variables the host inherits from Main; everything else stays behind. XDG,
 * DBus and `.env` isolation are P1-3's environment policy.
 */
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
];

/**
 * Where the dev gateway route points and the key it sends (the bundle's
 * llm-pi-ai row); absent means the discard port. Unpackaged only, and removed
 * by P1-5 when routing moves to the real credential path.
 */
const DEV_GATEWAY_ENV = ['AICLIENT_DSH_GATEWAY_URL', 'AICLIENT_DSH_GATEWAY_KEY'];

function missing(what: string, file: string): Error {
  return Object.assign(new Error(`${DSH_HOST_MISSING}: the DSH host ${what} is missing: ${file}`), {
    code: DSH_HOST_MISSING,
  });
}

export interface DshHostLayoutInput {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
}

export interface DshHostLayout {
  node: string;
  entry: string;
}

/**
 * The Node binary and host entry this build runs. `AICLIENT_DSH_NODE` is read
 * only when unpackaged. Nothing falls back to a `node` on PATH: on an encrypted
 * host only the bundled carrier may read files and run tools (ARD D11), so a
 * missing carrier must fail loudly rather than quietly read ciphertext.
 */
export function resolveDshHostLayout(input: DshHostLayoutInput): DshHostLayout {
  const env = input.env ?? process.env;
  const exists = input.exists ?? existsSync;
  const nodeName = (input.platform ?? process.platform) === 'win32' ? 'node.exe' : 'node';
  const layout = input.isPackaged ? DSH_HOST_LAYOUT.packaged : DSH_HOST_LAYOUT.unpackaged;
  const root = input.isPackaged ? input.resourcesPath : input.appPath;
  const override = input.isPackaged ? undefined : env.AICLIENT_DSH_NODE?.trim();
  const node = override || path.join(root, layout.nodeDir, nodeName);
  const entry = path.join(root, ...layout.entry);
  if (!exists(node)) throw missing('Node runtime', node);
  if (!exists(entry)) throw missing('entry', entry);
  return { node, entry };
}

/** `DSH_HOME`: app-private, never `~/.dsh`; `AICLIENT_DSH_HOME` only when unpackaged. */
export function resolveDshHome(input: {
  isPackaged: boolean;
  appStateRoot: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const override = input.isPackaged ? undefined : (input.env ?? process.env).AICLIENT_DSH_HOME;
  return override?.trim() || path.join(input.appStateRoot, DSH_HOME_DIR_NAME);
}

/** The host's whole environment: an allowlist, never a copy of Main's. */
export function buildDshHostEnvironment(input: {
  generation: number;
  dshHome: string;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
    throw new Error(`DSH host generation must be a positive safe integer: ${input.generation}`);
  }
  const env = input.env ?? process.env;
  const inherited = input.isPackaged ? INHERITED_ENV : [...INHERITED_ENV, ...DEV_GATEWAY_ENV];
  const hostEnv: Record<string, string> = {};
  for (const key of inherited) {
    const value = env[key];
    if (value !== undefined) hostEnv[key] = value;
  }
  Object.assign(hostEnv, {
    DSH_HOME: input.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_DSH_BRIDGE: '1',
    [PI_WORKER_GENERATION_ENV]: String(input.generation),
  });
  return hostEnv;
}

export interface DshHostLaunch {
  command: string;
  args: string[];
  /** App-private: the host reads `.env` from its launch directory and hands it to tools (P0-2). */
  cwd: string;
  env: Record<string, string>;
}

export function buildDshHostLaunch(
  input: DshHostLayoutInput & { generation: number; appStateRoot: string }
): DshHostLaunch {
  const layout = resolveDshHostLayout(input);
  const dshHome = resolveDshHome(input);
  return {
    command: layout.node,
    args: [...DSH_HOST_NODE_ARGS, layout.entry],
    cwd: dshHome,
    env: buildDshHostEnvironment({
      generation: input.generation,
      dshHome,
      isPackaged: input.isPackaged,
      env: input.env,
    }),
  };
}

/** Spawn the DSH host for one WorkerSlot generation of the session running in `cwd`. */
export function forkDshHost(options: { generation: number; cwd: string }): {
  process: ChildProcess;
  transport: WorkerTransport;
} {
  // Same check as the native worker: a spawn into a vanished directory fails
  // with ENOENT naming the command, which reads as "node is missing".
  if (!existsSync(options.cwd)) {
    throw new Error(
      `WORKER_WORKSPACE_MISSING: DSH session working directory is missing: ${options.cwd}`
    );
  }
  const launch = buildDshHostLaunch({
    generation: options.generation,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    appStateRoot: getAppStateRoot(),
  });
  mkdirSync(launch.cwd, { recursive: true, mode: 0o700 });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  return { process: child, transport: createNodeProcessWorkerTransport(child) };
}
