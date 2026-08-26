export type PathSep = '/' | '\\';

/**
 * The app's own state directory under `$HOME` — settings, session state, and
 * the remote-connection working files all live under it.
 *
 * ## Why this is a constant and not five string literals
 *
 * It used to be five: `SharedSessionState`, `RemoteAuthBroker`,
 * `RemoteConnectionManager`, `RemoteRuntimeAssets` and the generated remote
 * helper each spelled `'.aiclient'` themselves. Nothing tied them together,
 * so the directory's identity was a convention rather than a fact — and a
 * rename would have been five independent edits with no way to notice a
 * missed one. `defaultPaths.test.ts` now scans the repo and fails if the
 * literal reappears anywhere but here.
 *
 * A rename is planned (`.pilab`, D59 / plan `unified-credentials`), which is
 * what forced the consolidation; changing the value here is deliberately NOT
 * enough on its own — see that plan for the migration this directory needs
 * (existing installs, and the orphaned copy left on already-connected remote
 * machines).
 */
export const APP_STATE_DIR = '.aiclient';

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
