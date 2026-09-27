// Thin wrapper (dsh-rebase P1-6a): the loader and matcher live in src/shared/permissions/policy.ts.
import {
  loadPermissionPolicy as loadSharedPermissionPolicy,
  type RuntimePermissionPolicy,
} from '../../../shared/permissions/policy.ts';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';
import { resolveSettingSources, type SettingSource } from '../../settingSources.ts';

export { policyAction, type RuntimePermissionPolicy } from '../../../shared/permissions/policy.ts';

/**
 * decision 008 — the bundled policy, then the on-disk layers `settingSources`
 * and project trust allow, read through the runtime's HostIo. See the shared
 * loader for the merge order.
 */
export async function loadPermissionPolicy(
  io: RuntimeHostIoService,
  options: {
    cwd: string;
    agentDir?: string | null;
    projectTrusted?: boolean;
    settingSources?: readonly SettingSource[];
  }
): Promise<RuntimePermissionPolicy> {
  return loadSharedPermissionPolicy(io, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sources: resolveSettingSources(options),
    createError: (code, message, errorOptions) => new RuntimeHostError(code, message, errorOptions),
  });
}
