import { isRemoteVirtualPath, parseRemoteVirtualPath } from './remotePath';

/**
 * Path utility functions
 * For cross-platform path normalization
 */

/**
 * WSL UNC path prefixes used across renderer/main.
 * Keep this as the single source of truth for WSL UNC detection rules.
 */
export const WSL_UNC_PREFIXES = ['//wsl.localhost/', '//wsl$/'] as const;

/**
 * Normalize path separators to forward slashes
 * @param p Original path
 * @returns Normalized path
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Safely join path segments and normalize
 * Automatically handles extra slashes
 * @param segments Path segments to join
 * @returns Joined and normalized path
 */
export function joinPath(...segments: string[]): string {
  return segments.filter(Boolean).join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * Remove trailing path separators from a path string.
 * Preserves root paths like "/" and "C:\".
 * @param inputPath Original path
 * @returns Path without trailing separators
 */
export function trimTrailingPathSeparators(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (/^[a-zA-Z]:[\\/]?$/.test(inputPath)) return inputPath;

  const trimmed = inputPath.replace(/[\\/]+$/, '');
  return trimmed || inputPath;
}

/**
 * Canonical comparison key for "is this the same directory" checks across
 * workspace derivation and lookup (round-6 review M5/B4): separator
 * normalization + trailing-separator trim + lowercase. Trailing separators
 * broke self-path matching (`/aaa` vs `/aaa/`); lowercase matches the
 * long-standing `workspaceIdFor` convention (platform-aware case sensitivity
 * for POSIX is tracked as backlog — changing it would change workspace IDs).
 * Comparison key ONLY — never display it or store it as a path.
 * @param inputPath Original path
 * @returns Canonical lowercase comparison key
 */
export function canonicalPathKey(inputPath: string): string {
  return trimTrailingPathSeparators(normalizePath(inputPath)).toLowerCase();
}

const WINDOWS_STYLE_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/;

/**
 * Whether a path is written Windows-style: a drive letter or a UNC prefix.
 * Judged from the spelling, not the platform this code runs on.
 */
export function isWindowsStylePath(inputPath: string): boolean {
  return WINDOWS_STYLE_PATH.test(inputPath);
}

/**
 * `target` relative to the directory `root`, or null when it lies outside it.
 *
 * A Windows-style root matches either separator and ignores case (`E:/x`
 * contains `E:\X\src\a.ts`); any other root is compared verbatim, so POSIX
 * stays case-sensitive. The result is the remainder of `target` in its own
 * spelling, leading separators dropped: `''` for the root itself. Callers that
 * need `/` (git, segment splitting) pass it through `normalizePath`.
 */
export function relativeToRoot(root: string, target: string): string | null {
  if (!root || !target) return null;
  const base = trimTrailingPathSeparators(root);
  const windows = isWindowsStylePath(base);
  const isSeparator = (char: string | undefined) => char === '/' || (windows && char === '\\');
  const key = (value: string) => (windows ? normalizePath(value).toLowerCase() : value);
  if (target.length < base.length || key(target.slice(0, base.length)) !== key(base)) return null;
  let rest = target.slice(base.length);
  // `/repo` must not contain `/repo2`; a root that ends in a separator
  // (`/`, `C:\`) is already on a boundary.
  if (rest && !isSeparator(base[base.length - 1]) && !isSeparator(rest[0])) return null;
  while (isSeparator(rest[0])) rest = rest.slice(1);
  return rest;
}

/**
 * Whether path is a Windows WSL UNC path.
 * Supports both "\\wsl.localhost\..." and "//wsl.localhost/..." forms.
 * @param inputPath Original path
 * @returns True when path points to WSL via UNC prefix
 */
export function isWslUncPath(inputPath: string): boolean {
  const normalized = inputPath.replace(/\\/g, '/');
  return WSL_UNC_PREFIXES.some((prefix) => normalized.toLowerCase().startsWith(prefix));
}

/**
 * Get the final path segment from a filesystem path.
 * Handles both "/" and "\" separators and ignores trailing separators.
 * @param inputPath Original path
 * @returns Last segment or the original input when parsing fails
 */
export function getPathBasename(inputPath: string): string {
  const trimmed = trimTrailingPathSeparators(inputPath);
  if (!trimmed) return inputPath;
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || inputPath;
}

/**
 * Convert an internal path into the value that should be shown to users.
 * Remote virtual paths are unwrapped back to their real remote filesystem path.
 * @param inputPath Original path
 * @returns User-facing path
 */
export function getDisplayPath(inputPath: string): string {
  const resolvedPath = (() => {
    if (!isRemoteVirtualPath(inputPath)) {
      return inputPath;
    }

    try {
      return parseRemoteVirtualPath(inputPath).remotePath;
    } catch {
      return inputPath;
    }
  })();

  return trimTrailingPathSeparators(resolvedPath);
}

/**
 * Get the final user-facing segment from a path.
 * @param inputPath Original path
 * @returns Last display segment
 */
export function getDisplayPathBasename(inputPath: string): string {
  return getPathBasename(getDisplayPath(inputPath));
}
