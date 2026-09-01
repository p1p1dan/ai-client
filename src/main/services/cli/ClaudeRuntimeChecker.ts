import { existsSync } from 'node:fs';
import type { ClaudeRuntimeStatus } from '@shared/types';
import { resolveCurrentPiWorkerEntryPath } from '../agent-host/PiWorkerProcess';

export type { ClaudeRuntimeKind, ClaudeRuntimeStatus, VsCodeExtensionInfo } from '@shared/types';
export { LAST_NODE_CLAUDE_VERSION } from '@shared/types';
export { compareSemver } from './ClaudeVersion';

/**
 * Transition compatibility for the existing onboarding gate.
 *
 * The DTO/channel keeps its historical name until T35 removes the remaining
 * renderer vocabulary, but the only runtime checked is the actual Pi worker
 * entry. A global Claude CLI or VS Code extension can never satisfy this gate.
 */
export class ClaudeRuntimeChecker {
  private cached: ClaudeRuntimeStatus | null = null;

  async detect(force = false): Promise<ClaudeRuntimeStatus> {
    if (!force && this.cached) return this.cached;
    this.cached = existsSync(resolveCurrentPiWorkerEntryPath())
      ? { kind: 'installed', cliVersion: 'pi-worker' }
      : { kind: 'not-installed' };
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }

  getCached(): ClaudeRuntimeStatus | null {
    return this.cached;
  }
}

export const claudeRuntimeChecker = new ClaudeRuntimeChecker();
