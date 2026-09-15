/**
 * H/19 U4 — the "Plugins" section of the Pi settings page.
 *
 * Four operations, three of which are pi's own CLI (`install` / `remove` /
 * `list`) and one of which flips an `autoload` flag. There is no plugin market,
 * no version list and no disabled-packages directory: see `@shared/piPlugins`.
 *
 * `install` reaches the npm registry, so it is async with a visible pending
 * state and the CLI's own failure text — never a spinner that ends in silence.
 *
 * ## What these extensions reach (cutover-02 / cutover-03)
 *
 * The built-in Pi terminal, and nothing else. P6-5 retired the engine that
 * loaded pi extensions into a chat, so the page says that in two places — the
 * section description and the approval notice — rather than leaving someone to
 * conclude it from a sidebar panel that never names what they installed.
 */

import {
  type PermissionSystemOwner,
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
          'Extensions installed for your account. Only the built-in Pi terminal loads them; chats in this app do not.'
        )}
      />

      <PermissionSystemNotice owner={state?.terminalPermissionSystem} />

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
 * Who approves tool calls, and where an installed permission system reaches.
 *
 * cutover-02: this used to read "this app steps aside, and its approval
 * settings do not apply" whenever the agent directory declared a permission
 * extension. That was never true after P6-5 — a chat is approved by
 * `src/runtime/plugins/permissions/` whatever is installed — and it told users
 * their own deny rules were in force when they were not.
 *
 * The first line is unconditional, because "ours, always" is the fact people
 * come here to check. The second appears only when the user really does have
 * their own copy, and says the one place it does apply: the built-in terminal,
 * which runs the real pi CLI and loads whatever the agent directory declares.
 */
function PermissionSystemNotice({ owner }: { owner: PermissionSystemOwner | undefined }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex gap-3 rounded-md border border-info/30 bg-info/10 p-3 text-ui text-info">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1">
          {t('This app approves tool calls with its own permission system in every chat.')}
        </span>
      </div>
      {(owner === 'user_configured' || owner === 'unknown') && (
        <div className="flex gap-3 rounded-md border border-warning/30 bg-warning/10 p-3 text-ui text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {owner === 'user_configured'
              ? t(
                  'The pi permission system you installed applies to the built-in terminal only, not to chats in this app.'
                )
              : t(
                  'This app could not read its plugin settings, so it cannot say which permission system the built-in terminal runs.'
                )}
          </span>
        </div>
      )}
    </div>
  );
}
