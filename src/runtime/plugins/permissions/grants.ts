// Thin re-export (dsh-rebase P1-6a): the grant rules live in src/shared/permissions/grants.ts.
export {
  commandPrefix,
  commandPrefixes,
  containsPath,
  decodeGrants,
  describeGrantScope,
  encodeGrants,
  grantCovers,
  grantKeyOf,
  grantsFor,
  PERMISSION_GRANTS_ENTRY,
  PERMISSION_GRANTS_VERSION,
  type PermissionGrant,
  type PersistedGrants,
  restoredGrants,
} from '../../../shared/permissions/grants.ts';
