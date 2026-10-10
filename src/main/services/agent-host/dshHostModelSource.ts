/**
 * Main's wiring of the shared DSH host to the model plan and the keys
 * (dsh-rebase P1-5; decisions 033, 034).
 *
 *   plan     every host spawns with `resolveDshModelPlan()` as of that moment
 *            (the `configure` message), built from the same in-memory catalog
 *            the model menu is built from;
 *   keys     the host asks per request; `DshCredentialBroker` answers from the
 *            same catalog's `auth` half, cached until the vault changes or a
 *            new plan is built;
 *   drift    every plan Main builds is compared with the one the running host
 *            was spawned with; a different revision restarts the host once no
 *            session is working (`WorkerManager.reconcileModelPlan`).
 *
 * Installed once at startup (`registerIpcHandlers`), before any host starts.
 */

import { app } from 'electron';
import { onRendererSettingsWrite } from '../../ipc/settings';
import { getCredentialVault } from '../auth';
import {
  onDshModelPlanBuilt,
  resolveDshModelPlan,
  resolveNativeModelCatalog,
} from '../piModelConfig';
import { watchCacheControlOnTools } from './cacheControlOnToolsSetting';
import { DshCredentialBroker } from './DshCredentialBroker';
import { dshHostSupervisor } from './DshHostSupervisor';
import { watchRequestUserAgent } from './requestUserAgentSetting';
import { workerManager } from './WorkerManager';

let installed = false;

export function installDshHostModelSource(): void {
  if (installed) return;
  installed = true;
  const broker = new DshCredentialBroker({
    readAuth: () => resolveNativeModelCatalog()?.auth,
    onVaultChange: (listener) => getCredentialVault().onChange(() => listener()),
    log: (...args) => console.info(...args),
  });
  dshHostSupervisor.setModelSource({ plan: () => resolveDshModelPlan(), credentials: broker });
  onDshModelPlanBuilt((plan) => {
    // A new plan may name other keys (a sync replaced the administrator key).
    broker.invalidate();
    workerManager.reconcileModelPlan(plan.revision);
  });
  // GW-16 temporary switch (decision 159): a flip rebuilds the plan at once.
  watchCacheControlOnTools({
    onSettingsWrite: onRendererSettingsWrite,
    rebuild: () => resolveDshModelPlan(),
    log: (...args) => console.info(...args),
  });
  // Decision 171: a different User-Agent rebuilds the plan at once as well.
  watchRequestUserAgent({
    onSettingsWrite: onRendererSettingsWrite,
    rebuild: () => resolveDshModelPlan(),
    appVersion: () => app.getVersion(),
    log: (...args) => console.info(...args),
  });
}
