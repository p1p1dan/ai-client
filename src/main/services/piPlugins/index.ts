/**
 * H/19 U4 wiring — the `electron`-facing half of user-installed pi extensions.
 *
 * Serialised through one promise chain. `pi install` reaches the npm registry
 * (measured: about 8 seconds, and it can fail), and two of them running at once
 * would both read-modify-write the same `settings.json` — the last one to
 * finish would drop the other's package.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PermissionSystemOwner,
  PiPluginCommandResult,
  PiPluginState,
  PiPluginView,
} from '@shared/piPlugins';
import { permissionPluginConfiguredByUser } from '../../../agent-host/permissionPlugin';
import { currentPiCliLayout } from '../agent-host/piCliLayout';
import { workerManager } from '../agent-host/WorkerManager';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { getAppPiAgentDir } from '../piModelConfig';
import { resolvePiCliLaunchPlan } from '../terminal/PiTuiPty';
import { createPiCliRunner, PiPluginService } from './PiPluginService';

function service(): PiPluginService {
  const agentDir = getAppPiAgentDir();
  const launch = resolvePiCliLaunchPlan(currentPiCliLayout());
  return new PiPluginService({
    agentDir,
    runner: createPiCliRunner({
      nodePath: launch.nodePath,
      cliPath: launch.cliPath,
      env: launch.env,
      cwd: agentDir,
    }),
  });
}

/**
 * Which permission system the next session will run.
 *
 * Read from `<agentDir>/settings.json` with pi's OWN matching rules — the same
 * exported function the worker calls at bootstrap, not a second copy of the
 * logic. Only the global scope is read: project-scoped packages are the
 * repository's, they change per workspace, and in managed mode they are ignored
 * entirely.
 *
 * `unknown` when the file cannot be read. That is not the same as `bundled`,
 * and a page that printed "the app's own" for an unreadable file would be
 * stating something it did not check.
 */
function permissionSystemOwner(agentDir: string): PermissionSystemOwner {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    const packages =
      parsed && typeof parsed === 'object'
        ? (parsed as { packages?: unknown }).packages
        : undefined;
    return permissionPluginConfiguredByUser(packages) ? 'user_configured' : 'bundled';
  } catch (error) {
    // A missing file is the ordinary first-run state, and it means the bundled
    // copy is what loads. Anything else is a file we failed to read.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'bundled' : 'unknown';
  }
}

let chain: Promise<unknown> = Promise.resolve();

function serialise<T>(operation: () => Promise<T>): Promise<T> {
  const result = chain.then(operation, operation);
  chain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export function getPiPluginState(): Promise<PiPluginState> {
  return serialise(async () => {
    const instance = service();
    let plugins: PiPluginView[] = [];
    let error: string | undefined;
    try {
      plugins = await instance.list();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const managed = resolveManagedCredentialsEnabled();
    return {
      plugins,
      settingsPath: instance.settingsPath,
      projectScopeAvailable: !managed,
      permissionSystem: permissionSystemOwner(getAppPiAgentDir()),
      ...(error ? { error } : {}),
    };
  });
}

/**
 * Install or remove, then drop the workers.
 *
 * The extension list is read when a runtime is built, so a session that is
 * already up keeps running the old set. Replacing the workers is what makes an
 * installed plugin usable in the next turn instead of after a restart — the same
 * reason the opt-in bundled extensions do it in `ipc/piResources.ts`.
 */
export function installPiPlugin(source: string): Promise<PiPluginCommandResult> {
  return serialise(async () => {
    const result = await service().install(source);
    if (result.ok) await workerManager.invalidateAll();
    return result;
  });
}

export function removePiPlugin(source: string): Promise<PiPluginCommandResult> {
  return serialise(async () => {
    const result = await service().remove(source);
    if (result.ok) await workerManager.invalidateAll();
    return result;
  });
}

export function setPiPluginEnabled(source: string, enabled: boolean): Promise<void> {
  return serialise(async () => {
    service().setEnabled(source, enabled);
    await workerManager.invalidateAll();
  });
}

export { PiPluginService } from './PiPluginService';
