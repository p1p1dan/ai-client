/**
 * H/19 U4 — the "Plugins" section of the Pi settings page.
 *
 * Four operations, three of which are pi's own CLI (`install` / `remove` /
 * `list`) and one of which flips an `autoload` flag. There is no plugin market,
 * no version list and no disabled-packages directory: see `@shared/piPlugins`.
 *
 * `install` reaches the npm registry, so it is async with a visible pending
 * state and the CLI's own failure text — never a spinner that ends in silence.
 */

import {
  type PiPluginCommandResult,
  type PiPluginState,
  type PiPluginView,
  PROJECT_SCOPE_UNAVAILABLE,
} from '@shared/piPlugins';
import { AlertTriangle, Blocks, Download, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { SettingsSectionBlock } from './SettingsPrimitives';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function PiPluginsSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<PiPluginState | null>(null);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await window.electronAPI.piPlugins.list());
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * One runner for all three mutations.
   *
   * `install` and `remove` answer with `{ok, output}` rather than throwing, so
   * a failure has to be read off the result — an unchecked call here would
   * report "installed" for a package npm refused.
   */
  const act = async (label: string, run: () => Promise<PiPluginCommandResult | undefined>) => {
    setBusy(label);
    setError(null);
    try {
      const result = await run();
      if (result && !result.ok) setError(result.output);
      await load();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    await act('install', () => window.electronAPI.piPlugins.install(trimmed));
    setSource('');
  };

  const plugins = state?.plugins ?? [];

  return (
    <div className="space-y-4">
      <SettingsSectionBlock
        title={t('Plugins')}
        description={t(
          'Extensions installed for your account. They run inside the agent process and can add tools, skills and commands.'
        )}
      />

      {state && <PermissionSystemNotice owner={state.permissionSystem} />}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={source}
          onChange={(event) => setSource(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void install();
          }}
          placeholder={t('npm:package-name, a git URL, or a folder path')}
          disabled={busy !== null}
          className="min-w-0 flex-1"
          aria-label={t('Package source')}
        />
        <Button onClick={() => void install()} disabled={busy !== null || !source.trim()}>
          <Download className="h-4 w-4" />
          {busy === 'install' ? t('Installing...') : t('Install')}
        </Button>
      </div>
      <p className="text-meta text-muted-foreground">
        {t('Installing downloads from the network and can take a few seconds.')}
        {state && !state.projectScopeAvailable && ` ${t(PROJECT_SCOPE_UNAVAILABLE)}`}
      </p>

      {state?.error && (
        <p className="flex gap-2 rounded-sm border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t('Installed plugins could not be listed:')} {state.error}
        </p>
      )}

      {!state ? (
        <p className="text-ui text-muted-foreground">{t('Loading plugins...')}</p>
      ) : plugins.length === 0 && !state.error ? (
        <Empty className="rounded-md border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Blocks className="h-5 w-5" />
            </EmptyMedia>
            <EmptyTitle>{t('No plugins installed')}</EmptyTitle>
            <EmptyDescription>
              {t('Install one by package name to add tools or commands to your sessions.')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y rounded-md border">
          {plugins.map((plugin) => (
            <PluginRow
              key={plugin.source}
              plugin={plugin}
              busy={busy !== null}
              onToggle={(enabled) =>
                act(plugin.source, async () => {
                  // Returns nothing: unlike install/remove it either saves or
                  // throws, so there is no `{ok:false}` to read.
                  await window.electronAPI.piPlugins.setEnabled(plugin.source, enabled);
                  return undefined;
                })
              }
              onRemove={() =>
                act(plugin.source, () => window.electronAPI.piPlugins.remove(plugin.source))
              }
            />
          ))}
        </ul>
      )}

      {state && (
        <div className="grid gap-1 text-meta text-muted-foreground sm:grid-cols-[100px_1fr] sm:gap-3">
          <span>{t('Settings file')}</span>
          <Ident className="min-w-0 break-all">{state.settingsPath}</Ident>
        </div>
      )}

      {error && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-sm border border-destructive/30 bg-destructive/8 p-3 text-meta text-destructive">
          {error}
        </pre>
      )}
    </div>
  );
}

function PluginRow({
  plugin,
  busy,
  onToggle,
  onRemove,
}: {
  plugin: PiPluginView;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className={cn('flex items-center gap-3 p-3', !plugin.enabled && 'text-muted-foreground')}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-ui font-medium">{plugin.name}</span>
          {!plugin.enabled && <Badge variant="secondary">{t('Off')}</Badge>}
        </div>
        <p className="truncate text-meta text-muted-foreground">{plugin.source}</p>
        {plugin.path && <p className="truncate text-meta text-muted-foreground">{plugin.path}</p>}
      </div>
      <Switch
        checked={plugin.enabled}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={t('Enabled')}
      />
      <Button
        variant="ghost"
        size="icon"
        disabled={busy}
        aria-label={t('Remove')}
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

/**
 * Who is approving tool calls.
 *
 * Shown always, not only when it is the user's own copy: "the app's own" is
 * information too, and a notice that appears only in the unusual case is one
 * nobody knows to look for. H/19 made plugin conflicts the user's
 * responsibility — this line is what makes that a fair deal.
 */
function PermissionSystemNotice({ owner }: { owner: PiPluginState['permissionSystem'] }) {
  const { t } = useI18n();
  if (owner === 'unknown') {
    return (
      <div className="flex gap-3 rounded-md border border-warning/30 bg-warning/10 p-3 text-ui text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        {t(
          'This app could not read its plugin settings, so it cannot say which permission system approves tool calls.'
        )}
      </div>
    );
  }
  const own = owner === 'user_configured';
  return (
    <div
      className={cn(
        'flex gap-3 rounded-md border p-3 text-ui',
        own ? 'border-warning/30 bg-warning/10 text-warning' : 'border-info/30 bg-info/10 text-info'
      )}
    >
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {own
          ? t(
              'Tool approval is handled by the permission system you installed yourself. This app steps aside, and its approval settings do not apply.'
            )
          : t('Tool approval is handled by the permission system this app ships.')}
      </span>
    </div>
  );
}
