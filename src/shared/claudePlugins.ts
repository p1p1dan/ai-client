/**
 * Settings → Extensions → Claude plugins and Claude MCP servers
 * (docs/plantree/plans/claude-plugins). What Claude chats load from the user
 * layer (`~/.pilab/<profile>/claude`) and from the open repository. Every
 * change is made by the bundled CLI (`claude plugin … --json`, `claude mcp …`);
 * PiLab never writes the CLI's files itself.
 */

/** What a plugin brings, counted from its install directory. */
export interface ClaudePluginComponents {
  skills: number;
  commands: number;
  agents: number;
  /** Hook handlers: they run commands on this machine. */
  hooks: number;
  /** MCP servers: they start programs or reach services. */
  mcpServers: number;
}

export type ClaudeSettingScope = 'user' | 'project' | 'local';

export interface ClaudePluginView {
  /** `name@marketplace`. */
  id: string;
  name: string;
  marketplace: string;
  version?: string;
  description?: string;
  enabled: boolean;
  /**
   * `user`: installed here, can be switched and removed. `project` / `local`:
   * declared by the repository's `.claude/settings*.json`, listed read-only.
   */
  scope: ClaudeSettingScope;
  components: ClaudePluginComponents;
}

export interface ClaudeMarketplaceView {
  name: string;
  /** `github`, `git`, `url`, `directory`, … as the CLI says. */
  sourceKind: string;
  /** `owner/repo`, a URL or a path. */
  source: string;
}

export interface ClaudeAvailablePlugin {
  id: string;
  name: string;
  marketplace: string;
  description: string;
  installCount?: number;
  version?: string;
  installed: boolean;
}

export interface ClaudePluginsState {
  plugins: ClaudePluginView[];
  marketplaces: ClaudeMarketplaceView[];
  /** Set when the CLI could not list (missing binary, broken config). */
  error?: string;
}

export type ClaudeMcpTransport = 'stdio' | 'http' | 'sse' | 'ws';

/** Where a server is declared. Only `user` ones can be edited here. */
export type ClaudeMcpOrigin = 'user' | 'project' | 'plugin';

export interface ClaudeMcpServerView {
  name: string;
  origin: ClaudeMcpOrigin;
  /** The plugin id for `origin: 'plugin'`. */
  plugin?: string;
  transport: ClaudeMcpTransport;
  /** The command line for stdio, the URL otherwise. */
  target: string;
  /** Names only: values may be secrets and never leave Main. */
  envNames: string[];
  headerNames: string[];
}

export interface ClaudeMcpState {
  servers: ClaudeMcpServerView[];
  error?: string;
}

/** What the page sends to add a user-layer server. */
export type ClaudeMcpServerInput =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | {
      name: string;
      transport: 'http' | 'sse';
      url: string;
      headers: Record<string, string>;
    };

export type ClaudeCliResult = { ok: true } | { ok: false; error: string };

/** The CLI's own rule for a server name (letters, digits, `-`, `_`). */
export const CLAUDE_MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The CLI's own form of a plugin id. */
export const CLAUDE_PLUGIN_ID_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

/** The official marketplace, offered by the empty state (user 2026-10-29: not preset). */
export const CLAUDE_OFFICIAL_MARKETPLACE = 'anthropics/claude-plugins-official';
