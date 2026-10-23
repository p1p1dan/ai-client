import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

/**
 * Route B S-6 feedback 10 (claude-sdk-engine README ruling 26): the developer
 * mode switch, in plain sight on the Advanced page. Off by default; while off,
 * the settings it gates are hidden and run on their defaults
 * (`@shared/developerMode`). They all live right below it: the model-request
 * sections (`DeveloperModelSections`) follow this block.
 */
export function DeveloperModeSection() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.developerModeEnabled);
  const setEnabled = useSettingsStore((state) => state.setDeveloperModeEnabled);
  const listTitle = useSettingsStore((state) => state.sidebarListTitleEnabled);
  const setListTitle = useSettingsStore((state) => state.setSidebarListTitleEnabled);

  return (
    <SettingsSectionBlock
      title={t('Developer mode')}
      description={t(
        'Shows settings meant for development and testing below: request identity (User-Agent), the Agent SDK engine switch, caching tool definitions and the chat list title. While off, they are hidden and run on their defaults; values you set are kept and apply again when you turn it back on.'
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
      {/* User, 2026-10-23: a developer-only switch; off, the row is hidden
          and the list's right-click switches the grouping. */}
      {enabled && (
        <SettingsRow>
          <div className="min-w-0">
            <p className="text-ui">{t('Chat list title')}</p>
            <p className="text-small text-muted-foreground">
              {t('Show a title row above the chat list with the grouping and its menu')}
            </p>
          </div>
          <div className="min-w-0">
            <Switch
              aria-label={t('Chat list title')}
              checked={listTitle}
              onCheckedChange={setListTitle}
            />
          </div>
        </SettingsRow>
      )}
    </SettingsSectionBlock>
  );
}
