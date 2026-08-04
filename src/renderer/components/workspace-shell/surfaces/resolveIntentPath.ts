/**
 * T-13 spec §3 "路径绝对化在消费层": turns a raw `FileOpenIntent.path` (which
 * may come from a Read tool row, a Grep/Glob hit, or a composer `@mention`
 * chip — always relative there) into an absolute path `navigateToFile` can
 * open, or `null` when the request is not resolvable/safe.
 *
 * Absolute paths (POSIX, Windows drive letters, UNC/WSL-UNC) are normalized
 * and passed through AS-IS, deliberately not constrained to the workspace
 * root: the editor is not a sandbox, and opening a tool-reported absolute
 * path outside the workspace is a legitimate, user-visible action (R4 GUI
 * checklist: Read absolute / Grep relative / Glob relative / @ chip /
 * malicious `../`). This differs from Codex's in-domain-only counter-proposal
 * for the same case — registered here as the deliberate divergence (spec §3).
 *
 * Relative paths join the workspace root; a `..` that would climb above the
 * root resolves to `null` rather than silently escaping it. An absolute
 * path's own `..`/`.` segments are collapsed too (adversarial review m8): a
 * `..` that climbs past ITS OWN root just clamps there instead of escaping
 * or erasing the path (real filesystem `..`-at-root behavior) — so the same
 * file opened two different ways collapses to one resolved path, which
 * matters because tab identity downstream is plain string equality.
 */
import { normalizePath, trimTrailingPathSeparators } from '@shared/utils/path';

/**
 * `//...` covers POSIX root, UNC (`\\server\share` → `//server/share`) and
 * WSL UNC alike. Exported so `EditorSurfaceView`'s intent-consumption effect
 * can tell "this needs a workspace root" apart from "this is unresolvable
 * regardless of workspace" without re-deriving the same rule.
 */
export function isAbsoluteIntentPath(normalized: string): boolean {
  if (normalized.startsWith('/')) {
    return true;
  }
  // Windows drive letter, e.g. "C:/Users/dan" after backslash normalization.
  return /^[a-zA-Z]:\//.test(normalized);
}

/**
 * Bare `C:` or drive-relative `C:foo` (backslash-normalized from `C:foo\bar`)
 * — a leading drive letter with no separator right after it (adversarial
 * review m7). This resolver cannot place it: it is not a full absolute path
 * (no root after the drive) and joining it onto a POSIX-style workspace root
 * as an ordinary relative segment would produce garbage like `/repo/C:foo`.
 * Treated as unresolvable rather than guessed at.
 */
function isBareOrDriveRelativePath(normalized: string): boolean {
  return /^[a-zA-Z]:/.test(normalized) && !isAbsoluteIntentPath(normalized);
}

/** Leading separator style to preserve when rejoining resolved segments. */
function rootPrefix(root: string): string {
  if (root.startsWith('//')) {
    return '//';
  }
  if (root.startsWith('/')) {
    return '/';
  }
  return '';
}

/**
 * Joins `relative` onto `root`, rejecting any `..` that would climb above
 * `root` itself (a `..` that stays within the root, e.g. `src/../lib`, is
 * fine). Returns `null` on escape.
 */
function resolveRelativeWithinRoot(root: string, relative: string): string | null {
  const rootSegments = root.split('/').filter(Boolean);
  const stack = [...rootSegments];

  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length <= rootSegments.length) {
        return null;
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  return rootPrefix(root) + stack.join('/');
}

/**
 * Collapses `.`/`..` segments within `body`, the part of an already-absolute
 * path after `prefix` (adversarial review m8). `unclimbableCount` is how
 * many leading segments of `body` form the path's own root and can never be
 * popped by a `..`: 0 for POSIX `/` and drive letters, whose root IS
 * `prefix` itself; 2 for UNC/WSL-UNC `//server/share`, whose server+share
 * pair is the root and lives in `body`, not `prefix`. A `..` that would
 * climb past that clamps at the root instead of escaping — normalization
 * for tab identity, not an access boundary (absolute paths are intentionally
 * not sandboxed to the workspace, see file header).
 */
function collapseAbsoluteDotSegments(
  prefix: string,
  body: string,
  unclimbableCount: number
): string {
  const stack: string[] = [];

  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length > unclimbableCount) {
        stack.pop();
      }
      continue;
    }
    stack.push(segment);
  }

  return prefix + stack.join('/');
}

/** Dispatches an absolute path to `collapseAbsoluteDotSegments` with the right root shape. */
function collapseAbsolutePath(normalized: string): string {
  if (normalized.startsWith('//')) {
    return collapseAbsoluteDotSegments('//', normalized.slice(2), 2);
  }
  if (normalized.startsWith('/')) {
    return collapseAbsoluteDotSegments('/', normalized.slice(1), 0);
  }
  // Windows drive letter, e.g. "C:/Users/dan/..": prefix is "C:/".
  return collapseAbsoluteDotSegments(normalized.slice(0, 3), normalized.slice(3), 0);
}

/**
 * @param raw Intent path as recorded on `FileOpenIntent` — untouched user/tool input.
 * @param workspacePath Active workspace root, or null/undefined if none resolved yet.
 * @returns Absolute, separator-normalized path, or `null` when unresolvable.
 */
export function resolveIntentPath(
  raw: string,
  workspacePath: string | null | undefined
): string | null {
  if (!raw) {
    return null;
  }

  const normalizedRaw = normalizePath(raw);

  if (isBareOrDriveRelativePath(normalizedRaw)) {
    return null;
  }

  if (isAbsoluteIntentPath(normalizedRaw)) {
    return collapseAbsolutePath(normalizedRaw);
  }

  if (!workspacePath) {
    return null;
  }

  const normalizedRoot = trimTrailingPathSeparators(normalizePath(workspacePath));
  return resolveRelativeWithinRoot(normalizedRoot, normalizedRaw);
}
