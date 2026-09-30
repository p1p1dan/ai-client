/**
 * The permission row the bridge's unit tests attach to (P1-6b part 2): the
 * real `PermissionHost` of the aiclient-permissions row, without Cordis. Its
 * bash parser is never loaded here; the tests that judge calls use file tools
 * (and pwsh, whose analysis needs no parser).
 */

import type { PermissionFileSystem } from '../../../shared/permissions/shellPaths.ts';
import { type DshPermissionHost, PermissionHost } from '../../permissions/permissionHost.ts';

export function testPermissionHost(options: { fs?: PermissionFileSystem } = {}): {
  host: PermissionHost;
  api: DshPermissionHost;
} {
  const host = new PermissionHost({
    loadParser: () => Promise.reject(new Error('no bash parser in the bridge unit tests')),
    ...(options.fs ? { fs: options.fs } : {}),
  });
  return { host, api: host.api };
}
