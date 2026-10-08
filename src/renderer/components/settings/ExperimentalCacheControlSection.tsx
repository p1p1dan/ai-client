import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

/**
 * GW-16 temporary switch (dsh-rebase decisions 149 rule 19, 159): whether
 * anthropic-messages requests also mark the tool definitions for the prompt
 * cache. Off by default (two `cache_control` marks per request at most), on
 * restores three. Main rebuilds the model plan when it flips, so it applies
 * from the next turn. A test switch: remove this file with it.
 */
export function ExperimentalCacheControlSection() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.experimentalCacheControlOnTools);
  const setEnabled = useSettingsStore((state) => state.setExperimentalCacheControlOnTools);

  return (
    <SettingsSectionBlock
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{t('Cache breakpoint on tool definitions')}</span>
          <Badge variant="warning" className="shrink-0">
            {t('Experimental · temporary')}
          </Badge>
        </span>
      }
      description={t(
        'Also mark the tool definitions of Claude (Anthropic Messages) requests for the prompt cache. Off: at most 2 cache_control marks per request; on: 3. For tracing cache_limit errors from the company gateway; removed or made permanent once testing ends.'
      )}
    >
      <SettingsRow>
        <span className="text-ui">{t('Cache tool definitions')}</span>
        <div className="min-w-0 space-y-2">
          <Switch
            aria-label={t('Cache tool definitions')}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <p className="text-meta text-muted-foreground">
            {t('Takes effect from the next turn; no restart needed.')}
          </p>
        </div>
      </SettingsRow>
    </SettingsSectionBlock>
  );
}
