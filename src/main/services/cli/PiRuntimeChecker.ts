import { existsSync } from 'node:fs';
import type { PiRuntimeStatus } from '@shared/types/piRuntime';
import { resolveCurrentPiWorkerEntryPath } from '../agent-host/PiWorkerProcess';

export class PiRuntimeChecker {
  private cached: PiRuntimeStatus | null = null;

  async detect(force = false): Promise<PiRuntimeStatus> {
    if (!force && this.cached) return this.cached;
    this.cached = existsSync(resolveCurrentPiWorkerEntryPath())
      ? { kind: 'ready', workerVersion: 'pi-worker' }
      : { kind: 'unavailable' };
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
