/**
 * Settings → Plugins (plugin-system README §3, preview.html approved 2026-10-23).
 *
 * PiLab's own plugins: extra features installed from a `.pilabplug`, each
 * running in its own process. Not the chat engine's plugins, which live under
 * Extensions. One card per plugin: name, version, what it reports, one switch;
 * opened, its settings, what it may do, where it connects, its services, and
 * uninstall. A fresh install is off, and switching one on first shows what it
 * asks for.
 */

import type { PluginPermission } from '@shared/plugins/manifest';
import type { PluginSettingView, PluginView } from '@shared/plugins/view';
import { ChevronRight, Globe, RefreshCw, TriangleAlert, Upload } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { type RunStatus, StatusIcon } from '@/components/ui/status-icon';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { SETTINGS_CARD_FRAME_CLASS, SettingsRow } from './SettingsPrimitives';

type Translate = ReturnType<typeof useI18n>['t'];

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function permissionLabel(permission: PluginPermission, t: Translate): string {
  return permission === 'chat.read'
    ? t('Read conversations')
    : t('Change conversations (send, approve, stop)');
}

/** What the card's status line shows: the plugin's own line while it runs, ours otherwise. */
export function pluginStatusLine(
  plugin: PluginView,
  t: Translate
): { status: RunStatus; text: string } {
  if (plugin.state === 'failed') {
    return {
      status: 'failed',
      text:
        plugin.restartCount > 0
          ? t('Failed · retried {{count}} times', { count: plugin.restartCount })
          : t('Failed'),
    };
  }
  if (plugin.state === 'starting') return { status: 'running', text: t('Starting…') };
  if (plugin.state === 'stopped') {
    return plugin.enabled && plugin.restartCount > 0
      ? { status: 'waiting', text: t('Restarting…') }
      : { status: 'idle', text: plugin.enabled ? t('Stopped') : t('Off') };
  }
  const own = plugin.status;
  const status: RunStatus =
    own?.state === 'error'
      ? 'failed'
      : own?.state === 'warning'
        ? 'waiting'
        : own?.state === 'idle'
          ? 'idle'
          : 'success';
  return { status, text: own?.text || t('Running') };
}

function PluginSettingField({
  pluginId,
  view,
  onError,
}: {
  pluginId: string;
  view: PluginSettingView;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const { setting, value } = view;
  const labelId = useId();
  const [draft, setDraft] = useState(value === undefined || value === null ? '' : String(value));
  const [editingSecret, setEditingSecret] = useState(false);

  useEffect(() => {
    if (!setting.secret) setDraft(value === undefined || value === null ? '' : String(value));
  }, [setting.secret, value]);

  const save = (next: unknown) => {
    window.electronAPI.plugins
      .setSetting(pluginId, setting.key, next)
      .catch((cause: unknown) => onError(messageOf(cause)));
  };
  const commitText = () => {
    if (setting.type === 'number') {
      if (draft.trim() === '') return save(null);
      const parsed = Number(draft);
      if (!Number.isFinite(parsed))
        return onError(t('{{name}} needs a number', { name: setting.title }));
      return save(parsed);
    }
    save(draft);
  };

  let control: ReactNode;
  if (setting.secret) {
    control = editingSecret ? (
      <Input
        type="password"
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft) save(draft);
          setDraft('');
          setEditingSecret(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft('');
            setEditingSecret(false);
          }
        }}
        aria-labelledby={labelId}
        className="w-64"
      />
    ) : (
      <div className="flex min-w-0 items-center gap-1">
        <span className="text-ui text-muted-foreground">{value ? t('Set') : t('Not set')}</span>
        <Button variant="ghost" size="sm" onClick={() => setEditingSecret(true)}>
          {value ? t('Change') : t('Fill in')}
        </Button>
        {value === true && (
          <Button variant="ghost" size="sm" onClick={() => save(null)}>
            {t('Clear')}
          </Button>
        )}
      </div>
    );
  } else if (setting.type === 'boolean') {
    control = (
      <Switch
        checked={value === true}
        onCheckedChange={(checked) => save(checked)}
        aria-labelledby={labelId}
      />
    );
  } else if (setting.type === 'select') {
    const options = setting.options ?? [];
    const current = options.find((option) => option.value === value);
    control = (
      <Select
        value={current ? String(current.value) : ''}
        onValueChange={(next) => {
          const option = options.find((candidate) => String(candidate.value) === next);
          if (option) save(option.value);
        }}
      >
        <SelectTrigger className="w-64" aria-labelledby={labelId}>
          <SelectValue>{current?.label ?? ''}</SelectValue>
        </SelectTrigger>
        <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
          {options.map((option) => (
            <SelectItem key={String(option.value)} value={String(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  } else {
    control = (
      <Input
        value={draft}
        inputMode={setting.type === 'number' ? 'decimal' : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitText}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        aria-labelledby={labelId}
        className="w-64"
      />
    );
  }

  return (
    <SettingsRow>
      <span id={labelId} className="text-ui font-medium">
        {setting.title}
      </span>
      <div className="min-w-0 space-y-1">
        {control}
        {setting.description && (
          <p className="text-small text-muted-foreground">{setting.description}</p>
        )}
      </div>
    </SettingsRow>
  );
}

function PluginCard({
  plugin,
  busy,
  onToggle,
  onRestart,
  onUninstall,
  onError,
}: {
  plugin: PluginView;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRestart: () => void;
  onUninstall: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const nameId = useId();
  const [open, setOpen] = useState(plugin.state === 'failed');
  const line = pluginStatusLine(plugin, t);

  useEffect(() => {
    if (plugin.state === 'failed') setOpen(true);
  }, [plugin.state]);

  return (
    <li className="min-w-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 items-start gap-3 p-3">
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-start gap-2 text-left"
            aria-label={
              open
                ? t('Collapse {{name}}', { name: plugin.name })
                : t('Expand {{name}}', { name: plugin.name })
            }
          >
            <ChevronRight
              className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
            />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span id={nameId} className="min-w-0 truncate text-ui font-semibold">
                  {plugin.name}
                </span>
                <span className="shrink-0 text-small tabular-nums text-muted-foreground">
                  {plugin.version} · {plugin.id}
                </span>
              </div>
              {plugin.description && (
                <p className="text-small text-muted-foreground">{plugin.description}</p>
              )}
              <div className="flex min-w-0 items-center gap-1.5 text-small text-muted-foreground">
                <StatusIcon status={line.status} />
                <span className="min-w-0 flex-1 truncate">{line.text}</span>
              </div>
            </div>
          </CollapsibleTrigger>
          <Switch
            checked={plugin.enabled}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-labelledby={nameId}
            className="mt-0.5"
          />
        </div>
        <CollapsiblePanel>
          <div className="space-y-4 border-t border-border-soft px-4 py-3">
            {plugin.state === 'failed' && plugin.lastError && (
              <Alert variant="error" role="alert">
                <TriangleAlert />
                <AlertDescription className="break-words">
                  {plugin.restartCount >= 5
                    ? t('Stopped after {{count}} restarts. Last error: {{error}}', {
                        count: plugin.restartCount,
                        error: plugin.lastError,
                      })
                    : t('Last error: {{error}}', { error: plugin.lastError })}
                </AlertDescription>
              </Alert>
            )}
            {plugin.settings.length > 0 && (
              <div className="space-y-3">
                <h4 className="text-small font-semibold text-muted-foreground">{t('Settings')}</h4>
                {plugin.settings.map((view) => (
                  <PluginSettingField
                    key={view.setting.key}
                    pluginId={plugin.id}
                    view={view}
                    onError={onError}
                  />
                ))}
              </div>
            )}
            <div className="space-y-1.5">
              <h4 className="text-small font-semibold text-muted-foreground">{t('Permissions')}</h4>
              <div className="flex flex-wrap gap-1.5">
                {plugin.permissions.length === 0 ? (
                  <span className="text-small text-muted-foreground">{t('None')}</span>
                ) : (
                  plugin.permissions.map((permission) => (
                    <Badge key={permission} variant="secondary">
                      {permissionLabel(permission, t)}
                    </Badge>
                  ))
                )}
              </div>
            </div>
            {plugin.netHosts.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-small font-semibold text-muted-foreground">{t('Network')}</h4>
                <div className="flex flex-wrap gap-1.5">
                  {plugin.netHosts.map((host) => (
                    <Badge key={host} variant="secondary">
                      <Globe />
                      {host}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {plugin.services.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-small font-semibold text-muted-foreground">{t('Services')}</h4>
                <div className="flex flex-wrap gap-1.5">
                  {plugin.services.map((service) => (
                    <Badge key={service.id} variant="secondary">
                      <StatusIcon
                        status={
                          service.state === 'running'
                            ? 'success'
                            : service.state === 'failed'
                              ? 'failed'
                              : 'idle'
                        }
                      />
                      {service.title ?? service.id} ·{' '}
                      {service.state === 'running'
                        ? t('Running')
                        : service.state === 'failed'
                          ? t('Failed')
                          : t('Stopped')}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2 border-t border-border-soft pt-3">
              {plugin.state === 'failed' && plugin.enabled && (
                <Button variant="outline" size="sm" disabled={busy} onClick={onRestart}>
                  <RefreshCw />
                  {t('Restart')}
                </Button>
              )}
              <Button variant="destructive-outline" size="sm" disabled={busy} onClick={onUninstall}>
                {t('Uninstall')}
              </Button>
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

export function PluginsSettings() {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState<PluginView | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<PluginView | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pushed = false;
    const unsubscribe = window.electronAPI.plugins.onChanged((next) => {
      if (cancelled) return;
      pushed = true;
      setPlugins(next);
    });
    window.electronAPI.plugins.list().then(
      (next) => {
        if (!cancelled && !pushed) setPlugins(next);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      }
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const run = async (id: string, work: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusyId(null);
    }
  };

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      const result = await window.electronAPI.plugins.pickAndInstall();
      if (result && !result.ok)
        setError(t('Could not install: {{error}}', { error: result.error }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-start gap-3 px-1">
        <p className="min-w-0 flex-1 text-ui text-muted-foreground">
          {t(
            'Extra features that are not in the installer, installed from a .pilabplug file. Each plugin runs in its own process and cannot read your model keys. The chat engine’s plugins are under Extensions.'
          )}
        </p>
        <Button variant="outline" disabled={installing} onClick={() => void install()}>
          <Upload />
          {t('Install from file…')}
        </Button>
      </div>

      {error && (
        <Alert variant="error" role="alert">
          <TriangleAlert />
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      {plugins && plugins.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Upload />
            </EmptyMedia>
            <EmptyTitle>{t('No plugins installed')}</EmptyTitle>
            <EmptyDescription>
              {t('Plugins are .pilabplug files. Use “Install from file…” above.')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {plugins && plugins.length > 0 && (
        <ul className={SETTINGS_CARD_FRAME_CLASS}>
          {plugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              busy={busyId === plugin.id}
              onToggle={(enabled) => {
                if (enabled) setConfirmEnable(plugin);
                else
                  void run(plugin.id, () =>
                    window.electronAPI.plugins.setEnabled(plugin.id, false)
                  );
              }}
              onRestart={() =>
                void run(plugin.id, () => window.electronAPI.plugins.setEnabled(plugin.id, true))
              }
              onUninstall={() => setConfirmUninstall(plugin)}
              onError={setError}
            />
          ))}
        </ul>
      )}

      <AlertDialog
        open={confirmEnable !== null}
        onOpenChange={(open) => !open && setConfirmEnable(null)}
      >
        <AlertDialogPopup className="sm:max-w-md" zIndexLevel="nested">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Turn on “{{name}}”?', { name: confirmEnable?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription render={<div />}>
              <p>{t('It will run in its own process and can:')}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {(confirmEnable?.permissions ?? []).map((permission) => (
                  <li key={permission}>{permissionLabel(permission, t)}</li>
                ))}
                {(confirmEnable?.netHosts ?? []).map((host) => (
                  <li key={host}>{t('Connect to {{host}}', { host })}</li>
                ))}
                {confirmEnable &&
                  confirmEnable.permissions.length === 0 &&
                  confirmEnable.netHosts.length === 0 && (
                    <li>{t('Nothing beyond its own settings')}</li>
                  )}
              </ul>
              <p className="mt-2">{t('Only turn on plugins you trust.')}</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              onClick={() => {
                const plugin = confirmEnable;
                setConfirmEnable(null);
                if (plugin)
                  void run(plugin.id, () => window.electronAPI.plugins.setEnabled(plugin.id, true));
              }}
            >
              {t('Turn on')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmEnable(null)}>
              {t('Cancel')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={confirmUninstall !== null}
        onOpenChange={(open) => !open && setConfirmUninstall(null)}
      >
        <AlertDialogPopup className="sm:max-w-md" zIndexLevel="nested">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Uninstall “{{name}}”?', { name: confirmUninstall?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('Its files, its data and its settings are deleted.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="destructive"
              onClick={() => {
                const plugin = confirmUninstall;
                setConfirmUninstall(null);
                if (plugin)
                  void run(plugin.id, () => window.electronAPI.plugins.uninstall(plugin.id));
              }}
            >
              {t('Uninstall')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmUninstall(null)}>
              {t('Cancel')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
