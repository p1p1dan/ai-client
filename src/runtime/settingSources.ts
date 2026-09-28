// Thin re-export (dsh-rebase P1-16 prep): the setting-source gate lives in src/shared/settingSources.ts,
// because the shared skills and MCP loaders apply the same decision 008 rule.
export {
  ALL_SETTING_SOURCES,
  resolveSettingSources,
  type SettingSource,
  type SettingSourceGate,
  type SettingSourceOptions,
} from '../shared/settingSources.ts';
