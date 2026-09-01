/**
 * T08-c slice 2 — where the permission-policy scopes live, and which one we may
 * write.
 *
 * ## The three scopes, and why they are these three
 *
 * They are the ones `@gotgenes/pi-permission-system` reads that this app has any
 * business showing:
 *
 *  - **bundled** — `<worker dir>/node_modules/@gotgenes/pi-permission-system/config.json`,
 *    the policy we ship (D11). Derived from the Pi worker entry so it is the
 *    same artifact root in dev and packaged layouts.
 *  - **global** — `<agentDir>/extensions/pi-permission-system/config.json`.
 *  - **project** — `<repo>/.pi/extensions/pi-permission-system/config.json`.
 *
 * The plugin also reads two legacy `pi-permissions.jsonc` files. They are
 * deliberately not surfaced: this app never writes them, and a control that
 * pretended to manage a file we would not touch is worse than the plugin's own
 * "move it to …" warning.
 *
 * ## Which one is writable, and the line that decides it
 *
 * Only `global`, and only on the managed route. On the local route the global
 * scope IS the user's own `~/.pi/agent` — the directory their `pi` CLI reads —
 * and writing it to make OUR app behave would silently change a tool we do not
 * own. That is the T08-a red line, restated in `permissionPolicy.mjs` and
 * enforced here by never handing that path to the writer.
 *
 * `bundled` is never writable: it is inside our own artifact, read-only by
 * design, and the whole point of it being the lowest scope is that the user's
 * edits go somewhere that outranks it.
 */

import { dirname, join } from 'node:path';
import {
  applyPolicyPatch,
  effectivePolicy,
  type PermissionPolicyRoute,
  type PermissionPolicySnapshot,
  type PolicyPatch,
} from '@shared/piPermissionPolicy';
import { resolveCurrentPiWorkerEntryPath } from '../agent-host/PiWorkerProcess';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { getLocalPiAgentDir, getManagedPiAgentDir } from '../piModelConfig';
import { readRawDocument, readScopes, type ScopeLocation, writeScopeDocument } from './policyStore';

const EXTENSION_ID = 'pi-permission-system';
const CONFIG_FILE = 'config.json';

/**
 * The reason the project scope is ignored on the managed route, in the user's
 * words rather than pi's.
 *
 * D11 decision 4 sends `projectTrusted: false` to the Host in managed mode, so
 * a cloned repository cannot loosen the company posture. The panel still lists
 * the file, because a policy that exists and does nothing is exactly the state
 * someone would otherwise spend an afternoon on.
 */
export const PROJECT_SCOPE_WITHHELD =
  'Ignored on the managed route: a repository cannot change the permission policy.';

export const LOCAL_ROUTE_READ_ONLY =
  'Read-only: on “use my own setup”, this policy lives in your own ~/.pi, which belongs to your pi CLI. Edit it there.';

/** The directory holding the bundled plugin — the same one the Host injects. */
export function getBundledPluginDir(): string {
  return join(
    dirname(resolveCurrentPiWorkerEntryPath()),
    'node_modules',
    '@gotgenes',
    EXTENSION_ID
  );
}

/** `<agentDir>/extensions/pi-permission-system/config.json`. */
export function getGlobalPolicyPath(agentDir: string): string {
  return join(agentDir, 'extensions', EXTENSION_ID, CONFIG_FILE);
}

/** `<repo>/.pi/extensions/pi-permission-system/config.json`. */
export function getProjectPolicyPath(repoPath: string): string {
  return join(repoPath, '.pi', 'extensions', EXTENSION_ID, CONFIG_FILE);
}

function currentRoute(): PermissionPolicyRoute {
  return resolveManagedCredentialsEnabled() ? 'managed' : 'local';
}

function agentDirFor(route: PermissionPolicyRoute): string {
  return route === 'managed' ? getManagedPiAgentDir() : getLocalPiAgentDir();
}

/**
 * The scope files to read, in the order the plugin merges them.
 *
 * Exported so the tests can assert the ORDER as well as the paths: the order is
 * the policy, and a scope list that put `project` before `global` would show a
 * user a posture their agent never runs under.
 */
export function resolveScopeLocations(
  route: PermissionPolicyRoute,
  agentDir: string,
  repoPath?: string
): ScopeLocation[] {
  const locations: ScopeLocation[] = [
    { id: 'bundled', path: join(getBundledPluginDir(), CONFIG_FILE) },
    { id: 'global', path: getGlobalPolicyPath(agentDir) },
  ];
  if (repoPath) {
    locations.push({
      id: 'project',
      path: getProjectPolicyPath(repoPath),
      ...(route === 'managed' ? { withheldReason: PROJECT_SCOPE_WITHHELD } : {}),
    });
  }
  return locations;
}

export function readPermissionPolicy(repoPath?: string): PermissionPolicySnapshot {
  const route = currentRoute();
  const agentDir = agentDirFor(route);
  const scopes = readScopes(resolveScopeLocations(route, agentDir, repoPath));
  return {
    route,
    agentDir,
    editable: route === 'managed',
    ...(route === 'managed' ? {} : { readOnlyReason: LOCAL_ROUTE_READ_ONLY }),
    scopes,
    effective: effectivePolicy(scopes),
  };
}

/**
 * Apply a patch to the writable scope and return the policy as it now stands.
 *
 * Refuses outright on the local route rather than silently doing nothing: a
 * control that appears to save and does not is how a user ends up believing they
 * tightened a policy they did not.
 */
export function updatePermissionPolicy(
  patch: PolicyPatch,
  repoPath?: string
): PermissionPolicySnapshot {
  const route = currentRoute();
  if (route !== 'managed') throw new Error(LOCAL_ROUTE_READ_ONLY);
  const path = getGlobalPolicyPath(agentDirFor(route));
  writeScopeDocument(path, applyPolicyPatch(readRawDocument(path), patch));
  return readPermissionPolicy(repoPath);
}

/**
 * Drop the whole writable scope, falling back to what this app ships.
 *
 * Deleting rather than writing `{}` — see `writeScopeDocument`: an empty file
 * still makes the panel report a scope, and "reset" should leave no trace.
 */
export function resetPermissionPolicy(repoPath?: string): PermissionPolicySnapshot {
  const route = currentRoute();
  if (route !== 'managed') throw new Error(LOCAL_ROUTE_READ_ONLY);
  writeScopeDocument(getGlobalPolicyPath(agentDirFor(route)), {});
  return readPermissionPolicy(repoPath);
}
