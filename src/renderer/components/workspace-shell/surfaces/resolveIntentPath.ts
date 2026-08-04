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
 * root resolves to `null` rather than silently escaping it.
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
  if (isAbsoluteIntentPath(normalizedRaw)) {
    return normalizedRaw;
  }

  if (!workspacePath) {
    return null;
  }

  const normalizedRoot = trimTrailingPathSeparators(normalizePath(workspacePath));
  return resolveRelativeWithinRoot(normalizedRoot, normalizedRaw);
}
