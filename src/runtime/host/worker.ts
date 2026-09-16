import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeHostConfig, WorkerCarrier } from '../contracts.ts';
import { RuntimeHostError } from './errors.ts';

/**
 * Host configuration for the two PRODUCT carriers (ARD D11).
 *
 * `standaloneHost` deliberately refuses to run under Electron and infers its
 * own carrier; that is right for the smoke runner and wrong for a real slot,
 * where Main decides the carrier by platform and packaging. This builder is the
 * counterpart: the worker entry states which carrier it is, and everything a
 * carrier implies — which Node the TSD fallback may spawn, whether there is a
 * fallback at all — is derived here rather than at each call site.
 *
 * The runtime below this point stays carrier-agnostic (D11 item 3): plugins see
 * a `RuntimeHostConfig`, never `process.parentPort` or `process.send`.
 */

export interface WorkerHostInput {
  carrier: WorkerCarrier;
  env?: NodeJS.ProcessEnv;
  /** This process's own binary. Under `bundled-node` it IS the bundled Node. */
  execPath?: string;
  /** Electron's `process.resourcesPath`; absent outside a packaged shell. */
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  cleanupTimeoutMs?: number;
}

/**
 * Field switch for the TSD read fallback — engineering standard §6, a new
 * capability behind a flag (tsd-01).
 *
 * D11 left the fallback with no factory trigger: the only carrier that ever
 * meets ciphertext is `bundled-node` on packaged Windows, which turns it off by
 * design, while the carriers that enable it run where no encryption driver
 * exists. So `source: 'node-fallback'` never happened in a shipped build, and
 * the encrypted box had no product operation that could exercise the helper.
 *
 * Set this to `1` / `on` / `true` and the fallback is enabled for the Node the
 * carrier already has — no second binary, no rebuild, nothing to edit in the
 * package. Off by default because re-spawning the same whitelisted binary
 * normally just repeats the same read; it earns its keep when the driver has
 * stopped whitelisting us (where the re-spawn may land differently) and on the
 * field trip that has to prove the helper contract end to end.
 */
export const RUNTIME_TSD_FALLBACK_ENV = 'AICLIENT_RUNTIME_TSD_FALLBACK';
function fallbackRequested(env: NodeJS.ProcessEnv): boolean {
  const value = env[RUNTIME_TSD_FALLBACK_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'on' || value === 'true';
}

/** Where `pnpm fetch:node-runtime` puts the Node we ship. */
export function bundledNodePath(resourcesPath: string, platform: NodeJS.Platform): string {
  return join(resourcesPath, 'node-runtime', platform === 'win32' ? 'node.exe' : 'node');
}

export function workerHost(input: WorkerHostInput): RuntimeHostConfig {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const base = {
    exec: { mode: 'pipe' } as const,
    cleanupTimeoutMs: input.cleanupTimeoutMs ?? 2000,
    childEnv,
  };

  if (input.carrier === 'bundled-node') {
    const execPath = input.execPath ?? process.execPath;
    if (!execPath) {
      throw new RuntimeHostError(
        'invalid_host_config',
        'bundled-node carrier requires this process to know its own executable'
      );
    }
    return {
      ...base,
      carrier: 'bundled-node',
      // D11: Main spawned us AS the bundled node.exe, so our own binary is it.
      // Resolving it a second time from resourcesPath would let a stale copy on
      // disk disagree with the process actually running.
      node: { path: execPath, source: 'bundled' },
      // This carrier exists precisely because the security driver whitelists
      // this binary: it already reads plaintext, so a fallback that re-spawns
      // the same binary would normally only repeat the failure with a worse
      // message. The switch is for when that premise breaks — the driver no
      // longer lets us through, or the field has to run the helper once to
      // prove its contract.
      tsdReadFallback: fallbackRequested(env) ? 'configured-node' : 'disabled',
    };
  }

  // electron-utility. `process.execPath` here is the Electron binary — the one
  // D11 found reads ciphertext — so it must never be offered as the TSD helper.
  const bundled = input.resourcesPath ? bundledNodePath(input.resourcesPath, platform) : undefined;
  const node =
    bundled && existsSync(bundled) ? { path: bundled, source: 'bundled' as const } : undefined;
  return {
    ...base,
    carrier: 'electron-utility',
    ...(node ? { node } : {}),
    // Only claim a fallback when a real Node is present — here the switch
    // cannot help either. Unpackaged dev shells have no
    // `resources/node-runtime`, and promising a helper we cannot spawn would
    // turn a clear "no fallback configured" into a spawn failure.
    tsdReadFallback: node ? 'configured-node' : 'disabled',
  };
}
