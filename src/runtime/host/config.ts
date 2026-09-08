import { access, constants } from 'node:fs/promises';
import type { RuntimeHostConfig } from '../contracts.ts';
import { absolutePath, RuntimeHostError, timerMilliseconds } from './errors.ts';

export function standaloneHost(env: NodeJS.ProcessEnv = process.env): RuntimeHostConfig {
  if (process.versions.electron)
    throw new RuntimeHostError(
      'invalid_host_config',
      'Electron must supply an explicit host configuration'
    );
  return {
    carrier: 'standalone-node',
    node: { path: process.execPath, source: 'current-process' },
    tsdReadFallback: 'disabled',
    exec: { mode: 'pipe' },
    cleanupTimeoutMs: 2000,
    childEnv: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    ),
  };
}

export async function validateHost(config: RuntimeHostConfig): Promise<void> {
  timerMilliseconds(config.cleanupTimeoutMs, 'cleanupTimeoutMs');
  if (config.carrier === 'bundled-node' && config.node?.source !== 'bundled') {
    throw new RuntimeHostError(
      'invalid_host_config',
      'bundled-node requires the bundled Node executable'
    );
  }
  if (config.node?.source === 'current-process' && config.carrier !== 'standalone-node') {
    throw new RuntimeHostError(
      'invalid_host_config',
      'current-process Node is only valid for standalone execution'
    );
  }
  if (config.tsdReadFallback === 'configured-node' && !config.node) {
    throw new RuntimeHostError(
      'invalid_host_config',
      'TSD fallback requires an explicit Node executable'
    );
  }
  if (config.exec.mode === 'host-adapter' && !config.exec.adapter.id) {
    throw new RuntimeHostError('invalid_host_config', 'exec adapter requires a stable id');
  }
  if (config.node) {
    absolutePath(config.node.path);
    try {
      await access(config.node.path, constants.X_OK);
    } catch (error) {
      throw new RuntimeHostError(
        'invalid_host_config',
        `Node executable unavailable: ${config.node.path}`,
        { cause: error }
      );
    }
  }
}
