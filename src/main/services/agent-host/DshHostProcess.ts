/**
 * How the DSH host process is launched (dsh-rebase P1-1, P1-3).
 *
 * Every chat session runs on the DeepSeek Harness host, packaged or not
 * (decisions 004 and 009): there is no engine switch and no native fallback.
 * The host (`src/dsh-host/host.ts`, built to `host.js` for packaging by P1-2)
 * runs on the bundled Node with an IPC channel. One-shot completions and
 * conversation imports keep the native worker (`PiWorkerProcess.ts`) until
 * P1-12.
 *
 * The pieces are separate functions because two launchers share them: the
 * per-slot `forkDshHost` below (one host per WorkerSlot, still the default
 * until P1-3a) and `DshHostSupervisor` (one shared host per app, decision
 * 019). They are the layout (which binary runs which entry), the home
 * (decision 008), the environment (decision 022), the launch directory
 * (decision 023) and the private directories the launch needs.
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
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
 * The host's launch directory: private and empty, never `DSH_HOME` or a
 * workspace (decision 023). Relative PATH entries, the profile context and the
 * sandbox fallback all resolve against it.
 */
export const DSH_HOST_CWD_DIR_NAME = 'dsh-host-cwd';

/** Where the native-addon loader copies `.node` binaries before loading them (P1-2 D2). */
export const DSH_NATIVE_CACHE_DIR_NAME = 'dsh-native-cache';

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
 * Credential-shaped names, the same rule DSH applies to every tool it spawns
 * (`SENSITIVE_ENV_PATTERN` in @deepseek-ai/dsh-subprocess). Dropping them from
 * the host too closes pi-ai's fallback of looking up a provider key in the
 * launch environment. A static test pins it to the installed DSH package.
 */
export const DSH_SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

/** Runtime injection: `--require` hooks, debug ports, module resolution outside the host. */
const STRIPPED_ENV_NAMES = ['NODE_OPTIONS', 'NODE_PATH'];

/**
 * Electron's switches and the app's own: anything the host needs from these
 * families is set explicitly below. Matched case-insensitively, as DSH matches
 * `DSH_*`: Windows names are case-insensitive.
 */
const STRIPPED_ENV_PREFIXES = ['ELECTRON_', 'AICLIENT_', 'DSH_', 'VITE_'];

/**
 * Package-manager lifecycle variables from a `pnpm dev` launch. Lower-case by
 * npm's convention, so a user's own `NPM_CONFIG_*` keeps reaching tools.
 */
const STRIPPED_LIFECYCLE_PREFIX = 'npm_';

/**
 * Where the dev gateway route points and the key it sends (the bundle's
 * llm-pi-ai row); absent means the discard port. The key is credential-shaped,
 * so it is added back explicitly. Unpackaged only; removed by P1-5 when routing
 * moves to the real credential path.
 */
const DEV_GATEWAY_ENV = ['AICLIENT_DSH_GATEWAY_URL', 'AICLIENT_DSH_GATEWAY_KEY'];

/** Owner-only: DSH refuses group-writable roots (spill-local), and the tree holds session logs. */
const PRIVATE_DIR_MODE = 0o700;

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

/** Whether an inherited variable stays behind (decision 022). */
export function isStrippedDshHostEnvName(name: string): boolean {
  if (DSH_SENSITIVE_ENV_PATTERN.test(name)) return true;
  const upper = name.toUpperCase();
  if (STRIPPED_ENV_NAMES.includes(upper)) return true;
  if (STRIPPED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return name.startsWith(STRIPPED_LIFECYCLE_PREFIX);
}

/** Set `name`, first dropping any spelling Windows would treat as the same variable. */
function setEnvEntry(
  env: Record<string, string>,
  name: string,
  value: string,
  platform: NodeJS.Platform
): void {
  if (platform === 'win32') {
    const upper = name.toUpperCase();
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === upper) delete env[existing];
    }
  }
  env[name] = value;
}

/**
 * The host's whole environment (decision 022): Main's, minus runtime
 * injection, Electron and app-internal switches, and credential-shaped names;
 * plus the explicit settings below. It is also the base of every tool the host
 * spawns, so it keeps what 1.0.x tools saw (`SSH_AUTH_SOCK`, `JAVA_HOME`,
 * proxies, `XDG_RUNTIME_DIR` and DBus for systemd containment).
 *
 * `bridgeGeneration` is the per-slot bridge mode of `forkDshHost`; the shared
 * host carries the generation in each channel's messages instead. P1-3a
 * removes it together with `forkDshHost`.
 */
export function buildDshHostEnvironment(input: {
  dshHome: string;
  nativeCacheDir: string;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  bridgeGeneration?: number;
}): Record<string, string> {
  const source = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const hostEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isStrippedDshHostEnvName(name)) hostEnv[name] = value;
  }
  const explicit: Record<string, string> = {
    DSH_HOME: input.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    NARB_NATIVE_CACHE_DIR: input.nativeCacheDir,
  };
  if (!input.isPackaged) {
    for (const name of DEV_GATEWAY_ENV) {
      const value = source[name];
      if (value !== undefined) explicit[name] = value;
    }
  }
  if (input.bridgeGeneration !== undefined) {
    const generation = input.bridgeGeneration;
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error(`DSH host generation must be a positive safe integer: ${generation}`);
    }
    explicit.AICLIENT_DSH_BRIDGE = '1';
    explicit[PI_WORKER_GENERATION_ENV] = String(generation);
  }
  for (const [name, value] of Object.entries(explicit)) {
    setEnvEntry(hostEnv, name, value, platform);
  }
  return hostEnv;
}

export interface DshHostLaunch {
  command: string;
  args: string[];
  /** Private and empty (decision 023): the host would read `.env` from here (P0-2). */
  cwd: string;
  env: Record<string, string>;
  /** Created and tightened to 0700 before every spawn: DSH_HOME, the cwd, the native cache. */
  privateDirs: string[];
}

export function buildDshHostLaunch(
  input: DshHostLayoutInput & { appStateRoot: string; bridgeGeneration?: number }
): DshHostLaunch {
  const layout = resolveDshHostLayout(input);
  const dshHome = resolveDshHome(input);
  const cwd = path.join(input.appStateRoot, DSH_HOST_CWD_DIR_NAME);
  const nativeCacheDir = path.join(input.appStateRoot, DSH_NATIVE_CACHE_DIR_NAME);
  return {
    command: layout.node,
    args: [...DSH_HOST_NODE_ARGS, layout.entry],
    cwd,
    env: buildDshHostEnvironment({
      dshHome,
      nativeCacheDir,
      isPackaged: input.isPackaged,
      env: input.env,
      platform: input.platform,
      bridgeGeneration: input.bridgeGeneration,
    }),
    privateDirs: [dshHome, cwd, nativeCacheDir],
  };
}

/** The launch for this running app. */
export function currentDshHostLaunch(options: { bridgeGeneration?: number } = {}): DshHostLaunch {
  return buildDshHostLaunch({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    appStateRoot: getAppStateRoot(),
    bridgeGeneration: options.bridgeGeneration,
  });
}

/**
 * Create `dir` owner-only, and tighten it when it already exists: `mkdirSync`'s
 * mode applies only to directories it creates (P1-1 evidence), so a home left
 * group-readable by an earlier build or a lax umask would otherwise stay so.
 */
export function ensurePrivateDirectory(
  dir: string,
  platform: NodeJS.Platform = process.platform
): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // Windows has no POSIX mode bits; chmod would only toggle the read-only flag.
  if (platform !== 'win32') chmodSync(dir, PRIVATE_DIR_MODE);
}

export function prepareDshHostDirectories(launch: DshHostLaunch): void {
  for (const dir of launch.privateDirs) ensurePrivateDirectory(dir);
}

/**
 * Spawn options for the host: stdio `ignore, pipe, pipe, ipc`, no console
 * window, and deliberately not `detached`, so the host stays in Main's process
 * group and is only ever signalled through its own ChildProcess handle.
 */
export function dshHostSpawnOptions(launch: DshHostLaunch): SpawnOptions {
  return {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
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
  const launch = currentDshHostLaunch({ bridgeGeneration: options.generation });
  prepareDshHostDirectories(launch);
  const child = spawn(launch.command, launch.args, dshHostSpawnOptions(launch));
  return { process: child, transport: createNodeProcessWorkerTransport(child) };
}
