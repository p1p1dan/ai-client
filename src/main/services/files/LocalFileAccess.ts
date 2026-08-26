import path from 'node:path';

type AllowedLocalFileOwner = number | string;

interface AllowedRootEntry {
  owners: Set<string>;
}

const allowedRoots = new Map<string, AllowedRootEntry>();

/**
 * Exported for `PickedAttachmentAccess`, which compares user-picked paths with
 * the same rules: one normalisation, not two that can drift apart on the two
 * case-insensitive platforms.
 */
export function normalizePathForComparison(inputPath: string): string {
  let resolved = path.resolve(inputPath);
  resolved = resolved.replace(/[\\/]+$/, '');

  if (process.platform === 'win32' || process.platform === 'darwin') {
    resolved = resolved.toLowerCase();
  }

  return resolved;
}

function normalizeOwner(owner: AllowedLocalFileOwner): string {
  return typeof owner === 'number' ? `webcontents:${owner}` : owner;
}

export function registerAllowedLocalFileRoot(
  rootPath: string,
  owner: AllowedLocalFileOwner = 'global'
): void {
  const normalizedRoot = normalizePathForComparison(rootPath);
  const entry = allowedRoots.get(normalizedRoot) ?? { owners: new Set<string>() };
  entry.owners.add(normalizeOwner(owner));
  allowedRoots.set(normalizedRoot, entry);
}

export function unregisterAllowedLocalFileRoot(
  rootPath: string,
  owner: AllowedLocalFileOwner = 'global'
): void {
  const normalizedRoot = normalizePathForComparison(rootPath);
  const entry = allowedRoots.get(normalizedRoot);
  if (!entry) return;

  entry.owners.delete(normalizeOwner(owner));
  if (entry.owners.size === 0) {
    allowedRoots.delete(normalizedRoot);
  }
}

export function unregisterAllowedLocalFileRootsByOwner(owner: AllowedLocalFileOwner): void {
  const normalizedOwner = normalizeOwner(owner);

  for (const [root, entry] of allowedRoots.entries()) {
    entry.owners.delete(normalizedOwner);
    if (entry.owners.size === 0) {
      allowedRoots.delete(root);
    }
  }
}

export function isAllowedLocalFilePath(filePath: string): boolean {
  if (allowedRoots.size === 0) return false;

  const normalizedFilePath = normalizePathForComparison(filePath);

  for (const root of allowedRoots.keys()) {
    if (normalizedFilePath === root) return true;
    if (normalizedFilePath.startsWith(`${root}${path.sep}`)) return true;
  }

  return false;
}

/**
 * The guard for the WRITE primitives, as an assertion rather than a boolean.
 *
 * ## What it closes
 *
 * `file:copy` / `file:rename` / `file:move` / `file:delete` / `file:createDir`
 * took whatever absolute path the renderer handed them. That made each of them
 * a whole-disk primitive reachable from renderer code: `file:delete` defaults
 * to `recursive: true`, and `file:copy` was once usable to overwrite a file
 * inside an authorised attachment path and turn a read grant into a read of
 * something else (that particular route is closed by the fd-snapshot check, but
 * the primitive it abused was never narrowed).
 *
 * The roots are the ones the file tree already registers when it lists a
 * repository (`file:list` with its `gitRoot`), which is exactly the set every
 * legitimate caller works inside: the three renderer files that reach these
 * channels are the file explorer, its hook, and the source-control panel.
 *
 * ## Why it throws instead of returning false
 *
 * A refused write must be visible. Returning false invites the caller to shrug
 * and continue, and a silently-skipped delete looks to the user exactly like a
 * delete that worked — which is worse than either alternative. The message
 * names the path AND the reason, because the one plausible false positive is a
 * root that was never registered (nothing listed it), and that is a bug in the
 * caller worth reading rather than a security event.
 */
export function assertLocalPathWritable(filePath: string, operation: string): void {
  if (isAllowedLocalFilePath(filePath)) return;
  throw new Error(
    `${operation}: refused — ${filePath} is outside every opened repository. ` +
      'These channels only operate inside a workspace the file tree has listed.'
  );
}
