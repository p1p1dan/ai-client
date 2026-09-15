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
 * Which permission system the built-in Pi terminal will run.
 *
 * Read from `<agentDir>/settings.json` with pi's OWN matching rules, not a
 * second copy of them. Only the global scope is read: project-scoped packages
 * are the repository's, they change per workspace, and in managed mode they are
 * ignored entirely.
 *
 * cutover-02: this used to be read as "which permission system approves this
 * app's tool calls", and the comment here claimed the worker called the same
 * function at bootstrap. Neither survived P6-5 — a chat is approved by
 * `src/runtime/plugins/permissions/` no matter what is installed, and no worker
 * calls this. What a user installs does still decide the TERMINAL, which runs
 * the real pi CLI out of this same directory, so that is what this answers now.
 *
 * `unknown` when the file cannot be read — not the same as `none`, and a page
 * that printed "no permission extension" for an unreadable file would be
 * stating something it did not check.
 *
 * Exported for its own test: everything else in this module needs a real pi CLI
 * on disk, and the answer this one gives is the sentence the plugins page
 * prints.
 */
export function terminalPermissionSystemOwner(agentDir: string): PermissionSystemOwner {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    const packages =
      parsed && typeof parsed === 'object'
        ? (parsed as { packages?: unknown }).packages
        : undefined;
    return permissionPluginConfiguredByUser(packages) ? 'user_configured' : 'none';
  } catch (error) {
    // A missing file is the ordinary first-run state: nothing is declared, so
    // the terminal loads no permission extension at all. Anything else is a
    // file we failed to read.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'none' : 'unknown';
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
      terminalPermissionSystem: terminalPermissionSystemOwner(getAppPiAgentDir()),
      ...(error ? { error } : {}),
    };
  });
}

/**
 * Install or remove, then drop the workers.
 *
 * cutover-02 / cutover-03: a chat loads none of these packages any more, so the
 * restart is no longer what makes an installed plugin usable. It is kept
 * because `<agentDir>/settings.json` is also read for other things at bootstrap
 * and a stale worker would answer the plugins page from a file that has since
 * changed; it costs one reload of an idle slot.
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
