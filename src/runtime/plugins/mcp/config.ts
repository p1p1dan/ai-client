/**
 * P5-3 — where MCP servers are declared.
 *
 * The file shape is the de-facto one (`{"mcpServers": {...}}`, as written by
 * Claude Desktop, Cursor, Windsurf and others) rather than something of our
 * own. Same reasoning as `~/.agents/skills` in P5-1: a user who already runs
 * MCP servers has this file, and asking them to maintain a second copy in our
 * dialect buys nothing. pi itself has no MCP support at all ("It intentionally
 * does not include built-in MCP" — `docs/usage.md`), so there is no pi format
 * to follow here.
 *
 * Reading goes through the host IO port for D11's reason, same as every other
 * file this runtime touches.
 */

import { join } from 'node:path';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Source file, for diagnostics and for the tool row's provenance. */
  source: string;
  scope: 'user' | 'project';
}

export interface McpConfigDiagnostic {
  code: 'read_failed' | 'parse_failed' | 'invalid_entry';
  message: string;
  path: string;
}

/** A config file is a handful of lines; anything larger is not one. */
export const MAX_CONFIG_BYTES = 256 * 1024;
/** Servers past this are dropped: each one is a process and a handshake. */
export const MAX_SERVERS = 16;

const OPTIONAL_FILE_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP']);

export interface McpConfigSource {
  readText(path: string): Promise<string | undefined>;
}

export function mcpConfigSource(io: RuntimeHostIoService): McpConfigSource {
  return {
    async readText(path) {
      try {
        const result = await io.readFile(path, {
          maxBytes: MAX_CONFIG_BYTES,
          overflow: 'error',
        });
        return new TextDecoder().decode(result.bytes);
      } catch (error) {
        if (OPTIONAL_FILE_ERRORS.has(errorCode(error) ?? '')) return undefined;
        throw error;
      }
    },
  };
}

export interface McpConfigRoots {
  agentDir?: string;
  cwd?: string;
  /**
   * An MCP server is an arbitrary program this runtime is being told to
   * execute. A checkout the user has not trusted must not be able to name one —
   * the same gate project skills and project permission policy sit behind.
   */
  projectTrusted?: boolean;
}

export function mcpConfigFiles(
  roots: McpConfigRoots
): { path: string; scope: 'user' | 'project' }[] {
  const files: { path: string; scope: 'user' | 'project' }[] = [];
  if (roots.agentDir) files.push({ path: join(roots.agentDir, 'mcp.json'), scope: 'user' });
  if (roots.cwd && roots.projectTrusted)
    files.push({ path: join(roots.cwd, '.pi', 'mcp.json'), scope: 'project' });
  return files;
}

/**
 * What may appear as a server name in a config file.
 *
 * Wider than the alphabet a provider accepts in a tool name, on purpose: the
 * name written here is also what a permission rule matches (`server:tool`) and
 * what a diagnostic prints, and dotted names are common in the ecosystem's own
 * files. `mcpToolName` is what narrows it for the model's benefit.
 */
function isValidName(name: string): boolean {
  return /^[\w.-]{1,48}$/.test(name);
}

export interface LoadedMcpConfig {
  servers: McpServerConfig[];
  diagnostics: McpConfigDiagnostic[];
}

/**
 * Read every config file in order; a later file's server of the same name wins.
 *
 * `disabled: true` is honoured because that is how the ecosystem's editors turn
 * a server off, and a user who disabled a server somewhere else would otherwise
 * find it running here.
 */
export async function loadMcpConfig(
  source: McpConfigSource,
  roots: McpConfigRoots
): Promise<LoadedMcpConfig> {
  const byName = new Map<string, McpServerConfig>();
  const diagnostics: McpConfigDiagnostic[] = [];

  for (const file of mcpConfigFiles(roots)) {
    let text: string | undefined;
    try {
      text = await source.readText(file.path);
    } catch (error) {
      diagnostics.push({
        code: 'read_failed',
        path: file.path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      diagnostics.push({
        code: 'parse_failed',
        path: file.path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
    if (typeof servers !== 'object' || servers === null) {
      diagnostics.push({
        code: 'parse_failed',
        path: file.path,
        message: 'no "mcpServers" object at the top level',
      });
      continue;
    }
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      const entry = value as {
        command?: unknown;
        args?: unknown;
        env?: unknown;
        disabled?: unknown;
        type?: unknown;
        url?: unknown;
      };
      if (entry?.disabled === true) {
        // Not merely "skip this entry": the later file wins on every other
        // field, so it has to win here too. Without the delete, a project that
        // turns a server off leaves the user file's copy of it running — the
        // opposite of what this function's own doc promises.
        byName.delete(name);
        continue;
      }
      if (!isValidName(name)) {
        diagnostics.push({
          code: 'invalid_entry',
          path: file.path,
          message: `server name "${name}" is not usable in a tool name`,
        });
        continue;
      }
      // Remote transports are a separate feature with their own auth and
      // network questions; saying so beats starting nothing and looking broken.
      if (typeof entry?.command !== 'string' || !entry.command.trim()) {
        diagnostics.push({
          code: 'invalid_entry',
          path: file.path,
          message:
            typeof entry?.url === 'string'
              ? `server "${name}" is an HTTP/SSE server; this bridge speaks stdio only`
              : `server "${name}" has no "command"`,
        });
        continue;
      }
      const args = Array.isArray(entry.args)
        ? entry.args.filter((item): item is string => typeof item === 'string')
        : [];
      const env: Record<string, string> = {};
      for (const [key, item] of Object.entries((entry.env as Record<string, unknown>) ?? {})) {
        if (typeof item === 'string') env[key] = item;
      }
      byName.set(name, {
        name,
        command: entry.command.trim(),
        args,
        env,
        source: file.path,
        scope: file.scope,
      });
    }
  }

  // Declaration order, not alphabetical: a `Map` keeps the position of the
  // first file that named a server, so "the first N" means the N the user
  // wrote first. Sorting by name made the surviving set depend on spelling,
  // which is not something anyone edits a config file expecting to matter.
  const servers = [...byName.values()];
  if (servers.length > MAX_SERVERS) {
    const dropped = servers.slice(MAX_SERVERS).map((item) => item.name);
    diagnostics.push({
      code: 'invalid_entry',
      path: '',
      message: `only the first ${MAX_SERVERS} servers declared are started; ${servers.length} were declared, so ${dropped.join(', ')} did not start`,
    });
  }
  return { servers: servers.slice(0, MAX_SERVERS), diagnostics };
}
