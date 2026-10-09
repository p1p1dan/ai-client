import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';
import {
  isPermissionPreset,
  migratePermissionTier,
  PERMISSION_PRESET_LABELS,
  PERMISSION_PRESETS,
  type PermissionGear,
  presetOf,
  type RuntimeMode,
  settingsOf,
} from '../types/runtimePermission';

/**
 * Decision 166 (GitHub issue #5): the composer's five presets are names for
 * `{mode, gear}` pairs. Storage keeps the pair, so these two functions are the
 * whole mapping.
 */
describe('permission presets', () => {
  it('lists the five presets in menu order', () => {
    expect(PERMISSION_PRESETS).toEqual(['plan', 'ask', 'accept-edits', 'auto', 'bypass']);
    expect(
      PERMISSION_PRESETS.map((preset) => translate('zh', PERMISSION_PRESET_LABELS[preset]))
    ).toEqual(['计划模式', '改动前确认', '自动编辑', '全自动', '完全放行']);
  });

  it('writes plan mode as plan on full auto, and every other preset as execute on its gear', () => {
    expect(settingsOf('plan')).toEqual({ mode: 'plan', gear: 'auto' });
    expect(settingsOf('ask')).toEqual({ mode: 'agent', gear: 'ask' });
    expect(settingsOf('accept-edits')).toEqual({ mode: 'agent', gear: 'accept-edits' });
    expect(settingsOf('auto')).toEqual({ mode: 'agent', gear: 'auto' });
    expect(settingsOf('bypass')).toEqual({ mode: 'agent', gear: 'bypass' });
  });

  it('reads every plan-mode pair as plan mode, whatever its gear', () => {
    const gears: PermissionGear[] = ['ask', 'accept-edits', 'auto', 'bypass'];
    for (const gear of gears) {
      expect(presetOf({ mode: 'plan', gear }), gear).toBe('plan');
      expect(presetOf({ mode: 'agent', gear }), gear).toBe(gear);
    }
  });

  it('round-trips every preset', () => {
    for (const preset of PERMISSION_PRESETS) expect(presetOf(settingsOf(preset))).toBe(preset);
  });

  it('shows a migrated 1.0.x read-only tier as plan mode without changing it', () => {
    const migrated = migratePermissionTier('readonly');
    expect(migrated).toEqual({ mode: 'plan', gear: 'ask' });
    expect(presetOf(migrated)).toBe('plan');
  });

  it('recognises preset ids only', () => {
    for (const preset of PERMISSION_PRESETS) expect(isPermissionPreset(preset)).toBe(true);
    for (const value of ['agent', 'Plan', '', null, undefined, 1] as unknown[])
      expect(isPermissionPreset(value)).toBe(false);
    const mode: RuntimeMode = 'agent';
    expect(isPermissionPreset(mode)).toBe(false);
  });
});
