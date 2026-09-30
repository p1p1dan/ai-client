/**
 * dsh-rebase P1-10c — Settings → Extensions → Plugins (topic §4.4; decisions
 * 108, 110, 115 and 117).
 *
 * The allowlisted DSH plugins this build ships, one row each: name, version,
 * what it does, where it comes from, what its tools may do (a tool that writes
 * files is flagged so it cannot be missed), when it was reviewed, and one
 * switch. There is no install box and no remove button: plugins are reviewed
 * and preinstalled with the app (decisions 058, 059).
 *
 * The switch stores a per-plugin override; the chat engine composes plugins
 * once per start, so the change applies at its next start, and a running
 * engine restarts on its own once no chat has work in progress (decision 108
 * rule 7). The page says so and never claims the change is live. What the
 * engine actually did at its last start is shown per row (loaded, off,
 * missing, refused and why); plugins it no longer ships are listed apart.
 *
 * P1-7e e5 (decision 143): the page follows the engine. Main pushes the whole
 * state after every engine start (`dshPlugins.onChanged`), so the restart a
 * switch caused shows up here — badge and notice — without reopening the page.
 */

import type { DshPluginsState, DshPluginView } from '@shared/dshPluginSettings';
import {
  Blocks,
  CircleHelp,
  FilePen,
  FileSearch,
  PackageX,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Ident } from '@/components/ui/ident';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { SettingsSectionBlock } from './SettingsPrimitives';

type Translate = ReturnType<typeof useI18n>['t'];

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Our own translated one-line summary of each allowlisted plugin; the
 * package's English description is the fallback. Each summary is a literal
 * translation call, so the catalog coverage scan sees it, and
 * `dshPluginsSettingsStatic.test.ts` requires a case for every allowlist
 * entry.
 */
function pluginSummary(plugin: DshPluginView, t: Translate): string {
  switch (plugin.name) {
    case 'dsh-office-tools':
      return t('Create, read and update Word, Excel and PowerPoint files in the workspace.');
    default:
      return plugin.description;
  }
}

function HostStateBadge({ plugin }: { plugin: DshPluginView }) {
  const { t } = useI18n();
  const host = plugin.host;
  if (!host) return null;
  switch (host.state) {
    case 'loaded':
      return (
        <Badge variant={host.inactiveRows?.length ? 'warning' : 'success'}>{t('Loaded')}</Badge>
      );
    case 'disabled':
      return <Badge variant="secondary">{t('Switched off')}</Badge>;
    case 'missing':
      return <Badge variant="error">{t('Missing from the install')}</Badge>;
    case 'rejected':
      return <Badge variant="error">{t('Refused to load')}</Badge>;
    default:
      return null;
  }
}

function ToolLine({
  icon: Icon,
  label,
  tools,
  variant,
}: {
  icon: typeof FilePen;
  label: string;
  tools: string[];
  variant: 'warning' | 'outline';
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Badge variant={variant}>
        <Icon />
        {label}
      </Badge>
      {tools.length > 0 && (
        <Ident className="min-w-0 break-all text-muted-foreground">{tools.join(', ')}</Ident>
      )}
    </div>
  );
}

function PluginRow({
  plugin,
  busy,
  onToggle,
}: {
  plugin: DshPluginView;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const nameId = useId();
  const host = plugin.host;
  const reason = host && host.state !== 'loaded' && host.reason ? host.reason : null;
  const summary = pluginSummary(plugin, t);
  return (
    <li className="flex min-w-0 items-start gap-3 p-3">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span id={nameId} className="min-w-0 truncate text-ui font-semibold">
            {plugin.name}
          </span>
          <span className="shrink-0 text-meta tabular-nums text-muted-foreground">
            {plugin.version}
          </span>
          <HostStateBadge plugin={plugin} />
          {plugin.pendingRestart && (
            <Badge variant="info">
              <RefreshCw />
              {t('Restart pending')}
            </Badge>
          )}
        </div>
        {summary && <p className="text-meta text-muted-foreground">{summary}</p>}
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-meta text-muted-foreground">
          <span>
            {plugin.kind === 'official'
              ? t('Official DSH plugin')
              : t('Third-party plugin, reviewed by this app')}
          </span>
          {plugin.review && (
            <span className="tabular-nums">
              {plugin.review.verdict === 'approved'
                ? t('Reviewed {{date}}: approved', { date: plugin.review.date })
                : t('Reviewed {{date}}: approved with conditions', { date: plugin.review.date })}
            </span>
          )}
        </div>
        <div className="space-y-1">
          {plugin.writeTools.length > 0 && (
            <ToolLine
              icon={FilePen}
              label={t('Writes files')}
              tools={plugin.writeTools}
              variant="warning"
            />
          )}
          {plugin.readTools.length > 0 && (
            <ToolLine
              icon={FileSearch}
              label={t('Reads files')}
              tools={plugin.readTools}
              variant="outline"
            />
          )}
          {(plugin.askTools.length > 0 || plugin.unlistedToolsAsk) && (
            <ToolLine
              icon={CircleHelp}
              label={t('Other tools, always ask first')}
              tools={plugin.askTools}
              variant="outline"
            />
          )}
        </div>
        {reason && (
          <p
            className={cn(
              'break-words text-meta',
              host?.state === 'disabled' ? 'text-muted-foreground' : 'text-destructive'
            )}
          >
            {t('Reason: {{reason}}', { reason })}
          </p>
        )}
        {host?.state === 'loaded' && host.inactiveRows && host.inactiveRows.length > 0 && (
          <p className="break-words text-meta text-warning">
            {t('Loaded, but part of it did not start: {{rows}}', {
              rows: host.inactiveRows.join(', '),
            })}
          </p>
        )}
      </div>
      {/* Not wrapped in a <label>: base-ui's switch is a span plus a hidden
          checkbox, and a wrapping label forwards the click onto that input
          again (two toggles per click, or none in tests). Named by
          aria-labelledby, like every Settings switch. */}
      <Switch
        checked={plugin.enabled}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-labelledby={nameId}
        className="mt-0.5"
      />
    </li>
  );
}

function Callout({ tone, children }: { tone: 'info' | 'warning' | 'error'; children: ReactNode }) {
  const Icon = tone === 'info' ? RefreshCw : TriangleAlert;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex gap-3 rounded-md border p-3 text-ui',
        tone === 'info' && 'border-info/30 bg-info/8 text-info',
        tone === 'warning' && 'border-warning/30 bg-warning/8 text-warning',
        tone === 'error' && 'border-destructive/30 bg-destructive/8 text-destructive'
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

export function DshPluginsSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<DshPluginsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // A push is newer than any answer to the read below still on its way.
    let pushed = false;
    const unsubscribe = window.electronAPI.dshPlugins.onChanged((next) => {
      if (cancelled) return;
      pushed = true;
      setState(next);
      setLoadError(null);
      // The engine has reported on the selection as it stands now; from here
      // on each row's own `pendingRestart` says what is still waiting.
      if (next.hostReported) setChanged(false);
    });
    window.electronAPI.dshPlugins.list().then(
      (next) => {
        if (!cancelled && !pushed) setState(next);
      },
      (cause: unknown) => {
        if (!cancelled && !pushed) setLoadError(messageOf(cause));
      }
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const toggle = async (name: string, enabled: boolean) => {
    setBusy(true);
    setSaveError(null);
    try {
      setState(await window.electronAPI.dshPlugins.setEnabled(name, enabled));
      setChanged(true);
    } catch (cause) {
      setSaveError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const plugins = state?.plugins ?? [];
  const pending = changed || plugins.some((plugin) => plugin.pendingRestart);

  return (
    <SettingsSectionBlock
      title={t('Plugins')}
      description={t(
        'Plugins reviewed by this app and installed with it. Nothing is downloaded, and plugins cannot be added or removed here. Tools a plugin adds go through this app’s approval like the built-in tools.'
      )}
    >
      {loadError ? (
        <Callout tone="error">{loadError}</Callout>
      ) : !state ? (
        <p className="text-ui text-muted-foreground">{t('Loading plugins...')}</p>
      ) : (
        <div className="space-y-4">
          {state.catalogError && (
            <Callout tone="error">
              {t('The plugin list could not be read: {{error}}', { error: state.catalogError })}
            </Callout>
          )}
          {state.selectionInvalid && (
            <Callout tone="warning">
              {t(
                'The chat engine could not read the plugin settings when it last started, so it loaded no plugin.'
              )}
            </Callout>
          )}
          {pending && (
            <Callout tone="info">
              {t(
                'Plugin changes take effect the next time the chat engine starts. If it is running, it restarts on its own once no chat has work in progress.'
              )}
            </Callout>
          )}
          {saveError && <Callout tone="error">{saveError}</Callout>}

          {plugins.length === 0 && !state.catalogError ? (
            <Empty className="rounded-md border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Blocks className="h-5 w-5" />
                </EmptyMedia>
                <EmptyTitle>{t('No plugins available')}</EmptyTitle>
                <EmptyDescription>{t('This version ships without any plugins.')}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            plugins.length > 0 && (
              <ul className="divide-y rounded-md border">
                {plugins.map((plugin) => (
                  <PluginRow
                    key={plugin.name}
                    plugin={plugin}
                    busy={busy}
                    onToggle={(enabled) => void toggle(plugin.name, enabled)}
                  />
                ))}
              </ul>
            )
          )}

          {plugins.length > 0 && !state.hostReported && (
            <p className="text-meta text-muted-foreground">
              {t(
                'The chat engine has not started since the app opened, so what it loaded is not shown yet.'
              )}
            </p>
          )}

          {state.delisted.length > 0 && (
            <div className="space-y-2">
              <div className="space-y-1">
                <h4 className="text-ui font-semibold">{t('No longer available')}</h4>
                <p className="text-meta text-muted-foreground">
                  {t('This version no longer ships these plugins, so they are not loaded.')}
                </p>
              </div>
              <ul className="space-y-1">
                {state.delisted.map((item) => (
                  <li key={item.name} className="flex min-w-0 items-start gap-2">
                    <PackageX className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <Ident className="break-all">{item.name}</Ident>
                      {item.reason && (
                        <p className="break-words text-meta text-muted-foreground">
                          {t('Reason: {{reason}}', { reason: item.reason })}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </SettingsSectionBlock>
  );
}
