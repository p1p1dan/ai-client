import type { Translate } from '@shared/i18n';
import type {
  PiModelManagementSettings as PiModelManagementSnapshot,
  PiModelSyncResult,
} from '@shared/piModelConfig';
import { isPromptCacheTtl, PROMPT_CACHE_TTLS } from '@shared/types/promptCacheTtl';
import {
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  PROVIDER_IDLE_TIMEOUT_CHOICES,
  PROVIDER_IDLE_TIMEOUT_DISABLED,
  readProviderIdleTimeoutMs,
} from '@shared/types/providerTimeout';
import { CheckCircle2, ExternalLink, RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

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
    // A3: named for what it is. "Cached" would claim this machine fetched it
    // once, which a shipped baseline never was.
    case 'bundled':
      return 'Shipped baseline';
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

      <PromptCacheTtlSection />
      <ProviderIdleTimeoutSection />
    </div>
  );
}

/**
 * The main conversation's prompt cache lifetime.
 *
 * Lives on this page rather than in General because it is a property of how we
 * make MODEL requests, not of the app's chrome. The delegate's own TTL is on the
 * subagents page, next to everything else that is about delegates.
 *
 * Both are read when a session's worker starts, so the note below is not a
 * disclaimer — it is the actual rule a user needs to know to test the change.
 */
function PromptCacheTtlSection() {
  const { t } = useI18n();
  const promptCacheTtl = useSettingsStore((state) => state.promptCacheTtl);
  const setPromptCacheTtl = useSettingsStore((state) => state.setPromptCacheTtl);

  return (
    <SettingsSectionBlock
      title={t('Prompt cache')}
      description={t(
        'How long the provider keeps the main conversation cached between turns. One hour costs a little more on each write and saves the whole prefix on every turn that follows a pause longer than five minutes.'
      )}
    >
      <SettingsRow>
        <span className="text-ui">{t('Main conversation')}</span>
        <div className="min-w-0 space-y-2">
          <ToggleGroup
            value={[promptCacheTtl]}
            onValueChange={(value) => {
              const next = (value as string[])[0];
              if (isPromptCacheTtl(next)) setPromptCacheTtl(next);
            }}
          >
            {PROMPT_CACHE_TTLS.map((ttl) => (
              <ToggleGroupItem key={ttl} value={ttl}>
                {ttl === '1h' ? t('1 hour') : t('5 minutes')}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-meta text-muted-foreground">
            {t('Takes effect the next time a conversation starts its runtime.')}
          </p>
        </div>
      </SettingsRow>
    </SettingsSectionBlock>
  );
}

/**
 * T093 / decision 029 — how long a model request may stay silent.
 *
 * Next to the prompt cache because both are properties of how we make MODEL
 * requests, and both reach a conversation the same way: read once, when its
 * worker starts.
 *
 * A picker rather than free text: the five rungs are the ones pi's own CLI
 * offers, and a number field would invite the value this setting exists to
 * prevent (the 2026-09-19 field report was a gateway holding one attempt for
 * ten minutes).
 *
 * Exported so a mount test can render THIS section without stubbing the model
 * -catalog IPC the rest of the page loads on start.
 */
export function ProviderIdleTimeoutSection() {
  const { t } = useI18n();
  const providerIdleTimeoutMs = useSettingsStore((state) => state.providerIdleTimeoutMs);
  const setProviderIdleTimeoutMs = useSettingsStore((state) => state.setProviderIdleTimeoutMs);

  // `0` is the "off" rung, so the current value is compared and transported as
  // a STRING: `String(0)` is `'0'`, which is a perfectly ordinary option value,
  // whereas every shortcut that treats the number as a flag turns "off" back
  // into the 120 s default.
  const value = String(providerIdleTimeoutMs);

  return (
    <SettingsSectionBlock
      title={t('Model request timeout')}
      description={t(
        'Give up an attempt and retry when nothing arrives for this long after the connection opens. Off waits indefinitely.'
      )}
    >
      <SettingsRow>
        <span className="text-ui">{t('Idle timeout')}</span>
        <div className="min-w-0 space-y-2">
          <Select
            value={value}
            onValueChange={(next) => {
              // The picker only ever emits its own option values, but they
              // arrive as strings; `readProviderIdleTimeoutMs` is the one
              // parser that knows `'0'` is a value and `''` is not.
              setProviderIdleTimeoutMs(
                readProviderIdleTimeoutMs(next, DEFAULT_PROVIDER_IDLE_TIMEOUT_MS)
              );
            }}
          >
            <SelectTrigger className="w-48">
              <SelectValue>{idleTimeoutLabel(providerIdleTimeoutMs, t)}</SelectValue>
            </SelectTrigger>
            <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
              {PROVIDER_IDLE_TIMEOUT_CHOICES.map((choice) => (
                <SelectItem key={choice} value={String(choice)}>
                  {idleTimeoutLabel(choice, t)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-meta text-muted-foreground">
            {t('Takes effect the next time a conversation starts its runtime.')}
          </p>
        </div>
      </SettingsRow>
    </SettingsSectionBlock>
  );
}

/**
 * Rung labels. `0` is worded ("Off"), never printed as `0 ms`.
 *
 * One case per rung rather than a formatter, so each label is a catalog key a
 * translator can see. The `default` is not dead code: the stored value is a
 * plain number in a JSON file a user can edit, and an off-ladder value is
 * reported as the seconds it actually is instead of being rounded onto a rung
 * it is not.
 */
function idleTimeoutLabel(idleTimeoutMs: number, t: Translate): string {
  switch (idleTimeoutMs) {
    case PROVIDER_IDLE_TIMEOUT_DISABLED:
      return t('Off');
    case 30_000:
      return t('30 seconds');
    case 60_000:
      return t('1 minute');
    case 120_000:
      return t('2 minutes');
    case 300_000:
      return t('5 minutes');
    default:
      return `${Math.round(idleTimeoutMs / 1000)}s`;
  }
}
