/**
 * docs/plantree/plans/claude-plugins §6 — Settings → Extensions → Claude MCP
 * servers. The servers a Claude chat may start: the user layer's (added and
 * removed here, by the bundled CLI's `claude mcp add-json / remove`), the open
 * repository's `.mcp.json` and enabled plugins' (listed only). Values of
 * environment variables and headers never leave Main; only their names show.
 */

import type {
  ClaudeCliResult,
  ClaudeMcpServerInput,
  ClaudeMcpServerView,
  ClaudeMcpState,
} from '@shared/claudePlugins';
import { CLAUDE_MCP_NAME_PATTERN } from '@shared/claudePlugins';
import { Plus, Server, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogFooter,
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
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/i18n';
import { ClaudeCallout } from './ClaudePluginsSettings';
import {
  SETTINGS_CARD_FRAME_CLASS,
  SettingsHelpTip,
  SettingsSectionBlock,
} from './SettingsPrimitives';

type Transport = 'stdio' | 'http' | 'sse';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `KEY=value` (or `Name: value` for headers), one per line; blank lines are skipped. */
export function parsePairs(text: string, separator: '=' | ':'): Record<string, string> | null {
  const pairs: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    if (at <= 0) return null;
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return pairs;
}

function ServerRow({
  server,
  busy,
  onRemove,
}: {
  server: ClaudeMcpServerView;
  busy: boolean;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const secrets = [...server.envNames, ...server.headerNames];
  return (
    <li className="flex min-w-0 items-start gap-3 p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-ui font-semibold">{server.name}</span>
          <Badge variant="outline">{server.transport}</Badge>
          {server.origin === 'project' && <Badge variant="info">{t('From .mcp.json')}</Badge>}
          {server.origin === 'plugin' && server.plugin && (
            <Badge variant="info">
              {t('From plugin {{name}}', { name: server.plugin.split('@')[0] ?? '' })}
            </Badge>
          )}
        </div>
        <Ident className="block min-w-0 truncate text-muted-foreground" title={server.target}>
          {server.target}
        </Ident>
        {secrets.length > 0 && (
          <p className="min-w-0 break-words text-small text-muted-foreground">
            {t('Sets {{names}}', { names: secrets.join(', ') })}
          </p>
        )}
      </div>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground"
          aria-label={t('Remove {{name}}', { name: server.name })}
          disabled={busy}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      )}
    </li>
  );
}

function AddServerDialog({
  open,
  onOpenChange,
  taken,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taken: string[];
  onAdd: (input: ClaudeMcpServerInput) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<Transport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [pairs, setPairs] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setTransport('stdio');
    setCommand('');
    setArgs('');
    setUrl('');
    setPairs('');
  }, [open]);

  const parsed = parsePairs(pairs, transport === 'stdio' ? '=' : ':');
  const nameProblem = !name.trim()
    ? null
    : !CLAUDE_MCP_NAME_PATTERN.test(name.trim())
      ? t('Letters, digits, - and _ only')
      : taken.includes(name.trim())
        ? t('A server of this name exists')
        : null;
  const ready =
    name.trim() &&
    !nameProblem &&
    parsed !== null &&
    (transport === 'stdio' ? command.trim() : /^https?:\/\//i.test(url.trim()));

  const submit = async () => {
    if (!ready || !parsed) return;
    const input: ClaudeMcpServerInput =
      transport === 'stdio'
        ? {
            name: name.trim(),
            transport,
            command: command.trim(),
            args: args
              .split(/\r?\n/)
              .map((arg) => arg.trim())
              .filter(Boolean),
            env: parsed,
          }
        : { name: name.trim(), transport, url: url.trim(), headers: parsed };
    setBusy(true);
    const ok = await onAdd(input);
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg" zIndexLevel="nested">
        <DialogHeader>
          <DialogTitle>{t('Add an MCP server')}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="claude-mcp-name">{t('Name')}</Label>
            <Input
              id="claude-mcp-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-server"
            />
            {nameProblem && <p className="text-small text-destructive">{nameProblem}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>{t('Type')}</Label>
            <ToggleGroup
              value={[transport]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === 'stdio' || next === 'http' || next === 'sse') setTransport(next);
              }}
              variant="outline"
              size="sm"
            >
              <ToggleGroupItem value="stdio">{t('Local command')}</ToggleGroupItem>
              <ToggleGroupItem value="http">HTTP</ToggleGroupItem>
              <ToggleGroupItem value="sse">SSE</ToggleGroupItem>
            </ToggleGroup>
          </div>
          {transport === 'stdio' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="claude-mcp-command">{t('Command')}</Label>
                <Input
                  id="claude-mcp-command"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="npx"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="claude-mcp-args">{t('Arguments, one per line')}</Label>
                <Textarea
                  id="claude-mcp-args"
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                  rows={3}
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="claude-mcp-url">URL</Label>
              <Input
                id="claude-mcp-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/mcp"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="claude-mcp-pairs">
              {transport === 'stdio'
                ? t('Environment variables, KEY=value per line')
                : t('Headers, Name: value per line')}
            </Label>
            <Textarea
              id="claude-mcp-pairs"
              value={pairs}
              onChange={(event) => setPairs(event.target.value)}
              placeholder={transport === 'stdio' ? 'API_KEY=…' : 'Authorization: Bearer …'}
              rows={2}
            />
            {parsed === null && (
              <p className="text-small text-destructive">{t('A line is missing its name')}</p>
            )}
            <p className="text-small text-muted-foreground">
              {t(
                'Claude chats pass no environment variables of yours to a server; put what it needs here. It is stored in this app’s Claude folder, as Claude Code stores it.'
              )}
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button disabled={!ready || busy} onClick={() => void submit()}>
            {busy && <Spinner />}
            {t('Add')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ClaudeMcpSettings({ repoPath }: { repoPath?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<ClaudeMcpState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    try {
      setState(await window.electronAPI.claudeMcp.state(repoPath));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [repoPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (task: () => Promise<ClaudeCliResult>): Promise<boolean> => {
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
  };

  const servers = state?.servers ?? [];
  const mine = servers.filter((server) => server.origin === 'user');
  const others = servers.filter((server) => server.origin !== 'user');

  return (
    <SettingsSectionBlock
      bare
      title={
        <span className="inline-flex items-center gap-1">
          {t('Claude MCP servers')}
          <SettingsHelpTip label={t('About Claude MCP servers')}>
            <p>
              {t(
                'For Claude chats only. Servers added here are in this app’s own Claude folder; a repository’s .mcp.json and enabled plugins add their own.'
              )}
            </p>
            <p>
              {t(
                'A local server is a program that runs on this machine with your permissions. Its tools ask for approval like the built-in ones.'
              )}
            </p>
          </SettingsHelpTip>
        </span>
      }
    >
      <div className="space-y-3">
        <div className="flex justify-end">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setAdding(true)}>
            <Plus />
            {t('Add a server')}
          </Button>
        </div>
        {state?.error && <ClaudeCallout tone="error">{state.error}</ClaudeCallout>}
        {error && <ClaudeCallout tone="error">{error}</ClaudeCallout>}
        {changed && (
          <ClaudeCallout tone="info">
            {t(
              'New Claude chats use the change; chats already open get it the next time they start.'
            )}
          </ClaudeCallout>
        )}
        {!state ? (
          <p className="text-ui text-muted-foreground">{t('Loading...')}</p>
        ) : servers.length === 0 ? (
          <Empty className="rounded-md border border-border-soft bg-surface-2">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Server className="h-5 w-5" />
              </EmptyMedia>
              <EmptyTitle>{t('No MCP servers')}</EmptyTitle>
              <EmptyDescription>
                {t('Add a server, or open a repository whose .mcp.json declares some.')}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {mine.length > 0 && (
              <ul className={SETTINGS_CARD_FRAME_CLASS}>
                {mine.map((server) => (
                  <ServerRow
                    key={server.name}
                    server={server}
                    busy={busy}
                    onRemove={() =>
                      void run(() => window.electronAPI.claudeMcp.remove(server.name))
                    }
                  />
                ))}
              </ul>
            )}
            {others.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="px-1 text-small text-muted-foreground">
                  {t('From the open repository and plugins')}
                </h4>
                <ul className={SETTINGS_CARD_FRAME_CLASS}>
                  {others.map((server) => (
                    <ServerRow
                      key={`${server.origin}:${server.plugin ?? ''}:${server.name}`}
                      server={server}
                      busy
                    />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
      <AddServerDialog
        open={adding}
        onOpenChange={setAdding}
        taken={mine.map((server) => server.name)}
        onAdd={(input) => run(() => window.electronAPI.claudeMcp.add(input))}
      />
    </SettingsSectionBlock>
  );
}
