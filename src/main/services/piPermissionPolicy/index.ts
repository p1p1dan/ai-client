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
 * ## Which one is writable
 *
 * Only `global`, in both modes since H/19. It used to be managed-only, because
 * on the local route the global scope WAS the user's own `~/.pi/agent` and
 * writing it to make our app behave would have silently changed a tool we do not
 * own — the T08-a red line. H/19 moved every session onto this app's own agent
 * directory, so the file behind this scope is now ours in both modes and the red
 * line is satisfied by not writing `~/.pi/agent` at all, rather than by refusing
 * to write anything. Refusing now would be worse than useless: the panel would
 * be read-only about a file nothing else can edit either.
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
import { getAppPiAgentDir } from '../piModelConfig';
import { readRawDocument, readScopes, type ScopeLocation, writeScopeDocument } from './policyStore';

const EXTENSION_ID = 'pi-permission-system';
const CONFIG_FILE = 'config.json';

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

/**
 * The scope files to read, in the order the plugin merges them.
 *
 * Exported so the tests can assert the ORDER as well as the paths: the order is
 * the policy, and a scope list that put `project` before `global` would show a
 * user a posture their agent never runs under.
 *
 * decision 009 — no longer route-dependent. The managed route used to mark the
 * project scope as withheld, because the worker was started with
 * `projectTrusted: false` and really did drop it. It no longer is: a managed
 * session loads `<repo>/.pi/extensions/pi-permission-system/config.json` the
 * same way a local one does, so the panel must show that file as contributing
 * or it would be describing a session nobody runs.
 */
export function resolveScopeLocations(agentDir: string, repoPath?: string): ScopeLocation[] {
  const locations: ScopeLocation[] = [
    { id: 'bundled', path: join(getBundledPluginDir(), CONFIG_FILE) },
    { id: 'global', path: getGlobalPolicyPath(agentDir) },
  ];
  if (repoPath) {
    locations.push({ id: 'project', path: getProjectPolicyPath(repoPath) });
  }
  return locations;
}

export function readPermissionPolicy(repoPath?: string): PermissionPolicySnapshot {
  const route = currentRoute();
  const agentDir = getAppPiAgentDir();
  const scopes = readScopes(resolveScopeLocations(agentDir, repoPath));
  return {
    route,
    agentDir,
    // H/19: writable on both routes, because the file behind the global scope is
    // this app's in both.
    editable: true,
    scopes,
    effective: effectivePolicy(scopes),
  };
}

/** Apply a patch to the writable scope and return the policy as it now stands. */
export function updatePermissionPolicy(
  patch: PolicyPatch,
  repoPath?: string
): PermissionPolicySnapshot {
  const path = getGlobalPolicyPath(getAppPiAgentDir());
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
  writeScopeDocument(getGlobalPolicyPath(getAppPiAgentDir()), {});
  return readPermissionPolicy(repoPath);
}
