/**
 * docs/plantree/plans/claude-plugins §4, §6: the Claude chats' plugins and MCP
 * servers, as the bundled CLI sees them in the user layer and the open
 * repository. Every change goes through the CLI (`ClaudeCliRun`), one at a
 * time; what a plugin brings and the MCP servers are read from the files the
 * CLI keeps, because its commands only say so in text.
 *
 * After each change `onChanged` fires, so the slash menu drops the lists it
 * keeps per folder (decision 194) and a new chat's menu shows the change.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_MCP_NAME_PATTERN,
  CLAUDE_PLUGIN_ID_PATTERN,
  type ClaudeAvailablePlugin,
  type ClaudeCliResult,
  type ClaudeMarketplaceView,
  type ClaudeMcpServerInput,
  type ClaudeMcpServerView,
  type ClaudeMcpState,
  type ClaudeMcpTransport,
  type ClaudePluginComponents,
  type ClaudePluginsState,
  type ClaudePluginView,
  type ClaudeSettingScope,
} from '@shared/claudePlugins';
import { type ClaudeCliRun, parseCliJson, parseCliOutcome, parseCliPlain } from './claudeCli';

export interface ClaudePluginServiceDeps {
  run: ClaudeCliRun;
  /** The user layer (`CLAUDE_CONFIG_DIR`). */
  configDir: () => string;
  onChanged?: () => void;
}

interface CliInstalled {
  id?: unknown;
  version?: unknown;
  scope?: unknown;
  enabled?: unknown;
  installPath?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** Handlers in a hooks object: `{ Event: [{ hooks: [handler, …] }, …] }`. */
function countHookHandlers(hooks: unknown): number {
  if (!isRecord(hooks)) return 0;
  let count = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (isRecord(group) && Array.isArray(group.hooks)) count += group.hooks.length;
    }
  }
  return count;
}

/** `{ name: config }`, the shape of `.mcp.json` (bare or under `mcpServers`). */
function mcpServersOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return isRecord(value.mcpServers) ? value.mcpServers : value;
}

function pluginManifest(installPath: string): Record<string, unknown> {
  const manifest = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
  return isRecord(manifest) ? manifest : {};
}

/** The servers a plugin declares: `.mcp.json`, or `mcpServers` in its manifest (inline or a path). */
function pluginMcpServers(installPath: string): Record<string, unknown> {
  const declared = pluginManifest(installPath).mcpServers;
  if (isRecord(declared)) return declared;
  const file = typeof declared === 'string' ? declared : '.mcp.json';
  return mcpServersOf(readJson(path.join(installPath, file)));
}

/** What a plugin brings, counted the way the CLI finds it in the default layout. */
export function pluginComponents(installPath: string): ClaudePluginComponents {
  const markdown = (dir: string) =>
    entries(path.join(installPath, dir)).filter((name) => name.endsWith('.md')).length;
  const skills = entries(path.join(installPath, 'skills')).filter((name) =>
    isDirectory(path.join(installPath, 'skills', name))
  ).length;
  const manifest = pluginManifest(installPath);
  const hooksFile = readJson(path.join(installPath, 'hooks', 'hooks.json'));
  const hooks =
    countHookHandlers(isRecord(hooksFile) ? hooksFile.hooks : undefined) +
    countHookHandlers(isRecord(manifest.hooks) ? manifest.hooks : undefined);
  return {
    skills,
    commands: markdown('commands'),
    agents: markdown('agents'),
    hooks,
    mcpServers: Object.keys(pluginMcpServers(installPath)).length,
  };
}

function scopeOf(value: unknown): ClaudeSettingScope {
  return value === 'project' || value === 'local' ? value : 'user';
}

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf('@');
  return at > 0
    ? { name: id.slice(0, at), marketplace: id.slice(at + 1) }
    : { name: id, marketplace: '' };
}

function transportOf(config: Record<string, unknown>): ClaudeMcpTransport {
  const type = config.type;
  if (type === 'http' || type === 'sse' || type === 'ws') return type;
  return typeof config.url === 'string' && config.command === undefined ? 'http' : 'stdio';
}

function serverView(
  name: string,
  config: unknown,
  origin: ClaudeMcpServerView['origin'],
  plugin?: string
): ClaudeMcpServerView | null {
  if (!isRecord(config)) return null;
  const transport = transportOf(config);
  const args = Array.isArray(config.args) ? config.args.filter((a) => typeof a === 'string') : [];
  const target =
    transport === 'stdio'
      ? [asString(config.command) ?? '', ...args].join(' ').trim()
      : (asString(config.url) ?? '');
  return {
    name,
    origin,
    ...(plugin ? { plugin } : {}),
    transport,
    target,
    envNames: isRecord(config.env) ? Object.keys(config.env) : [],
    headerNames: isRecord(config.headers) ? Object.keys(config.headers) : [],
  };
}

export class ClaudePluginService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ClaudePluginServiceDeps) {}

  /** One CLI change at a time: two writers of the same settings file would lose one. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async change(args: string[], plain = false): Promise<ClaudeCliResult> {
    return this.serial(async () => {
      try {
        const output = await this.deps.run(args);
        const result = plain ? parseCliPlain(output) : parseCliOutcome(output);
        if (result.ok) this.deps.onChanged?.();
        return result.ok ? { ok: true } : { ok: false, error: result.message };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  /** Installed plugins (the repository's too when `cwd` is one) and the marketplaces. */
  async state(cwd?: string): Promise<ClaudePluginsState> {
    try {
      const [installed, marketplaces] = await Promise.all([
        this.deps.run(['plugin', 'list', '--json'], { cwd }).then(parseCliJson),
        this.deps.run(['plugin', 'marketplace', 'list', '--json']).then(parseCliJson),
      ]);
      return {
        plugins: (Array.isArray(installed) ? installed : []).flatMap((entry) =>
          this.pluginView(entry as CliInstalled)
        ),
        marketplaces: (Array.isArray(marketplaces) ? marketplaces : []).flatMap((entry) =>
          marketplaceView(entry)
        ),
      };
    } catch (error) {
      return {
        plugins: [],
        marketplaces: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private pluginView(entry: CliInstalled): ClaudePluginView[] {
    const id = asString(entry.id);
    if (!id) return [];
    const installPath = asString(entry.installPath);
    const manifest = installPath ? pluginManifest(installPath) : {};
    const description = asString(manifest.description);
    return [
      {
        id,
        ...splitId(id),
        ...(asString(entry.version) ? { version: entry.version as string } : {}),
        ...(description ? { description } : {}),
        enabled: entry.enabled === true,
        scope: scopeOf(entry.scope),
        components: installPath
          ? pluginComponents(installPath)
          : { skills: 0, commands: 0, agents: 0, hooks: 0, mcpServers: 0 },
      },
    ];
  }

  /**
   * Every plugin the added marketplaces offer, by name. The CLI leaves installed ones out
   * of `available`; they are put back from `installed`, marked so.
   */
  async available(): Promise<ClaudeAvailablePlugin[]> {
    const listed = parseCliJson(
      await this.deps.run(['plugin', 'list', '--available', '--json'])
    ) as { installed?: unknown; available?: unknown };
    const rows = new Map<string, ClaudeAvailablePlugin>();
    for (const entry of Array.isArray(listed.available) ? listed.available : []) {
      if (!isRecord(entry)) continue;
      const id = asString(entry.pluginId);
      if (!id) continue;
      const { name, marketplace } = splitId(id);
      rows.set(id, {
        id,
        name: asString(entry.name) ?? name,
        marketplace: asString(entry.marketplaceName) ?? marketplace,
        description: asString(entry.description) ?? '',
        ...(typeof entry.installCount === 'number' ? { installCount: entry.installCount } : {}),
        ...(asString(entry.version) ? { version: entry.version as string } : {}),
        installed: false,
      });
    }
    for (const entry of Array.isArray(listed.installed) ? listed.installed : []) {
      if (!isRecord(entry)) continue;
      const [view] = this.pluginView(entry as CliInstalled);
      if (!view) continue;
      const known = rows.get(view.id);
      rows.set(view.id, {
        id: view.id,
        name: view.name,
        marketplace: view.marketplace,
        description: known?.description || view.description || '',
        ...(known?.installCount !== undefined ? { installCount: known.installCount } : {}),
        ...(view.version ? { version: view.version } : {}),
        installed: true,
      });
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  install(id: string): Promise<ClaudeCliResult> {
    if (!CLAUDE_PLUGIN_ID_PATTERN.test(id)) return refused('Not a plugin id');
    return this.change(['plugin', 'install', id, '--scope', 'user', '--json']);
  }

  setEnabled(id: string, enabled: boolean): Promise<ClaudeCliResult> {
    if (!CLAUDE_PLUGIN_ID_PATTERN.test(id)) return refused('Not a plugin id');
    return this.change(['plugin', enabled ? 'enable' : 'disable', id, '--scope', 'user', '--json']);
  }

  uninstall(id: string): Promise<ClaudeCliResult> {
    if (!CLAUDE_PLUGIN_ID_PATTERN.test(id)) return refused('Not a plugin id');
    return this.change(['plugin', 'uninstall', id, '--scope', 'user', '--json']);
  }

  /** Updates the plugin's marketplace first, then the plugin. */
  async update(id: string): Promise<ClaudeCliResult> {
    if (!CLAUDE_PLUGIN_ID_PATTERN.test(id)) return refused('Not a plugin id');
    const refreshed = await this.updateMarketplace(splitId(id).marketplace);
    if (!refreshed.ok) return refreshed;
    return this.change(['plugin', 'update', id, '--scope', 'user', '--json']);
  }

  addMarketplace(source: string): Promise<ClaudeCliResult> {
    const trimmed = source.trim();
    // An argument, never an option: a leading `-` would be read as one.
    if (!trimmed || trimmed.startsWith('-')) return refused('Not a marketplace source');
    return this.change(['plugin', 'marketplace', 'add', trimmed, '--scope', 'user', '--json']);
  }

  removeMarketplace(name: string): Promise<ClaudeCliResult> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return refused('Not a marketplace name');
    return this.change(['plugin', 'marketplace', 'remove', name, '--json']);
  }

  updateMarketplace(name: string): Promise<ClaudeCliResult> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return refused('Not a marketplace name');
    return this.change(['plugin', 'marketplace', 'update', name, '--json']);
  }

  /**
   * The servers a Claude chat in `cwd` may start: the user layer's
   * (`<configDir>/.claude.json`), the repository's `.mcp.json` and those of
   * enabled plugins. Values of `env` and `headers` stay here.
   */
  async mcpState(cwd?: string): Promise<ClaudeMcpState> {
    const servers: ClaudeMcpServerView[] = [];
    const user = readJson(path.join(this.deps.configDir(), '.claude.json'));
    for (const [name, config] of Object.entries(
      isRecord(user) ? mcpServersOf(user.mcpServers) : {}
    )) {
      const view = serverView(name, config, 'user');
      if (view) servers.push(view);
    }
    if (cwd) {
      for (const [name, config] of Object.entries(
        mcpServersOf(readJson(path.join(cwd, '.mcp.json')))
      )) {
        const view = serverView(name, config, 'project');
        if (view) servers.push(view);
      }
    }
    try {
      const installed = parseCliJson(await this.deps.run(['plugin', 'list', '--json'], { cwd }));
      for (const entry of Array.isArray(installed) ? (installed as CliInstalled[]) : []) {
        const id = asString(entry.id);
        const installPath = asString(entry.installPath);
        if (!id || !installPath || entry.enabled !== true) continue;
        for (const [name, config] of Object.entries(pluginMcpServers(installPath))) {
          const view = serverView(name, config, 'plugin', id);
          if (view) servers.push(view);
        }
      }
    } catch (error) {
      return { servers, error: error instanceof Error ? error.message : String(error) };
    }
    return { servers };
  }

  addMcpServer(input: ClaudeMcpServerInput): Promise<ClaudeCliResult> {
    if (!CLAUDE_MCP_NAME_PATTERN.test(input.name)) return refused('Not a server name');
    const config =
      input.transport === 'stdio'
        ? {
            type: 'stdio',
            command: input.command.trim(),
            args: input.args,
            ...(Object.keys(input.env).length > 0 ? { env: input.env } : {}),
          }
        : {
            type: input.transport,
            url: input.url.trim(),
            ...(Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
          };
    if (
      input.transport === 'stdio' ? !input.command.trim() : !/^https?:\/\//i.test(input.url.trim())
    ) {
      return refused(input.transport === 'stdio' ? 'No command' : 'Not an http(s) URL');
    }
    return this.change(
      ['mcp', 'add-json', '--scope', 'user', input.name, JSON.stringify(config)],
      true
    );
  }

  removeMcpServer(name: string): Promise<ClaudeCliResult> {
    if (!CLAUDE_MCP_NAME_PATTERN.test(name)) return refused('Not a server name');
    return this.change(['mcp', 'remove', '--scope', 'user', name], true);
  }
}

function refused(error: string): Promise<ClaudeCliResult> {
  return Promise.resolve({ ok: false, error });
}

function marketplaceView(entry: unknown): ClaudeMarketplaceView[] {
  if (!isRecord(entry)) return [];
  const name = asString(entry.name);
  if (!name) return [];
  const sourceKind = asString(entry.source) ?? '';
  const source =
    asString(entry.repo) ??
    asString(entry.url) ??
    asString(entry.path) ??
    asString(entry.installLocation) ??
    '';
  return [{ name, sourceKind, source }];
}
