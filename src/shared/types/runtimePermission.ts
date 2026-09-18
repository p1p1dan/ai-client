/** D14: mode selects capabilities; gear controls approval frequency. */
export type RuntimeMode = 'plan' | 'agent';
/**
 * `bypass` is the fourth gear, and the only one that never raises a card.
 *
 * `auto` still stops for a bash command whose operands the static analysis
 * could not resolve (a `$VAR`, a `$(...)`, a loop variable), which is the
 * "full auto still asks me" the field pass kept reporting. `bypass` answers
 * that case too. It widens APPROVAL only: every deny — policy rules, bundled
 * secrets, deny scopes, plan mode, the tool whitelist — is decided before any
 * gear is consulted and stays in force.
 *
 * Deliberately not persistable as a new-chat default, and not declarable by a
 * subagent definition: it is a decision a person makes for one live thread.
 */
export type PermissionGear = 'ask' | 'accept-edits' | 'auto' | 'bypass';
export type LegacyPermissionTier = 'readonly' | 'pragmatic' | 'handsoff' | 'fullopen';
export interface RuntimePermissionSettings {
  mode: RuntimeMode;
  gear: PermissionGear;
}
export const DEFAULT_RUNTIME_PERMISSION: RuntimePermissionSettings = { mode: 'agent', gear: 'ask' };
/**
 * Display labels, as DICTIONARY KEYS rather than display text.
 *
 * This module is `@shared` and has no translator in scope, and the labels used
 * to be Chinese literals — which meant the whole permission control stayed
 * Chinese after a user picked English in Settings · General. Same treatment as
 * the tool verbs (batch 4): the English string IS the key, and the component
 * that renders it calls `t()` once.
 */
export const PERMISSION_GEAR_LABELS: Record<PermissionGear, string> = {
  ask: 'Ask every time',
  'accept-edits': 'Auto-accept edits',
  auto: 'Full auto',
  // NOT 'Bypass permissions': that key is already taken by the legacy Pi
  // permission-mode picker, whose catalog entry reads 「跳过权限确认」.
  bypass: 'Bypass all prompts',
};
export const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  plan: 'Plan',
  agent: 'Execute',
};

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
  return value === 'ask' || value === 'accept-edits' || value === 'auto' || value === 'bypass';
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
