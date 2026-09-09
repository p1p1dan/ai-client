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
      // the same binary could only repeat the failure with a worse message.
      tsdReadFallback: 'disabled',
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
    // Only claim a fallback when a real Node is present. Unpackaged dev shells
    // have no `resources/node-runtime`, and promising a helper we cannot spawn
    // would turn a clear "no fallback configured" into a spawn failure.
    tsdReadFallback: node ? 'configured-node' : 'disabled',
  };
}
