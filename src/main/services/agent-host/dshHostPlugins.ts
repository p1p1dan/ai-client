/**
 * Main's entry to the shared host's DSH plugins (dsh-rebase P1-10b;
 * decisions 025 rule 2, 059 rule 4, 108 and 110). The settings page and its
 * IPC (P1-10c) sit on these three calls and nothing else:
 *
 *   getDshPluginSelection  the overrides the user has chosen by hand, or
 *                          `undefined` (nobody has touched anything: every
 *                          plugin follows the allowlist's `defaultEnabled`)
 *   setDshPluginSelection  store a new set of overrides (or `undefined`:
 *                          back to the defaults); a running host launched
 *                          with another selection is restarted once no
 *                          session has work under way
 *                          (`WorkerManager.reconcileHostPlugins`)
 *   getDshPluginReport     every allowlisted plugin's state as the latest host
 *                          start composed it (`ready.plugins`)
 *
 * The composition is host-wide (decision 019), so there is no per-session
 * switch and no restart while a turn runs.
 */

import type { DshPluginReport } from '@shared/dshPlugins';
import { dshHostSupervisor } from './DshHostSupervisor';
import { dshPluginSelectionKey } from './dshHostEnvironment';
import { readDshPluginSelection, writeDshPluginSelection } from './dshPluginSelection';
import { workerManager } from './WorkerManager';

export interface DshHostPluginsDeps {
  read: () => Record<string, boolean> | undefined;
  write: (overrides: Record<string, boolean> | undefined) => boolean;
  reconcile: (selection: string) => void;
  report: () => DshPluginReport | undefined;
}

const productionDeps: DshHostPluginsDeps = {
  read: () => readDshPluginSelection(),
  write: (overrides) => writeDshPluginSelection(overrides),
  reconcile: (selection) => workerManager.reconcileHostPlugins(selection),
  report: () => dshHostSupervisor.pluginReport(),
};

export function getDshPluginSelection(
  deps: Pick<DshHostPluginsDeps, 'read'> = productionDeps
): Record<string, boolean> | undefined {
  return deps.read();
}

/**
 * Store the overrides and bring the host in line with them. Returns whether
 * the stored value changed; the host is reconciled either way, so a selection
 * stored while no host ran is still checked against the one that runs now.
 */
export function setDshPluginSelection(
  overrides: Record<string, boolean> | undefined,
  deps: Pick<DshHostPluginsDeps, 'read' | 'write' | 'reconcile'> = productionDeps
): boolean {
  const changed = deps.write(overrides);
  deps.reconcile(dshPluginSelectionKey(deps.read()));
  return changed;
}

export function getDshPluginReport(
  deps: Pick<DshHostPluginsDeps, 'report'> = productionDeps
): DshPluginReport | undefined {
  return deps.report();
}
