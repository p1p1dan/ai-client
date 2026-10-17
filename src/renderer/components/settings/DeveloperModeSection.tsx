import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

/**
 * Route B S-6 feedback 10 (claude-sdk-engine README ruling 26): the developer
 * mode switch, in plain sight on the Advanced page. Off by default; while off,
 * the settings it gates are hidden on the Models page and run on their
 * defaults (`@shared/developerMode`).
 */
export function DeveloperModeSection() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.developerModeEnabled);
  const setEnabled = useSettingsStore((state) => state.setDeveloperModeEnabled);

  return (
    <SettingsSectionBlock
      title={t('Developer mode')}
      description={t(
        'Shows settings meant for development and testing on the Models page: request identity (User-Agent), the Agent SDK engine switch and caching tool definitions. While off, they are hidden and run on their defaults; values you set are kept and apply again when you turn it back on.'
      )}
    >
      <SettingsRow>
        <span className="text-ui">{t('Developer mode')}</span>
        <div className="min-w-0">
          <Switch
            aria-label={t('Enable developer mode')}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
      </SettingsRow>
    </SettingsSectionBlock>
  );
}
