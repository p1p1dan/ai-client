import path from 'node:path';

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/\/)/;

function nonEmptyPath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be a non-empty path`);
  // A relative path has no meaning here: the key identifies one worker across
  // hosts, and resolving it against whatever cwd this process happens to have
  // would mint a different key for the same file.
  if (!isWindowsStyle(trimmed) && !path.posix.isAbsolute(trimmed))
    throw new Error(`${label} must be an absolute path: ${trimmed}`);
  return trimmed;
}

function isWindowsStyle(value: string): boolean {
  return WINDOWS_ABSOLUTE_PATH.test(value);
}

/**
 * Normalize a host or foreign-platform path without collapsing POSIX case.
 * Windows identity is case-insensitive; the display value keeps segment case
 * while the map key below folds it.
 */
export function normalizeWorkerPath(value: string, label = 'Worker path'): string {
  const input = nonEmptyPath(value, label);
  if (isWindowsStyle(input)) {
    let normalized = path.win32.normalize(input.replaceAll('/', '\\'));
    if (/^[a-z]:/i.test(normalized)) {
      normalized = `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
    }
    return normalized;
  }
  // POSIX input keeps POSIX semantics even when this process runs on Windows:
  // `path.resolve` would mount `/tmp/x` onto the current drive and invent a
  // host-local key for a foreign path.
  return path.posix.normalize(input);
}

export function normalizedWorkerPathIdentity(value: string, label = 'Worker path'): string {
  const normalized = normalizeWorkerPath(value, label);
  return isWindowsStyle(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

/**
 * Identity of a directory: the path identity above with trailing separators
 * dropped, roots (`C:\`, `\\srv\share\`, `/`) kept. Both `normalize` flavours
 * preserve a trailing separator, so it is stripped here by hand.
 */
function directoryIdentity(value: string): string {
  const identity = normalizedWorkerPathIdentity(value, 'Directory path');
  const flavour = isWindowsStyle(identity) ? path.win32 : path.posix;
  const rootLength = flavour.parse(identity).root.length;
  let end = identity.length;
  while (end > rootLength && identity[end - 1] === flavour.sep) end -= 1;
  return identity.slice(0, end);
}

/**
 * Whether two spellings name the same directory, judged by the path's own
 * style rather than the host platform: a Windows-style path (drive letter or
 * UNC) folds separators and case, a POSIX path stays case-sensitive. Both
 * sides are normalized (`.`/`..`, repeated and trailing separators).
 *
 * Purely lexical: `\\?\` prefixes, 8.3 short names, junctions and `subst`
 * drives are not folded. An empty or relative input matches nothing.
 */
export function sameWorkerDirectory(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return directoryIdentity(a) === directoryIdentity(b);
  } catch {
    return false;
  }
}

/**
 * Join a child name onto a worker path in the path's OWN flavour.
 *
 * `path.join` is the host's: running on Windows it rewrites a foreign
 * `/sessions` into `\sessions`, and that string keys as a different file from
 * the one its index row named.
 */
export function joinWorkerPath(directory: string, name: string): string {
  return isWindowsStyle(directory)
    ? path.win32.join(directory, name)
    : path.posix.join(directory, name);
}

export function sessionWorkerKey(sessionFile: string): string {
  return `session:${normalizedWorkerPathIdentity(sessionFile, 'Pi session file')}`;
}

export function workspaceWorkerKey(input: {
  workspacePath: string;
  logicalSessionId: string;
  createToken: string;
}): string {
  const sessionId = input.logicalSessionId.trim();
  const createToken = input.createToken.trim();
  if (!sessionId) throw new Error('Logical session id must be non-empty');
  if (!createToken) throw new Error('Worker create token must be non-empty');
  return `workspace:${normalizedWorkerPathIdentity(input.workspacePath, 'Workspace path')}:session:${sessionId}:create:${createToken}`;
}
