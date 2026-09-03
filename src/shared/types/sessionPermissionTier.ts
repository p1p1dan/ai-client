/**
 * U12 — session-level permission tier.
 *
 * Four tiers, expressed in this repo's own permission vocabulary
 * (`allow`/`ask`/`deny`), not in any SDK-specific terms.
 */

export type SessionPermissionTier = 'readonly' | 'pragmatic' | 'handsoff' | 'fullopen';

export const SESSION_PERMISSION_TIERS: readonly SessionPermissionTier[] = [
  'readonly',
  'pragmatic',
  'handsoff',
  'fullopen',
];

export const DEFAULT_SESSION_PERMISSION_TIER: SessionPermissionTier = 'pragmatic';

export function isSessionPermissionTier(value: unknown): value is SessionPermissionTier {
  return (
    typeof value === 'string' &&
    (value === 'readonly' || value === 'pragmatic' || value === 'handsoff' || value === 'fullopen')
  );
}
