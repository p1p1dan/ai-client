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

import { totalmem } from 'node:os';
import { join } from 'node:path';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';
import { resolveSettingSources, type SettingSource } from '../../settingSources.ts';

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Source file, for diagnostics and for the tool row's provenance. */
  source: string;
  scope: SettingSource;
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

/**
 * concurrency-04 — how many worker slots this machine's memory allows.
 *
 * A MIRROR of `resolveDefaultWorkerCapacity` in
 * `src/main/services/agent-host/WorkerManager.ts`. It cannot be imported: that
 * module is main-process code and this one runs inside the worker, which is a
 * separate package. The mirror is asserted by a unit case instead — the same
 * technique `shared/types/attachmentIo.ts` uses for the renderer's image
 * ceiling. If the tiers there change, change them here.
 *
 * It is needed here because the number that matters is a PRODUCT: one slot is
 * one worker process, and every worker starts its OWN copy of every configured
 * server. "16 servers" therefore means 16 × slots processes on the machine.
 */
export function workerSlotBudget(totalMemoryBytes: number = totalmem()): number {
  if (totalMemoryBytes <= 4 * 1024 ** 3) return 3;
  if (totalMemoryBytes <= 8 * 1024 ** 3) return 6;
  return 10;
}

/**
 * concurrency-04 — this session's share of the machine-wide MCP process budget.
 *
 * `MAX_SERVERS` is a per-session declaration cap and nothing more: with it as
 * the only limit, a 4 GiB machine running its three allowed sessions could hold
 * 48 long-lived child processes, each with three pipes and its own runtime,
 * none of which appears in any account the application keeps. Nothing was
 * wrong with any single number; the product of two correct numbers was the
 * problem.
 *
 * So the per-session cap is derived instead of fixed: a per-slot share sized
 * against the same memory tiers that decide how many sessions may run at once,
 * which bounds the machine-wide total at {@link hostServerBudget} whatever the
 * user opens. Every worker computes the same answer from the same memory, so
 * no message has to be passed between them for the account to hold.
 *
 * The tiers are read as ~75 MiB per server process: 4 / 6 / 12 per session is
 * 12 / 36 / 120 on the machine, i.e. roughly a fifth of RAM at full stretch.
 * Servers past the share are dropped by declaration order and named in the
 * diagnostics, exactly as the declaration cap already does.
 */
export function sessionServerBudget(totalMemoryBytes: number = totalmem()): number {
  const perSlot =
    totalMemoryBytes <= 4 * 1024 ** 3 ? 4 : totalMemoryBytes <= 8 * 1024 ** 3 ? 6 : 12;
  return Math.min(MAX_SERVERS, perSlot);
}

/** The machine-wide MCP child-process total the two budgets above imply. */
export function hostServerBudget(totalMemoryBytes: number = totalmem()): number {
  return workerSlotBudget(totalMemoryBytes) * sessionServerBudget(totalMemoryBytes);
}

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
  /** decision 008 — absent means all three tiers, as the official default does. */
  settingSources?: readonly SettingSource[];
  /**
   * How many servers this session may start (concurrency-04).
   *
   * Defaults to {@link sessionServerBudget} for this machine. Passed explicitly
   * only by tests, which must not have their expectations depend on the amount
   * of RAM in whatever box is running them.
   */
  maxServers?: number;
}

/**
 * The files to read, least specific first — which is also merge order, because
 * {@link loadMcpConfig} lets a later file's server of the same name win.
 *
 * decision 008 adds the `local` tier on the end: `.pi/mcp.local.json` is the
 * not-checked-in companion to `.pi/mcp.json`, so it beats it on a shared name
 * and both beat the user's.
 */
export function mcpConfigFiles(roots: McpConfigRoots): { path: string; scope: SettingSource }[] {
  const files: { path: string; scope: SettingSource }[] = [];
  const enabled = resolveSettingSources(roots);
  if (roots.agentDir && enabled.user)
    files.push({ path: join(roots.agentDir, 'mcp.json'), scope: 'user' });
  if (roots.cwd && enabled.project)
    files.push({ path: join(roots.cwd, '.pi', 'mcp.json'), scope: 'project' });
  if (roots.cwd && enabled.local)
    files.push({ path: join(roots.cwd, '.pi', 'mcp.local.json'), scope: 'local' });
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
 *
 * decision 008: "wins" means the same thing for all three tiers and for both
 * kinds of override — a redefinition replaces the earlier entry outright, and a
 * `disabled: true` removes it. `local` over `project` over `user`.
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
  const limit = Math.max(1, Math.min(roots.maxServers ?? sessionServerBudget(), MAX_SERVERS));
  if (servers.length > limit) {
    const dropped = servers.slice(limit).map((item) => item.name);
    diagnostics.push({
      code: 'invalid_entry',
      path: '',
      message: `only the first ${limit} servers declared are started; ${servers.length} were declared, so ${dropped.join(', ')} did not start (each server is a live child process, and every open session starts its own copy of all of them, so this machine allows ${hostServerBudget()} in total)`,
    });
  }
  return { servers: servers.slice(0, limit), diagnostics };
}
