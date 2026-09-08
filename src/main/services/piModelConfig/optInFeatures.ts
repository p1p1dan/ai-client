import { PI_OPT_IN_FEATURE_SETTINGS_KEY } from '@shared/piModelConfig';
import { type OptInFeature, optInFeatureRegistry } from '../../../agent-host/bundledPlugins.mjs';

export function resolveOptInFeatures(
  settings: Record<string, unknown>,
  registry: readonly OptInFeature[] = optInFeatureRegistry()
): string[] {
  const value = settings[PI_OPT_IN_FEATURE_SETTINGS_KEY];
  const overrides = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return registry
    .filter((feature) => {
      const enabled = overrides[feature.id];
      if (typeof enabled === 'boolean') return enabled;
      const legacy = feature.legacySettingKey ? settings[feature.legacySettingKey] : undefined;
      return typeof legacy === 'boolean' ? legacy : feature.defaultEnabled;
    })
    .map((feature) => feature.id);
}
