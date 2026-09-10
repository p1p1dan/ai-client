/**
 * H/19 U4 — the extensions a user installed for themselves.
 *
 * ## Why this is pi's own package manager and not one of ours
 *
 * `pi install <source>` already puts a package exactly where a session will
 * find it — `<agentDir>/npm/node_modules/` plus a line in
 * `<agentDir>/settings.json` — and `pi remove` genuinely deletes both. Since
 * H/19 that agent directory is ours in both modes, so nothing needs moving and
 * there is nothing for a second package manager to add. PI-Desktop's own
 * manager (4521 lines, five directories, a manifest validator) was measured
 * against this and judged too heavy for what it buys.
 *
 * ## Enabled is not the same as installed
 *
 * pi's `packages` array takes either a bare source string, which loads
 * everything in the package, or `{ source, autoload: false }`, which installs
 * the package and loads nothing from it. That second form is what pi's own
 * `pi config` TUI writes, and it is what this app's enable switch toggles — so
 * turning a plugin off keeps the download and the settings line, and turning it
 * back on costs no network.
 */

/** One installed package, as the settings page renders it. */
export interface PiPluginView {
  /** pi's own source string: `npm:@scope/name`, a git URL, a path. */
  source: string;
  /** Display name — the package name when the source carries one. */
  name: string;
  /** Absolute path pi resolved, when `pi list` reported one. */
  path?: string;
  /** False when the settings entry sets `autoload: false`. */
  enabled: boolean;
}

/**
 * Which permission system this app's sessions are actually running.
 *
 * Not a control — a statement. A user who installs their own copy of the
 * permission system takes over tool approval for every session, and they are
 * entitled to see that they did (H/19: conflicts are the user's responsibility,
 * which only works if the handover is visible).
 */
export type PermissionSystemOwner = 'bundled' | 'user_configured' | 'unknown';

export interface PiPluginState {
  plugins: PiPluginView[];
  /** `<agentDir>/settings.json` — shown so the user can find the file. */
  settingsPath: string;
  /**
   * Absent on the managed route. Project-level installs (`pi install -l`) are
   * ignored there because `AICLIENT_PI_TRUST_PROJECT_CONFIG=0` disables project
   * config wholesale, so this app never offers that option — see
   * {@link PROJECT_SCOPE_UNAVAILABLE}.
   */
  projectScopeAvailable: boolean;
  permissionSystem: PermissionSystemOwner;
  /**
   * Present when the listing itself failed. `plugins` is then empty, and the
   * page says so rather than rendering an empty list as "you have none" — the
   * reading that gets someone to reinstall over a working set.
   */
  error?: string;
}

/**
 * What one `pi install` / `pi remove` produced.
 *
 * The CLI's own combined output is carried verbatim on failure rather than
 * replaced with a sentence of ours: `install` fails for npm's reasons (a name
 * that does not exist, a registry that is unreachable, a proxy), and those
 * messages are the ones a user can act on.
 */
export interface PiPluginCommandResult {
  ok: boolean;
  output: string;
}

export const PROJECT_SCOPE_UNAVAILABLE =
  'Project-level plugins are ignored on the managed route, so this app installs to your account only.';

/** How long a single `pi` package command may run before it is killed. */
export const PI_PLUGIN_COMMAND_TIMEOUT_MS = 180_000;

/**
 * Everything that is not a plausible package source.
 *
 * The source reaches a child process's argv, so it is validated rather than
 * quoted: a value with a newline, a shell metacharacter or a leading `-` is
 * refused outright. `-` matters most — a source that starts with one would be
 * read by the CLI as a FLAG, which is how "install this" becomes "run with
 * these options".
 */
export function checkPluginSource(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > 512) return 'too long';
  if (trimmed.startsWith('-')) return 'starts with a dash, which pi would read as an option';
  if (/[\s;&|`$<>"'\\]/.test(trimmed)) return 'contains characters a package source cannot have';
  return null;
}

/**
 * A display name for a source.
 *
 * `npm:@scope/name` → `@scope/name`; a git URL → its last path segment without
 * `.git`; anything else is shown as typed, because guessing further would put a
 * name on screen that matches nothing the user can search for.
 */
export function pluginDisplayName(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith('npm:')) return trimmed.slice('npm:'.length) || trimmed;
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  const segments = withoutQuery.replace(/[/\\]+$/, '').split(/[/\\]/);
  const last = segments[segments.length - 1];
  if (!last) return trimmed;
  return last.endsWith('.git') ? last.slice(0, -'.git'.length) : last;
}
