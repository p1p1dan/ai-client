/**
 * H/19 U4 — install, remove, list and enable the user's own pi extensions.
 *
 * Every install and removal is pi's own CLI, run against this app's agent
 * directory. Nothing here reimplements package resolution, and nothing here
 * touches `node_modules` — see `@shared/piPlugins` for why that is the whole
 * design.
 *
 * The one thing this module writes itself is `settings.json`'s `packages`
 * array, and only to flip an entry between its two legal forms (a bare source
 * string = load everything, `{source, autoload:false}` = installed but loads
 * nothing). pi ships no CLI verb for that — `pi config` is an interactive TUI —
 * and an app that could install a plugin but not turn one off would push people
 * into uninstall/reinstall cycles that re-download every time.
 *
 * ## Reading the list
 *
 * `pi list` prints the source and, indented under it, the resolved path:
 *
 * ```
 * User packages:
 *   npm:@scope/name
 *     /home/u/.pilab/pi-agent/npm/node_modules/@scope/name
 * ```
 *
 * That output is the SOURCE OF TRUTH for what is installed, because it is pi's
 * own resolution. `settings.json` is read alongside it for one fact the listing
 * does not carry: whether an entry is autoload-disabled.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkPluginSource,
  PI_PLUGIN_COMMAND_TIMEOUT_MS,
  type PiPluginCommandResult,
  type PiPluginView,
  pluginDisplayName,
} from '@shared/piPlugins';

export interface PiPluginRunner {
  /** Runs the bundled pi CLI with these arguments in the app's agent directory. */
  run(args: string[]): Promise<PiPluginCommandResult>;
}

export interface PiPluginServiceOptions {
  agentDir: string;
  runner: PiPluginRunner;
}

/** pi's `PackageSource`, restated — see `permissionPlugin.ts` for why it is not imported. */
type PackageSource = string | { source: string; autoload?: boolean; [key: string]: unknown };

const SETTINGS_FILE = 'settings.json';

export class PiPluginService {
  private readonly agentDir: string;
  private readonly runner: PiPluginRunner;

  constructor(options: PiPluginServiceOptions) {
    this.agentDir = options.agentDir;
    this.runner = options.runner;
  }

  get settingsPath(): string {
    return join(this.agentDir, SETTINGS_FILE);
  }

  async list(): Promise<PiPluginView[]> {
    const result = await this.runner.run(['list']);
    // A failed listing is NOT reported as "no plugins": that reads as a
    // successful empty state and invites someone to reinstall over a working
    // set. The error travels to the caller instead.
    if (!result.ok) throw new Error(result.output || 'pi list failed');
    const listed = parsePiList(result.output);
    const disabled = this.disabledSources();
    return listed.map((row) => ({
      source: row.source,
      name: pluginDisplayName(row.source),
      ...(row.path ? { path: row.path } : {}),
      enabled: !disabled.has(row.source),
    }));
  }

  async install(source: string): Promise<PiPluginCommandResult> {
    const issue = checkPluginSource(source);
    if (issue) return { ok: false, output: `That package source is not usable: ${issue}` };
    // No `-l`: project scope is off in managed mode and this app never offers
    // it, so passing it here could only produce an install nothing loads.
    return this.runner.run(['install', source.trim()]);
  }

  async remove(source: string): Promise<PiPluginCommandResult> {
    const issue = checkPluginSource(source);
    if (issue) return { ok: false, output: `That package source is not usable: ${issue}` };
    return this.runner.run(['remove', source.trim()]);
  }

  /**
   * Flip one entry between its two forms, leaving every other setting alone.
   *
   * Read-modify-write of a file pi also writes. The window is small (this runs
   * on a user click, pi writes `packages` only during install/remove, and this
   * app serialises both through the same service), and the write is atomic via
   * a rename, so the failure mode is a lost toggle rather than a truncated
   * settings file.
   */
  setEnabled(source: string, enabled: boolean): void {
    const settings = this.readSettings();
    const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
    const index = packages.findIndex((entry) => sourceOf(entry as PackageSource) === source.trim());
    if (index < 0) throw new Error(`No installed plugin named ${source}`);
    const current = packages[index] as PackageSource;
    if (enabled) {
      // Back to the bare string only when nothing else was configured on the
      // entry — a `{source, skills:[...]}` filter the user wrote by hand must
      // survive a toggle.
      packages[index] = onlyAutoloadFlag(current) ? source.trim() : stripAutoload(current);
    } else {
      packages[index] =
        typeof current === 'string'
          ? { source: current, autoload: false }
          : { ...current, autoload: false };
    }
    this.writeSettings({ ...settings, packages });
  }

  private disabledSources(): Set<string> {
    const settings = this.readSettings();
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    const disabled = new Set<string>();
    for (const entry of packages as PackageSource[]) {
      if (typeof entry !== 'string' && entry && entry.autoload === false) {
        disabled.add(sourceOf(entry));
      }
    }
    return disabled;
  }

  private readSettings(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.settingsPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private writeSettings(settings: Record<string, unknown>): void {
    mkdirSync(this.agentDir, { recursive: true });
    const temporary = `${this.settingsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.settingsPath);
  }
}

/** One row of `pi list` output. */
interface ListedPackage {
  source: string;
  path?: string;
}

/**
 * A trailing note pi adds after a source, such as ` (filtered)`.
 *
 * Measured, not guessed: an entry written as `{source, autoload:false}` lists
 * as `npm:pi-jingle (filtered)`. Leaving it attached makes the source contain a
 * space, which `checkPluginSource` rejects — so every DISABLED plugin would
 * vanish from the list, and the only way back would be to edit the settings
 * file by hand. The note itself is dropped rather than shown, because
 * `settings.json` already tells this app the same thing more precisely.
 */
const LIST_ANNOTATION = /\s+\([^()]*\)$/;

/**
 * Parse `pi list`.
 *
 * Indentation carries the meaning: two spaces is a source, four is the path of
 * the source above it. A section header (`User packages:` / `Project
 * packages:`) and the empty-state line (`No packages installed.`) are
 * unindented. Rows whose source still fails validation after the annotation is
 * stripped are dropped — a line this app cannot round-trip to `pi remove` is
 * not one it should offer a Remove button for.
 */
export function parsePiList(output: string): ListedPackage[] {
  const rows: ListedPackage[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (indent === 0) continue;
    if (indent >= 4) {
      const last = rows[rows.length - 1];
      if (last && !last.path) last.path = line;
      continue;
    }
    const source = line.replace(LIST_ANNOTATION, '');
    if (checkPluginSource(source)) continue;
    rows.push({ source });
  }
  return rows;
}

function sourceOf(entry: PackageSource): string {
  return typeof entry === 'string' ? entry.trim() : String(entry.source ?? '').trim();
}

/** True when the object form carries nothing but `source` and `autoload`. */
function onlyAutoloadFlag(entry: PackageSource): boolean {
  if (typeof entry === 'string') return true;
  return Object.keys(entry).every((key) => key === 'source' || key === 'autoload');
}

function stripAutoload(entry: PackageSource): PackageSource {
  if (typeof entry === 'string') return entry;
  const { autoload: _autoload, ...rest } = entry;
  return rest as PackageSource;
}

/**
 * The default runner: the bundled CLI, in this app's agent directory.
 *
 * `execFile` and not a shell — the source is already validated, and a shell
 * would make that validation the only thing standing between a package name and
 * command execution. The working directory is the agent dir so a project's
 * `.pi/` cannot influence the run.
 */
export function createPiCliRunner(input: {
  nodePath: string;
  cliPath: string;
  env: Record<string, string>;
  cwd: string;
}): PiPluginRunner {
  return {
    run: (args) =>
      new Promise<PiPluginCommandResult>((resolve) => {
        if (!existsSync(input.cwd)) mkdirSync(input.cwd, { recursive: true });
        execFile(
          input.nodePath,
          [input.cliPath, ...args],
          {
            cwd: input.cwd,
            env: input.env,
            timeout: PI_PLUGIN_COMMAND_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
            if (!error) {
              resolve({ ok: true, output });
              return;
            }
            // `install` reaches the npm registry: the useful message is almost
            // always in the output, and the Error's own text is "Command
            // failed". Fall back to it only when there is no output at all.
            resolve({ ok: false, output: output || error.message });
          }
        );
      }),
  };
}
