/**
 * H/19 U2 wiring — the `electron`-facing half of the agent-directory migration.
 *
 * Deliberately NOT a cached singleton: both directories are resolved lazily
 * (`app.setPath('userData')` runs after module evaluation — see
 * `appStatePaths.ts`), and the source directory can change under a developer
 * who sets `PI_CODING_AGENT_DIR`. Building the service per call costs nothing
 * and cannot serve a stale path.
 */

import type { MigrationPlan, MigrationRequest, MigrationResult } from '@shared/agentMigration';
import { getCredentialVault } from '../auth';
import {
  getAppPiAgentDir,
  getLocalPiAgentDir,
  writeUserProviderRuntimeConfig,
} from '../piModelConfig';
import { AgentDirMigrationService, type MigrationProviderStore } from './AgentDirMigrationService';

function providerStore(): MigrationProviderStore {
  const vault = getCredentialVault();
  return {
    list: () => {
      const read = vault.readUserProviders();
      // `absent` is an empty group, not a failed read. Only a genuinely
      // unreadable one answers `null`, which stops the import rather than
      // letting it write on top of services it could not see.
      if (read.status === 'ok') return read.providers;
      return read.status === 'absent' ? [] : null;
    },
    save: async (providers) => {
      const result = await vault.saveUserProviders(providers);
      if (!result.ok) throw new Error(`Could not save AI services: ${result.reason}`);
    },
  };
}

function service(): AgentDirMigrationService {
  return new AgentDirMigrationService({
    sourceDir: getLocalPiAgentDir(),
    targetDir: getAppPiAgentDir(),
    providers: providerStore(),
  });
}

export function inspectAgentMigration(): MigrationPlan {
  return service().inspect();
}

export async function applyAgentMigration(request: MigrationRequest): Promise<MigrationResult> {
  const result = await service().apply(request);
  // Imported services only reach pi through the derived `models.json` /
  // `auth.json`. Rewriting them here — rather than leaving it to the next
  // settings edit — is what makes an imported provider appear in the model
  // picker without a restart.
  if (request.kinds.includes('providers')) writeUserProviderRuntimeConfig();
  return result;
}

export { AgentDirMigrationService } from './AgentDirMigrationService';
