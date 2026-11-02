/**
 * DSH 0.2.1's session working directory (decision 207 §7): the model can `cd`
 * with `working_directory`; the workspace (the session header's cwd) never
 * changes. Pure, for the host, the history projection and the renderer alike:
 * where a directory sits relative to the workspace.
 */

/** Where a directory is relative to the workspace. */
export type DirectoryRelation =
  | { kind: 'same' }
  /** Inside, as a `/`-separated path relative to the workspace (`packages/web`). */
  | { kind: 'inside'; relative: string }
  /** Outside, as given. */
  | { kind: 'outside'; path: string };

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** Separators as `/`, no trailing separator; Windows paths compared case-insensitively. */
function comparable(path: string, windows: boolean): string {
  const slashed = path.replace(/\\/g, '/');
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
  return windows ? trimmed.toLowerCase() : trimmed;
}

export function directoryRelation(workspace: string, directory: string): DirectoryRelation {
  const windows = WINDOWS_PATH.test(workspace) || WINDOWS_PATH.test(directory);
  const base = comparable(workspace, windows);
  const target = comparable(directory, windows);
  if (target === base) return { kind: 'same' };
  const prefix = base.endsWith('/') ? base : `${base}/`;
  if (target.startsWith(prefix)) {
    // The original spelling's case, from the comparable path's length.
    const relative = directory.replace(/\\/g, '/').replace(/\/+$/, '').slice(prefix.length);
    return { kind: 'inside', relative };
  }
  return { kind: 'outside', path: directory };
}

/**
 * The directory a tool row records for its call: none in the workspace
 * itself, the relative path inside it, the absolute path outside it.
 */
export function callDirectory(workspace: string, directory: string): string | undefined {
  const relation = directoryRelation(workspace, directory);
  if (relation.kind === 'same') return undefined;
  return relation.kind === 'inside' ? relation.relative : relation.path;
}

/** Whether a recorded call directory (`callDirectory`) is outside the workspace. */
export function isOutsideCallDirectory(cwd: string): boolean {
  return cwd.startsWith('/') || WINDOWS_PATH.test(cwd);
}

/** The chip under the composer: none while the session is in its workspace. */
export type WorkingDirectoryChip = { kind: 'inside' | 'outside'; text: string };

export function workingDirectoryChip(
  workspace: string | null | undefined,
  directory: string | null | undefined
): WorkingDirectoryChip | undefined {
  if (!workspace || !directory) return undefined;
  const relation = directoryRelation(workspace, directory);
  if (relation.kind === 'same') return undefined;
  return relation.kind === 'inside'
    ? { kind: 'inside', text: relation.relative }
    : { kind: 'outside', text: relation.path };
}
