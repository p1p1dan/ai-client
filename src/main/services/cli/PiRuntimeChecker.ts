/**
 * Is the chat engine this build runs on present? (`pi:runtime:check`, and the
 * auth gate's `runtime-unavailable` shell.)
 *
 * dsh-rebase P1-12 step 1 (decision 147): the engine is the DSH host, so
 * "ready" means the files `DshHostSupervisor` would spawn are on disk — the
 * bundled Node and `dsh-host/host.js` when packaged, `out-node-runtime/node`
 * (or `AICLIENT_DSH_NODE`) and `src/dsh-host/host.ts` when not. It is the same
 * `resolveDshHostLayout` the launch uses, so the two cannot disagree. The
 * native worker artifact (`resources/agent-host`) is no longer shipped and is
 * not consulted.
 */

import type { PiRuntimeStatus } from '@shared/types/piRuntime';
import { app } from 'electron';
import {
  DSH_HOST_MISSING,
  type DshHostLayoutInput,
  resolveDshHostLayout,
} from '../agent-host/DshHostProcess';

/** `workerVersion` of a ready status: the engine, not a build number. */
export const DSH_RUNTIME_VERSION = 'dsh-host';

function currentLayoutInput(): DshHostLayoutInput {
  return {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  };
}

function isHostMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DSH_HOST_MISSING
  );
}

export class PiRuntimeChecker {
  private cached: PiRuntimeStatus | null = null;

  constructor(private readonly layoutInput: () => DshHostLayoutInput = currentLayoutInput) {}

  async detect(force = false): Promise<PiRuntimeStatus> {
    if (!force && this.cached) return this.cached;
    try {
      resolveDshHostLayout(this.layoutInput());
      this.cached = { kind: 'ready', workerVersion: DSH_RUNTIME_VERSION };
    } catch (error) {
      // Anything but "a file is missing" is a detection failure the IPC
      // handler reports as such, not a verdict about the install.
      if (!isHostMissing(error)) throw error;
      this.cached = { kind: 'unavailable' };
    }
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }

  getCached(): PiRuntimeStatus | null {
    return this.cached;
  }
}

export const piRuntimeChecker = new PiRuntimeChecker();
