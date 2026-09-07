import type {
  PiModelManagementSettings as PiModelManagementSnapshot,
  PiModelSyncResult,
} from '@shared/piModelConfig';
import { CheckCircle2, ExternalLink, RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { SettingsSectionBlock } from './SettingsPrimitives';

function formatTime(value: number | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function sourceLabel(source: PiModelManagementSnapshot['state']['source']): string {
  switch (source) {
    case 'remote':
      return 'Remote';
    case 'stale-cache':
      return 'Cached';
    case 'unavailable':
      return 'Unavailable';
    case 'local':
      return 'Local setup';
  }
}

export function PiModelManagementSettings() {
  const { t } = useI18n();

  const [snapshot, setSnapshot] = useState<PiModelManagementSnapshot | null>(null);
  const [endpointUrl, setEndpointUrl] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(async () => {
    const next = await window.electronAPI.piModels.getStatus();
    setSnapshot(next);
    setEndpointUrl(next.endpointUrl);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const result: PiModelSyncResult = await window.electronAPI.piModels.sync({ endpointUrl });
      setMessage({
        text: result.ok
          ? t('Updated {{providers}} providers and {{models}} models.', {
              providers: result.providerCount,
              models: result.modelCount,
            })
          : result.error || t('Sync failed'),
        error: !result.ok,
      });
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setSyncing(false);
    }
  };

  const state = snapshot?.state;
  return (
    <div className="space-y-6">
      <SettingsSectionBlock
        title={t('Pi model management')}
        description={t(
          'Model metadata is synced to the managed directory. Your account supplies the API key.'
        )}
      />

      {!snapshot?.managed && (
        <div className="flex gap-3 rounded-md border border-info/30 bg-info/10 p-3 text-ui text-info">
          <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
          {t('Using your own setup. Pi reads your configuration from ~/.pi/agent.')}
        </div>
      )}

      <div className="border-t p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-ui font-semibold">{t('Management server')}</span>
          </div>
          {state && (
            <Badge variant={state.source === 'remote' ? 'success' : 'warning'}>
              {t(sourceLabel(state.source))}
            </Badge>
          )}
        </div>
        <div className="space-y-2">
          <label htmlFor="pi-model-management-url" className="text-meta text-muted-foreground">
            {t('Configuration URL')}
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="pi-model-management-url"
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.target.value)}
              placeholder="https://onboarding.example.com/api/v1/models-config"
              disabled={!snapshot?.managed || syncing}
            />
            <Button
              variant="outline"
              onClick={() => window.electronAPI.piModels.openAdmin(endpointUrl)}
              disabled={!endpointUrl.trim()}
            >
              <ExternalLink className="h-4 w-4" />
              {t('Open')}
            </Button>
            <Button onClick={sync} disabled={!snapshot?.managed || !endpointUrl.trim() || syncing}>
              <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? t('Syncing') : t('Sync now')}
            </Button>
          </div>
        </div>

        {state && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 text-meta sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">{t('Providers')}</dt>
              <dd className="tabular-nums font-semibold">{state.providerCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('Models')}</dt>
              <dd className="tabular-nums font-semibold">{state.modelCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('Last successful sync')}</dt>
              <dd className="tabular-nums">{formatTime(state.syncedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('Last attempt')}</dt>
              <dd className="tabular-nums">{formatTime(state.lastAttemptAt)}</dd>
            </div>
          </dl>
        )}

        {state?.agentDir && (
          <p className="break-all text-meta text-muted-foreground">
            {t('Managed directory:')}
            <Ident>{state.agentDir}</Ident>
          </p>
        )}
        {(message || state?.error) && (
          <div
            className={`flex gap-2 rounded-sm border p-3 text-ui ${
              message?.error || (!message && state?.error)
                ? 'border-destructive/30 bg-destructive/8 text-destructive'
                : 'border-success/30 bg-success/8 text-success'
            }`}
          >
            {message?.error || (!message && state?.error) ? (
              <TriangleAlert className="h-4 w-4 shrink-0" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            )}
            {message?.text || state?.error}
          </div>
        )}
      </div>

      <div className="border-t pt-4 text-meta text-muted-foreground space-y-1">
        <p>{t('The default URL points to /api/v1/models-config on the onboarding service.')}</p>
        <p>
          {t('The management page is at /admin and requires the server administrator password.')}
        </p>
        <p>
          {t(
            'Sync requires a signed-in account because the configuration may contain provider credentials.'
          )}
        </p>
      </div>
    </div>
  );
}
