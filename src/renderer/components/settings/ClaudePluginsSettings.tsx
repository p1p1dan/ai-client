/**
 * docs/plantree/plans/claude-plugins §3.3 — Settings → Extensions → Claude
 * plugins (user 2026-10-29: on the Extensions page, the official marketplace
 * not preset). What Claude chats load from the user layer, plus what the open
 * repository declares (read-only). Every change is one bundled-CLI command in
 * Main; new Claude chats get it, open ones at their next start.
 *
 * A row says what the plugin brings; hooks and MCP servers run programs on
 * this machine, so they are flagged like the Pi plugins' "Writes files".
 */

import {
  CLAUDE_OFFICIAL_MARKETPLACE,
  type ClaudeAvailablePlugin,
  type ClaudeCliResult,
  type ClaudePluginComponents,
  type ClaudePluginsState,
  type ClaudePluginView,
} from '@shared/claudePlugins';
import {
  Bot,
  Download,
  Library,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  Slash,
  SquareTerminal,
  Store,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react';
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
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import {
  SETTINGS_CARD_FRAME_CLASS,
  SettingsHelpTip,
  SettingsSectionBlock,
} from './SettingsPrimitives';

type Translate = ReturnType<typeof useI18n>['t'];

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Design system v2 §7.7: the one notice is coss's `Alert`. */
export function ClaudeCallout({ tone, children }: { tone: 'info' | 'error'; children: ReactNode }) {
  const Icon = tone === 'info' ? RefreshCw : TriangleAlert;
  return (
    <Alert variant={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon />
      <AlertDescription className="break-words whitespace-pre-line">{children}</AlertDescription>
    </Alert>
  );
}

export function ComponentBadges({ components }: { components: ClaudePluginComponents }) {
  const { t } = useI18n();
  const items: ReactNode[] = [];
  if (components.skills > 0) {
    items.push(
      <Badge key="skills" variant="outline">
        <Library />
        {t('Skills {{count}}', { count: components.skills })}
      </Badge>
    );
  }
  if (components.commands > 0) {
    items.push(
      <Badge key="commands" variant="outline">
        <Slash />
        {t('Commands {{count}}', { count: components.commands })}
      </Badge>
    );
  }
  if (components.agents > 0) {
    items.push(
      <Badge key="agents" variant="outline">
        <Bot />
        {t('Subagents {{count}}', { count: components.agents })}
      </Badge>
    );
  }
  if (components.hooks > 0) {
    items.push(
      <Badge key="hooks" variant="warning">
        <SquareTerminal />
        {t('Hooks {{count}} · run commands', { count: components.hooks })}
      </Badge>
    );
  }
  if (components.mcpServers > 0) {
    items.push(
      <Badge key="mcp" variant="warning">
        <Server />
        {t('MCP servers {{count}} · start programs', { count: components.mcpServers })}
      </Badge>
    );
  }
  return items.length > 0 ? <div className="flex flex-wrap gap-1.5">{items}</div> : null;
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function PluginRow({
  plugin,
  busy,
  onToggle,
  onUpdate,
  onUninstall,
}: {
  plugin: ClaudePluginView;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onUpdate: () => void;
  onUninstall: () => void;
}) {
  const { t } = useI18n();
  const nameId = useId();
  const declared = plugin.scope !== 'user';
  return (
    <li className="flex min-w-0 items-start gap-3 p-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span id={nameId} className="min-w-0 truncate text-ui font-semibold">
            {plugin.name}
          </span>
          {plugin.version && (
            <span className="shrink-0 text-small tabular-nums text-muted-foreground">
              {plugin.version}
            </span>
          )}
          {declared && <Badge variant="info">{t('Declared by the repository')}</Badge>}
          {!plugin.enabled && <Badge variant="secondary">{t('Switched off')}</Badge>}
        </div>
        {plugin.description && (
          <p className="break-words text-small text-muted-foreground">{plugin.description}</p>
        )}
        <p className="min-w-0 text-small text-muted-foreground">
          {declared ? (
            t('Change it in the repository’s .claude/settings.json')
          ) : (
            <>
              {t('From marketplace')}{' '}
              <Ident className="text-muted-foreground">{plugin.marketplace}</Ident>
            </>
          )}
        </p>
        <ComponentBadges components={plugin.components} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!declared && (
          <>
            <IconAction label={t('Check for updates')} disabled={busy} onClick={onUpdate}>
              <RefreshCw />
            </IconAction>
            <IconAction label={t('Uninstall')} disabled={busy} onClick={onUninstall}>
              <Trash2 />
            </IconAction>
          </>
        )}
        {/* Named by aria-labelledby, like every Settings switch (no wrapping label). */}
        <Switch
          checked={plugin.enabled}
          disabled={busy || declared}
          onCheckedChange={onToggle}
          aria-labelledby={nameId}
          className="ms-1"
        />
      </div>
    </li>
  );
}

function formatCount(count: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    count
  );
}

function BrowseDialog({
  open,
  onOpenChange,
  marketplaces,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplaces: string[];
  onInstalled: () => void;
}) {
  const { t, locale } = useI18n();
  const [plugins, setPlugins] = useState<ClaudeAvailablePlugin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [marketplace, setMarketplace] = useState<string>('');
  const [query, setQuery] = useState('');
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPlugins(null);
    setLoadError(null);
    window.electronAPI.claudePlugins.available().then(
      (next) => !cancelled && setPlugins(next),
      (cause: unknown) => !cancelled && setLoadError(messageOf(cause))
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  const current = marketplace && marketplaces.includes(marketplace) ? marketplace : marketplaces[0];
  const counts = useMemo(() => {
    const byMarketplace = new Map<string, number>();
    for (const plugin of plugins ?? []) {
      byMarketplace.set(plugin.marketplace, (byMarketplace.get(plugin.marketplace) ?? 0) + 1);
    }
    return byMarketplace;
  }, [plugins]);
  const needle = query.trim().toLowerCase();
  const rows = (plugins ?? []).filter(
    (plugin) =>
      plugin.marketplace === current &&
      (!needle ||
        plugin.name.toLowerCase().includes(needle) ||
        plugin.description.toLowerCase().includes(needle))
  );

  const install = async (plugin: ClaudeAvailablePlugin) => {
    setInstalling((set) => new Set(set).add(plugin.id));
    setFailures(({ [plugin.id]: _, ...rest }) => rest);
    let result: ClaudeCliResult;
    try {
      result = await window.electronAPI.claudePlugins.install(plugin.id);
    } catch (cause) {
      result = { ok: false, error: messageOf(cause) };
    }
    setInstalling((set) => {
      const next = new Set(set);
      next.delete(plugin.id);
      return next;
    });
    if (result.ok) {
      setPlugins((list) =>
        (list ?? []).map((item) => (item.id === plugin.id ? { ...item, installed: true } : item))
      );
      onInstalled();
    } else {
      setFailures((all) => ({ ...all, [plugin.id]: result.ok ? '' : result.error }));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl" zIndexLevel="nested">
        <DialogHeader>
          <DialogTitle>{t('Browse Claude plugins')}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="flex min-w-0 gap-2">
            {marketplaces.length > 1 && (
              <Select value={current} onValueChange={(value) => setMarketplace(String(value))}>
                <SelectTrigger className="w-56 shrink-0">
                  <SelectValue>{current}</SelectValue>
                </SelectTrigger>
                <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_NESTED_MODAL}>
                  {marketplaces.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                      {counts.has(name) && (
                        <span className="ms-2 text-muted-foreground tabular-nums">
                          {counts.get(name)}
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
            {/* Decision 167: coss's InputGroup, input first, as every search field. */}
            <InputGroup className="min-w-0 flex-1">
              <InputGroupInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('Search by name or description')}
                aria-label={t('Search plugins')}
              />
              <InputGroupAddon align="inline-start">
                <Search className="size-4 text-muted-foreground" />
              </InputGroupAddon>
            </InputGroup>
          </div>
          {loadError ? (
            <ClaudeCallout tone="error">{loadError}</ClaudeCallout>
          ) : !plugins ? (
            <div className="flex items-center gap-2 py-6 text-ui text-muted-foreground">
              <Spinner />
              {t('Reading the marketplaces…')}
            </div>
          ) : (
            <ul className={`${SETTINGS_CARD_FRAME_CLASS} max-h-[26rem] overflow-y-auto`}>
              {rows.length === 0 && (
                <li className="p-3 text-small text-muted-foreground">{t('No plugin matches')}</li>
              )}
              {rows.map((plugin) => (
                <li key={plugin.id} className="flex min-w-0 items-start gap-3 p-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="min-w-0 truncate text-ui font-semibold">{plugin.name}</div>
                    {plugin.description && (
                      <p className="line-clamp-2 break-words text-small text-muted-foreground">
                        {plugin.description}
                      </p>
                    )}
                    {plugin.installCount !== undefined && (
                      <p className="text-small tabular-nums text-muted-foreground">
                        {t('{{count}} installs', {
                          count: formatCount(plugin.installCount, locale),
                        })}
                      </p>
                    )}
                    {failures[plugin.id] && (
                      <div className="pt-1.5">
                        <ClaudeCallout tone="error">
                          {t('Could not install: {{error}}', { error: failures[plugin.id] })}
                        </ClaudeCallout>
                      </div>
                    )}
                  </div>
                  <div className="shrink-0">
                    {plugin.installed ? (
                      <Badge variant="secondary">{t('Installed')}</Badge>
                    ) : installing.has(plugin.id) ? (
                      <Badge variant="outline">
                        <Spinner className="size-3" />
                        {t('Installing…')}
                      </Badge>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => void install(plugin)}>
                        <Download />
                        {t('Install')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-small text-muted-foreground">
            {t(
              'New Claude chats can use a plugin once it is installed. Hooks and MCP servers a plugin brings run programs on this machine.'
            )}
          </p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function MarketplacesDialog({
  open,
  onOpenChange,
  state,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ClaudePluginsState | null;
  run: (task: () => Promise<ClaudeCliResult>) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (task: () => Promise<ClaudeCliResult>) => {
    setBusy(true);
    const ok = await run(task);
    setBusy(false);
    return ok;
  };
  const marketplaces = state?.marketplaces ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg" zIndexLevel="nested">
        <DialogHeader>
          <DialogTitle>{t('Plugin marketplaces')}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {marketplaces.length > 0 && (
            <ul className={SETTINGS_CARD_FRAME_CLASS}>
              {marketplaces.map((market) => (
                <li key={market.name} className="flex min-w-0 items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="min-w-0 truncate text-ui font-semibold">{market.name}</div>
                    <Ident
                      className="block min-w-0 truncate text-muted-foreground"
                      title={market.source}
                    >
                      {market.source}
                    </Ident>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        window.electronAPI.claudePlugins.updateMarketplace(market.name)
                      )
                    }
                  >
                    <RefreshCw />
                    {t('Update')}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        window.electronAPI.claudePlugins.removeMarketplace(market.name)
                      )
                    }
                  >
                    {t('Remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-1.5">
            <h4 className="text-ui font-semibold">{t('Add a marketplace')}</h4>
            <form
              className="flex min-w-0 gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = source.trim();
                if (!value) return;
                void act(() => window.electronAPI.claudePlugins.addMarketplace(value)).then(
                  (ok) => ok && setSource('')
                );
              }}
            >
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder={t('owner/repo, a git URL or a local folder')}
                aria-label={t('Marketplace source')}
                className="min-w-0 flex-1"
                disabled={busy}
              />
              <Button type="submit" variant="outline" disabled={busy || !source.trim()}>
                {busy ? <Spinner /> : null}
                {t('Add')}
              </Button>
            </form>
            <p className="text-small text-muted-foreground">
              {t(
                'A GitHub marketplace is cloned with git and needs access to GitHub; on an internal network, a shared folder works. Removing a marketplace uninstalls the plugins installed from it.'
              )}
            </p>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function sectionTitle(t: Translate) {
  return (
    <span className="inline-flex items-center gap-1">
      {t('Claude plugins')}
      <SettingsHelpTip label={t('About Claude plugins')}>
        <p>
          {t(
            'For Claude chats only, the same as installing with /plugin in Claude Code. Installed in this app’s own Claude folder; your ~/.claude is not touched.'
          )}
        </p>
        <p>
          {t(
            'A plugin can bring hooks and MCP servers, which run programs on this machine. Install only from sources you trust.'
          )}
        </p>
      </SettingsHelpTip>
    </span>
  );
}

export function ClaudePluginsSettings({ repoPath }: { repoPath?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<ClaudePluginsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [dialog, setDialog] = useState<'browse' | 'markets' | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<ClaudePluginView | null>(null);
  const [addingOfficial, setAddingOfficial] = useState(false);

  const reload = useCallback(async () => {
    try {
      setState(await window.electronAPI.claudePlugins.state(repoPath));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [repoPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** One CLI change; the page re-reads after it, failed or not. */
  const run = useCallback(
    async (task: () => Promise<ClaudeCliResult>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      let result: ClaudeCliResult;
      try {
        result = await task();
      } catch (cause) {
        result = { ok: false, error: messageOf(cause) };
      }
      if (result.ok) setChanged(true);
      else setError(result.error);
      await reload();
      setBusy(false);
      return result.ok;
    },
    [reload]
  );

  const addOfficial = async () => {
    setAddingOfficial(true);
    const ok = await run(() =>
      window.electronAPI.claudePlugins.addMarketplace(CLAUDE_OFFICIAL_MARKETPLACE)
    );
    setAddingOfficial(false);
    if (ok) setDialog('browse');
  };

  const plugins = state?.plugins ?? [];
  const mine = plugins.filter((plugin) => plugin.scope === 'user');
  const declared = plugins.filter((plugin) => plugin.scope !== 'user');
  const marketplaces = state?.marketplaces ?? [];
  const hasMarketplace = marketplaces.length > 0;

  return (
    <SettingsSectionBlock bare title={sectionTitle(t)}>
      <div className="space-y-3">
        {(hasMarketplace || mine.length > 0) && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setDialog('markets')}>
              <Store />
              {t('Plugin marketplaces')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!hasMarketplace}
              onClick={() => setDialog('browse')}
            >
              <Search />
              {t('Browse plugins')}
            </Button>
          </div>
        )}
        {state?.error && (
          <ClaudeCallout tone="error">
            {t('The plugin list could not be read: {{error}}', { error: state.error })}
          </ClaudeCallout>
        )}
        {error && <ClaudeCallout tone="error">{error}</ClaudeCallout>}
        {changed && (
          <ClaudeCallout tone="info">
            {t(
              'New Claude chats use the change; chats already open get it the next time they start.'
            )}
          </ClaudeCallout>
        )}

        {!state ? (
          <p className="text-ui text-muted-foreground">{t('Loading plugins...')}</p>
        ) : mine.length === 0 ? (
          <Empty className="rounded-md border border-border-soft bg-surface-2">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Puzzle className="h-5 w-5" />
              </EmptyMedia>
              <EmptyTitle>
                {hasMarketplace ? t('No plugin installed') : t('No Claude plugins yet')}
              </EmptyTitle>
              <EmptyDescription>
                {hasMarketplace
                  ? t('Pick plugins from the marketplaces you added.')
                  : t('Add a plugin marketplace first, then install plugins from it.')}
              </EmptyDescription>
            </EmptyHeader>
            <div className="flex flex-wrap justify-center gap-2">
              {hasMarketplace ? (
                <Button size="sm" onClick={() => setDialog('browse')}>
                  {t('Browse plugins')}
                </Button>
              ) : (
                <>
                  <Button size="sm" disabled={busy} onClick={() => void addOfficial()}>
                    {addingOfficial && <Spinner />}
                    {addingOfficial
                      ? t('Cloning the official marketplace…')
                      : t('Add the official marketplace')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setDialog('markets')}
                  >
                    {t('Add another marketplace…')}
                  </Button>
                </>
              )}
            </div>
            {!hasMarketplace && (
              <p className="text-small text-muted-foreground">
                {t('Official marketplace: {{source}}, needs access to GitHub', {
                  source: CLAUDE_OFFICIAL_MARKETPLACE,
                })}
              </p>
            )}
          </Empty>
        ) : (
          <ul className={SETTINGS_CARD_FRAME_CLASS}>
            {mine.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                busy={busy}
                onToggle={(enabled) =>
                  void run(() => window.electronAPI.claudePlugins.setEnabled(plugin.id, enabled))
                }
                onUpdate={() => void run(() => window.electronAPI.claudePlugins.update(plugin.id))}
                onUninstall={() => setConfirmUninstall(plugin)}
              />
            ))}
          </ul>
        )}

        {declared.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="px-1 text-small text-muted-foreground">
              {t('Declared by the open repository')}
            </h4>
            <ul className={SETTINGS_CARD_FRAME_CLASS}>
              {declared.map((plugin) => (
                <PluginRow
                  key={`${plugin.scope}:${plugin.id}`}
                  plugin={plugin}
                  busy
                  onToggle={() => undefined}
                  onUpdate={() => undefined}
                  onUninstall={() => undefined}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      <BrowseDialog
        open={dialog === 'browse'}
        onOpenChange={(open) => setDialog(open ? 'browse' : null)}
        marketplaces={marketplaces.map((market) => market.name)}
        onInstalled={() => {
          setChanged(true);
          void reload();
        }}
      />
      <MarketplacesDialog
        open={dialog === 'markets'}
        onOpenChange={(open) => setDialog(open ? 'markets' : null)}
        state={state}
        run={run}
      />
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
              {t(
                'Its files and the data it saved are deleted. Claude chats already open keep using it until they next start.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setConfirmUninstall(null)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive-outline"
              onClick={() => {
                const plugin = confirmUninstall;
                setConfirmUninstall(null);
                if (plugin) void run(() => window.electronAPI.claudePlugins.uninstall(plugin.id));
              }}
            >
              {t('Uninstall')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSectionBlock>
  );
}
