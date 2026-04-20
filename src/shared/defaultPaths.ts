export type PathSep = '/' | '\\';

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
