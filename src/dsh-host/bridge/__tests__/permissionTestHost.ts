/**
 * The permission row the bridge's unit tests attach to (P1-6b part 2): the
 * real `PermissionHost` of the aiclient-permissions row, without Cordis. Its
 * bash parser is never loaded here; the tests that judge calls use file tools.
 */

import { type DshPermissionHost, PermissionHost } from '../../permissions/permissionHost.ts';

export function testPermissionHost(): { host: PermissionHost; api: DshPermissionHost } {
  const host = new PermissionHost({
    loadParser: () => Promise.reject(new Error('no bash parser in the bridge unit tests')),
  });
  return { host, api: host.api };
}
