/**
 * The user's home directory as this app resolves it for its OWN files and
 * for `~`. Pure: platform, environment and the OS answer are parameters.
 *
 * ## Windows ignores `HOME`
 *
 * Windows has no `HOME` of its own; when one is set, a third-party tool put it
 * there for itself. Cadence SPB / Allegro sets a machine-wide
 * `HOME=D:\cadence\Cadence\SPB_Data` — its own config directory — and a field
 * report (V1.2.1, 2026-10-30) found the app writing `.pilab` into it on every
 * start, because every Main caller read `HOME` before `USERPROFILE`.
 *
 * Node's `os.homedir()` already reads `USERPROFILE` on Windows, so the DSH
 * host, `adoption.ts` and the skill catalog were using the profile directory
 * all along; reading `HOME` first split the app across two homes. Windows
 * therefore takes `USERPROFILE`, then the OS answer, and never `HOME`.
 *
 * Everywhere else `HOME` stays first, as every pre-existing caller had it, so
 * a test or shell that overrides `HOME` keeps moving the root with it.
 *
 * Only the app's own resolution changes: child processes still inherit `HOME`
 * untouched, because the tool that set it may rely on it.
 */
export function resolveUserHome(input: {
  platform: string;
  env: Record<string, string | undefined>;
  osHome: string;
}): string {
  const { env } = input;
  if (input.platform === 'win32') {
    return env.USERPROFILE || input.osHome;
  }
  return env.HOME || env.USERPROFILE || input.osHome;
}

/**
 * `HOME` when a Windows process has one that is NOT the user's home — the
 * directory older builds wrote `.pilab` into. `null` everywhere else, and when
 * `HOME` and the profile name the same directory.
 */
export function strayWindowsHome(input: {
  platform: string;
  env: Record<string, string | undefined>;
  osHome: string;
}): string | null {
  if (input.platform !== 'win32') return null;
  const stray = input.env.HOME?.trim();
  if (!stray) return null;
  const home = resolveUserHome(input);
  return sameWindowsPath(stray, home) ? null : stray;
}

function sameWindowsPath(a: string, b: string): boolean {
  const normalize = (path: string) =>
    path
      .replace(/[\\/]+/g, '\\')
      .replace(/\\$/, '')
      .toLowerCase();
  return normalize(a) === normalize(b);
}
