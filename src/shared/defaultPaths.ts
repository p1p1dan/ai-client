export type PathSep = '/' | '\\';

/**
 * The app's own state directory under `$HOME`.
 *
 * ## Why this is a constant and not five string literals
 *
 * It used to be five: `SharedSessionState`, `RemoteAuthBroker`,
 * `RemoteConnectionManager`, `RemoteRuntimeAssets` and the generated remote
 * helper each spelled the directory name themselves. Nothing tied them
 * together, so the directory's identity was a convention rather than a fact —
 * and a rename would have been five independent edits with no way to notice a
 * missed one. `defaultPaths.test.ts` scans the repo and fails if the literal
 * reappears anywhere but here.
 *
 * ## Local vs remote: two different shapes behind one name
 *
 * This constant names the DIRECTORY, and it is used on both sides of a remote
 * connection. The two sides are deliberately NOT the same path:
 *
 *  - **Locally** it is a container, one level above the real root:
 *    `~/.pilab/<profile>/…` (see `main/services/appStatePaths.ts`). The
 *    `<profile>` layer is what keeps a dev build's settings and CREDENTIALS
 *    out of the release build's (plan `unified-credentials`, open-q #1) —
 *    the isolation that used to come for free from `<userData>` having a
 *    `-dev` suffix, and which the credential move out of `<userData>` would
 *    otherwise have thrown away.
 *  - **On a remote machine** it is the root itself: `~/.pilab/…`, no profile
 *    layer. Nothing secret is ever written there, and a remote host's state
 *    belongs to the host, not to which local build reached it.
 *
 * ## The rename (`.aiclient` -> `.pilab`, D59 / plan `unified-credentials` S2)
 *
 * Changing this value is not enough on its own. `main/services/appStateMigration.ts`
 * moves an existing install's bytes across, and must run before any service
 * reads a path. Already-connected REMOTE machines are knowingly left with an
 * orphaned `~/.aiclient/` (D62): their settings return to defaults and the
 * runtime is downloaded once more. That is a release-note item, not a bug.
 */
export const APP_STATE_DIR = '.pilab';

/**
 * The pre-rename name, kept ONLY so the migration can find what it is moving
 * and so adoption can still read a machine that never got migrated.
 *
 * Nothing else may use it: a reader that falls back to the legacy directory
 * forever is a reader that never notices the migration failed.
 */
export const LEGACY_APP_STATE_DIR = '.aiclient';

const JYWAI_ROOT_DIR = 'JYWAI';
const TEMPORARY_DIR = 'temporary';
const WORKSPACES_DIR = 'workspaces';
const REPOS_DIR = 'repos';

function joinPath(pathSep: PathSep, ...segments: string[]): string {
  return segments.filter(Boolean).join(pathSep);
}

function splitPathSegments(inputPath: string): string[] {
  return inputPath.split(/[\\/]+/).filter(Boolean);
}

export function expandHomePath(inputPath: string, homeDir: string, pathSep: PathSep): string {
  if (!inputPath || !homeDir) return inputPath;
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return joinPath(pathSep, homeDir, ...splitPathSegments(inputPath.slice(2)));
  }
  return inputPath;
}

export function getDefaultTemporaryBasePath(homeDir: string, pathSep: PathSep): string {
  return joinPath(pathSep, homeDir || '~', JYWAI_ROOT_DIR, TEMPORARY_DIR);
}

export function getDefaultWorktreeBasePath(homeDir: string, pathSep: PathSep): string {
  return joinPath(pathSep, homeDir || '~', JYWAI_ROOT_DIR, WORKSPACES_DIR);
}

export function getDefaultCloneBaseDir(homeDir: string, pathSep: PathSep): string {
  return joinPath(pathSep, homeDir || '~', JYWAI_ROOT_DIR, REPOS_DIR);
}

export function getEffectiveTemporaryBasePath(
  configuredBasePath: string,
  homeDir: string,
  pathSep: PathSep
): string {
  const basePath = configuredBasePath.trim() || getDefaultTemporaryBasePath(homeDir, pathSep);
  return expandHomePath(basePath, homeDir, pathSep);
}

export function getEffectiveWorktreeBasePath(
  configuredBasePath: string,
  homeDir: string,
  pathSep: PathSep
): string {
  const basePath = configuredBasePath.trim() || getDefaultWorktreeBasePath(homeDir, pathSep);
  return expandHomePath(basePath, homeDir, pathSep);
}

export function getEffectiveCloneBaseDir(
  configuredBasePath: string,
  homeDir: string,
  pathSep: PathSep
): string {
  const basePath = configuredBasePath.trim() || getDefaultCloneBaseDir(homeDir, pathSep);
  return expandHomePath(basePath, homeDir, pathSep);
}

export function getProjectBaseName(projectName: string): string {
  const normalizedName = projectName.replace(/\\/g, '/');
  return normalizedName.split('/').filter(Boolean).pop() || projectName;
}

export function buildWorktreePath(options: {
  branchName: string;
  configuredBasePath: string;
  homeDir: string;
  pathSep: PathSep;
  projectName: string;
}): string {
  const basePath = getEffectiveWorktreeBasePath(
    options.configuredBasePath,
    options.homeDir,
    options.pathSep
  );

  return joinPath(
    options.pathSep,
    basePath,
    getProjectBaseName(options.projectName),
    options.branchName
  );
}
