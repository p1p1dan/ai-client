import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

/**
 * Route B, S-1 (docs/plantree/plans/claude-sdk-engine/topics/s1-engine-selection.md
 * decision 10): whether new Claude chats run on the official Claude Agent SDK.
 * On by default; off sends them to the built-in engine like every other model.
 * Main reads it when it creates a chat, so it never moves a chat that exists.
 */
export function ClaudeSdkEngineSection() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.claudeSdkEngineEnabled);
  const setEnabled = useSettingsStore((state) => state.setClaudeSdkEngineEnabled);

  return (
    <SettingsSectionBlock
      title={t('Claude engine')}
      description={t(
        'When on, new Claude chats run on the official Claude Agent SDK; when off, they run on the built-in engine like other models. Applies to new chats; existing chats keep the engine they started on.'
      )}
    >
      {/* The same row layout as the neighbouring switches: a short label in the
          label column, the full sentence as the switch's accessible name. */}
      <SettingsRow>
        <span className="text-ui">{t('Use Agent SDK')}</span>
        <div className="min-w-0">
          <Switch
            aria-label={t('Run Claude models on the official Agent SDK')}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
      </SettingsRow>
    </SettingsSectionBlock>
  );
}
