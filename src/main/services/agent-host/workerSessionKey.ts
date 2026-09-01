import path from 'node:path';

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/\/)/;

function nonEmptyPath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be a non-empty path`);
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
  return path.normalize(path.resolve(input));
}

export function normalizedWorkerPathIdentity(value: string, label = 'Worker path'): string {
  const normalized = normalizeWorkerPath(value, label);
  return isWindowsStyle(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
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
