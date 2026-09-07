import type { Locale } from '@shared/i18n';
import { FolderOpen, RefreshCw } from 'lucide-react';
import * as React from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

interface UpdateStatus {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  info?: { version?: string };
  error?: string;
}

export function GeneralSettings() {
  const {
    language,
    setLanguage,

    autoUpdateEnabled,
    setAutoUpdateEnabled,

    temporaryWorkspaceEnabled,
    setTemporaryWorkspaceEnabled,
    defaultTemporaryPath,
    setDefaultTemporaryPath,
    autoCreateSessionOnTempActivate,
    setAutoCreateSessionOnTempActivate,
  } = useSettingsStore();
  const { t } = useI18n();

  const appVersion = window.electronAPI?.env.appVersion || '0.0.0';
  const [updateStatus, setUpdateStatus] = React.useState<UpdateStatus | null>(null);

  const [tempPathDialogOpen, setTempPathDialogOpen] = React.useState(false);

  const handleSelectTempPath = React.useCallback(async () => {
    const result = await window.electronAPI.dialog.openDirectory();
    if (!result) return;
    const check = await window.electronAPI.tempWorkspace.checkPath(result);
    if (check.ok) {
      setDefaultTemporaryPath(result);
      return;
    }
    setTempPathDialogOpen(true);
  }, [setDefaultTemporaryPath]);
  React.useEffect(() => {
    const cleanup = window.electronAPI.updater.onStatus((status) => {
      setUpdateStatus(status as UpdateStatus);
    });
    return cleanup;
  }, []);
  const handleCheckForUpdates = React.useCallback(() => {
    window.electronAPI.updater.checkForUpdates();
  }, []);

  return (
    <div className="space-y-6">
      <SettingsSectionBlock title={t('Language')} description={t('Choose display language')}>
        <SettingsRow>
          <span className="text-sm font-medium mt-2">{t('Language')}</span>
          <div className="space-y-1.5">
            <Select value={language} onValueChange={(v) => setLanguage(v as Locale)}>
              <SelectTrigger className="w-48">
                <SelectValue>{language === 'zh' ? t('Chinese') : t('English')}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="en">{t('English')}</SelectItem>
                <SelectItem value="zh">{t('Chinese')}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        </SettingsRow>
      </SettingsSectionBlock>
      <SettingsSectionBlock title={t('Temp Session')} description={t('Temp Session settings')}>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Temp Session')}</span>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('Show Temp Session entry for quick scratch sessions')}
            </p>
            <Switch
              checked={temporaryWorkspaceEnabled}
              onCheckedChange={setTemporaryWorkspaceEnabled}
            />
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Auto-create session')}</span>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('Automatically create Agent/Terminal Session when activating a temp session')}
            </p>
            <Switch
              checked={autoCreateSessionOnTempActivate}
              onCheckedChange={setAutoCreateSessionOnTempActivate}
              disabled={!temporaryWorkspaceEnabled}
            />
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium mt-2">{t('Save location')}</span>
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <Input
                value={defaultTemporaryPath}
                onChange={(e) => setDefaultTemporaryPath(e.target.value)}
                placeholder="~/JYWAI/temporary"
                className="flex-1"
                disabled={!temporaryWorkspaceEnabled}
              />
              <Button
                variant="outline"
                size="icon"
                onClick={handleSelectTempPath}
                disabled={!temporaryWorkspaceEnabled}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('Default directory for new temp sessions. Leave empty to use ~/JYWAI/temporary')}
            </p>
          </div>
        </SettingsRow>
      </SettingsSectionBlock>
      <SettingsSectionBlock title={t('Updates')} description={t('Application update settings')}>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Version')}</span>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">v{appVersion}</span>
              {updateStatus?.status === 'available' && updateStatus.info?.version && (
                <span className="text-xs text-green-600 dark:text-green-400">
                  ({t('New version')}: v{updateStatus.info.version})
                </span>
              )}
              {updateStatus?.status === 'not-available' && (
                <span className="text-xs text-muted-foreground">({t('Up to date')})</span>
              )}
              {updateStatus?.status === 'error' && (
                <span
                  className="text-xs text-destructive truncate max-w-[420px]"
                  title={updateStatus.error || ''}
                >
                  ({t('Check failed')}
                  {updateStatus.error ? `: ${updateStatus.error}` : ''})
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckForUpdates}
              disabled={
                updateStatus?.status === 'checking' || updateStatus?.status === 'downloading'
              }
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${updateStatus?.status === 'checking' ? 'animate-spin' : ''}`}
              />
              {updateStatus?.status === 'checking' ? t('Checking...') : t('Check for updates')}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Auto update')}</span>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('Automatically download and install updates')}
            </p>
            <Switch checked={autoUpdateEnabled} onCheckedChange={setAutoUpdateEnabled} />
          </div>
        </SettingsRow>
        <AlertDialog open={tempPathDialogOpen} onOpenChange={setTempPathDialogOpen}>
          <AlertDialogPopup className="max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Directory unavailable')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('This directory is not readable or writable. Please choose another location.')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline">{t('Cancel')}</Button>} />
              <AlertDialogClose
                render={<Button onClick={handleSelectTempPath}>{t('Choose directory')}</Button>}
              />
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </SettingsSectionBlock>
    </div>
  );
}
