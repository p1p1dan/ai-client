import { FileText } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

// Parse shell arguments string, supporting single/double quotes for paths with spaces

export function AdvancedSettings() {
  const {
    loggingEnabled,
    setLoggingEnabled,
    logLevel,
    setLogLevel,
    logRetentionDays,
    setLogRetentionDays,
  } = useSettingsStore();
  const { t } = useI18n();

  const handleOpenLogFolder = React.useCallback(async () => {
    await window.electronAPI.log.openFolder();
  }, []);

  return (
    <div className="space-y-6">
      <SettingsSectionBlock
        title={t('Logging')}
        description={t(
          'Enable logging to help diagnose issues. Logs are stored locally and never uploaded.'
        )}
      >
        <SettingsRow>
          <span className="text-sm font-medium">{t('Enable Logging')}</span>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {loggingEnabled ? t('Enabled') : t('Disabled')}
            </span>
            <Switch checked={loggingEnabled} onCheckedChange={setLoggingEnabled} />
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Log Level')}</span>
          <Select
            value={logLevel}
            onValueChange={(v) => setLogLevel(v as 'error' | 'warn' | 'info' | 'debug')}
            disabled={!loggingEnabled}
          >
            <SelectTrigger className="w-64">
              <SelectValue>
                {logLevel === 'error' && t('Error')}
                {logLevel === 'warn' && t('Warning')}
                {logLevel === 'info' && t('Info')}
                {logLevel === 'debug' && t('Debug')}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="error">
                {t('Error')} - {t('Only critical errors')}
              </SelectItem>
              <SelectItem value="warn">
                {t('Warning')} - {t('Errors and warnings')}
              </SelectItem>
              <SelectItem value="info">
                {t('Info')} - {t('General information')} ({t('Recommended')})
              </SelectItem>
              <SelectItem value="debug">
                {t('Debug')} - {t('Detailed diagnostic information')}
              </SelectItem>
            </SelectPopup>
          </Select>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Log Files')}</span>
          <Button variant="outline" size="sm" onClick={handleOpenLogFolder} className="w-fit">
            <FileText className="mr-2 h-4 w-4" />
            {t('Open Log Folder')}
          </Button>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Log Retention')}</span>
          <div className="flex items-center gap-2">
            <Select
              value={String(logRetentionDays)}
              onValueChange={(v) => setLogRetentionDays(Number(v))}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="7">{t('7 days')}</SelectItem>
                <SelectItem value="14">{t('14 days')}</SelectItem>
                <SelectItem value="30">{t('30 days')}</SelectItem>
              </SelectPopup>
            </Select>
            <span className="text-xs text-muted-foreground">
              {t('Old log files will be automatically deleted')}
            </span>
          </div>
        </SettingsRow>
      </SettingsSectionBlock>
    </div>
  );
}
