import { RefreshCw } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

// Parse shell arguments string, supporting single/double quotes for paths with spaces

export function NetworkSettings() {
  const { proxySettings, setProxySettings } = useSettingsStore();
  const { t } = useI18n();

  const [proxyTestStatus, setProxyTestStatus] = React.useState<
    'idle' | 'testing' | 'success' | 'error'
  >('idle');
  const [proxyTestLatency, setProxyTestLatency] = React.useState<number | null>(null);
  const [proxyTestError, setProxyTestError] = React.useState<string | null>(null);

  const handleTestProxy = React.useCallback(async () => {
    if (!proxySettings.server) return;

    setProxyTestStatus('testing');
    setProxyTestLatency(null);
    setProxyTestError(null);

    const result = await window.electronAPI.app.testProxy(proxySettings.server);

    if (result.success) {
      setProxyTestStatus('success');
      setProxyTestLatency(result.latency ?? null);
    } else {
      setProxyTestStatus('error');
      setProxyTestError(result.error ?? 'Unknown error');
    }
  }, [proxySettings.server]);
  const handleProxyServerChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setProxySettings({ server: e.target.value });
      // Reset test status when server changes
      setProxyTestStatus('idle');
      setProxyTestLatency(null);
      setProxyTestError(null);
    },
    [setProxySettings]
  );
  const handleProxyServerBlur = React.useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      const trimmed = e.target.value.trim();
      if (trimmed !== e.target.value) {
        setProxySettings({ server: trimmed });
      }
    },
    [setProxySettings]
  );

  return (
    <div className="space-y-6">
      <SettingsSectionBlock title={t('Proxy')} description={t('Network proxy settings')}>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Enable proxy')}</span>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('Route all network requests through proxy')}
            </p>
            <Switch
              checked={proxySettings.enabled}
              onCheckedChange={(enabled) => setProxySettings({ enabled })}
            />
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium mt-2">{t('Proxy server')}</span>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Input
                value={proxySettings.server}
                onChange={handleProxyServerChange}
                onBlur={handleProxyServerBlur}
                placeholder="http://127.0.0.1:7897"
                disabled={!proxySettings.enabled}
                className="w-64"
                aria-invalid={
                  proxySettings.enabled &&
                  !!proxySettings.server &&
                  !/^((https?|socks5?h?|socks4a?):\/\/)?[\w.-]+:\d+/.test(proxySettings.server)
                }
              />
              <Button
                variant="outline"
                size="sm"
                disabled={
                  !proxySettings.enabled ||
                  !proxySettings.server ||
                  !/^((https?|socks5?h?|socks4a?):\/\/)?[\w.-]+:\d+/.test(proxySettings.server) ||
                  proxyTestStatus === 'testing'
                }
                onClick={handleTestProxy}
              >
                {proxyTestStatus === 'testing' ? (
                  <>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t('Testing...')}
                  </>
                ) : (
                  t('Test')
                )}
              </Button>
              {proxyTestStatus === 'success' && proxyTestLatency !== null && (
                <span className="text-xs text-green-600 dark:text-green-400">
                  ✓ {proxyTestLatency}ms
                </span>
              )}
              {proxyTestStatus === 'error' && proxyTestError && (
                <span className="text-xs text-destructive" title={proxyTestError}>
                  ✗ {t('Failed')}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('e.g., 127.0.0.1:7897 or http://proxy:8080')}
            </p>
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium mt-2">{t('Bypass list')}</span>
          <div className="space-y-1.5">
            <Input
              value={proxySettings.bypassList}
              onChange={(e) => setProxySettings({ bypassList: e.target.value })}
              placeholder="localhost,127.0.0.1"
              disabled={!proxySettings.enabled}
              className="w-64"
            />
            <p className="text-xs text-muted-foreground">
              {t('Comma-separated list of hosts that bypass the proxy')}
            </p>
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Update via proxy')}</span>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('Route update requests through proxy')}
              {!proxySettings.enabled && proxySettings.useProxyForUpdates && (
                <span className="text-xs ml-1">({t('Requires proxy to be enabled')})</span>
              )}
            </p>
            <Switch
              checked={proxySettings.useProxyForUpdates}
              onCheckedChange={(useProxyForUpdates) => setProxySettings({ useProxyForUpdates })}
              disabled={!proxySettings.enabled}
            />
          </div>
        </SettingsRow>
      </SettingsSectionBlock>
    </div>
  );
}
