/** D14: mode selects capabilities; gear controls approval frequency. */
export type RuntimeMode = 'plan' | 'agent';
export type PermissionGear = 'ask' | 'accept-edits' | 'auto';
export type LegacyPermissionTier = 'readonly' | 'pragmatic' | 'handsoff' | 'fullopen';
export interface RuntimePermissionSettings {
  mode: RuntimeMode;
  gear: PermissionGear;
}
export const DEFAULT_RUNTIME_PERMISSION: RuntimePermissionSettings = { mode: 'agent', gear: 'ask' };
export const PERMISSION_GEAR_LABELS: Record<PermissionGear, string> = {
  ask: '每次询问',
  'accept-edits': '自动接受编辑',
  auto: '全自动',
};
export const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = { plan: '规划', agent: '执行' };

export function migratePermissionTier(tier: LegacyPermissionTier): RuntimePermissionSettings {
  switch (tier) {
    case 'readonly':
      return { mode: 'plan', gear: 'ask' };
    case 'pragmatic':
      return { mode: 'agent', gear: 'ask' };
    case 'handsoff':
      return { mode: 'agent', gear: 'accept-edits' };
    case 'fullopen':
      return { mode: 'agent', gear: 'auto' };
  }
}
export function resolveRuntimePermission(input: {
  mode?: RuntimeMode;
  gear?: PermissionGear;
  tier?: LegacyPermissionTier;
}): RuntimePermissionSettings {
  const base = input.tier ? migratePermissionTier(input.tier) : DEFAULT_RUNTIME_PERMISSION;
  return { mode: input.mode ?? base.mode, gear: input.gear ?? base.gear };
}

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === 'plan' || value === 'agent';
}
export function isPermissionGear(value: unknown): value is PermissionGear {
  return value === 'ask' || value === 'accept-edits' || value === 'auto';
}
export function isRuntimePermissionSettings(value: unknown): value is RuntimePermissionSettings {
  return (
    typeof value === 'object' &&
    value !== null &&
    'mode' in value &&
    'gear' in value &&
    isRuntimeMode(value.mode) &&
    isPermissionGear(value.gear)
  );
}
