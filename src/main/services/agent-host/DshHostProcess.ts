/**
 * How the DSH host process is launched (dsh-rebase P1-1, P1-3).
 *
 * Every chat session runs on the DeepSeek Harness host, packaged or not
 * (decisions 004 and 009): there is no engine switch and no native fallback.
 * The host (`src/dsh-host/host.ts`, built to `host.js` for packaging by P1-2)
 * runs on the bundled Node with an IPC channel, one per app, spawned and
 * owned by `DshHostSupervisor` (decision 019). One-shot completions and
 * conversation imports keep the native worker (`PiWorkerProcess.ts`) until
 * P1-12.
 *
 * The pieces are separate functions so each can be pinned on its own: the
 * layout (which binary runs which entry), the home (decision 008), the
 * environment (decision 022, `dshHostEnvironment.ts`), the launch directory
 * (decision 023) and the private directories the launch needs.
 */

import type { SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getAppStateRoot } from '../appStatePaths';
import { buildDshHostEnvironment } from './dshHostEnvironment';

export {
  buildDshHostEnvironment,
  DSH_SENSITIVE_ENV_PATTERN,
  isStrippedDshHostEnvName,
} from './dshHostEnvironment';

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
  input: DshHostLayoutInput & { appStateRoot: string }
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
    }),
    privateDirs: [dshHome, cwd, nativeCacheDir],
  };
}

/** The launch for this running app. */
export function currentDshHostLaunch(): DshHostLaunch {
  return buildDshHostLaunch({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    appStateRoot: getAppStateRoot(),
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
