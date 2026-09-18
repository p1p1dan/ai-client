import { relative, sep } from 'node:path';

/**
 * Enough `.gitignore` to keep a search out of build output (tools-20).
 *
 * Why not the real thing: git's ignore semantics carry precedence between
 * `.gitignore`, `.git/info/exclude`, the global excludes file and the index,
 * plus escapes and `**` in the middle of a pattern. What the search needs is
 * narrower — do not walk `build/`, `obj/`, `dist/`, `*.o` — and it needs it
 * without adding a dependency to a package that is installed here only as a
 * transitive of pi-agent-core. So this covers the four forms that do the work:
 *
 * - `name` — matches an entry of that name at any depth below the file
 * - `/name`, `dir/name` — measured from the directory the file sits in
 * - `name/` — directories only
 * - `!name` — un-ignores, last matching rule winning as it does in git
 *
 * Deliberately NOT covered: backslash escapes, `**` in the middle of a
 * pattern, character classes, and the `.gitignore` of a directory the walk
 * never enters. A rule that is not understood is a rule that does not match,
 * which shows the model more files rather than fewer — the safe direction for
 * a search.
 */
export interface IgnoreRule {
  /** `!pattern` — a later match flips the entry back to visible. */
  negated: boolean;
  /** `pattern/` — a file of that name stays visible. */
  directoryOnly: boolean;
  /** Tested against the path relative to `IgnoreLayer.base` rather than the name. */
  anchored: boolean;
  expression: RegExp;
}

/** One `.gitignore` file's rules, plus the directory they are measured from. */
export interface IgnoreLayer {
  base: string;
  rules: readonly IgnoreRule[];
}

/** Regex metacharacters that are literal in a glob. `*` and `?` are handled separately. */
const LITERAL = /[.+^${}()|[\]\\]/g;

function segmentExpression(segment: string): string {
  if (segment === '**') return '.*';
  return segment
    .split('*')
    .map((part) => part.replace(LITERAL, '\\$&').replaceAll('?', '[^/]'))
    .join('[^/]*');
}

/**
 * Compile one `.gitignore` file, or nothing when it holds no usable rule.
 *
 * `base` is the directory the file was read from; every anchored rule is
 * measured from there, which is what makes an inherited layer keep working as
 * the walk descends.
 */
export function parseGitignore(base: string, text: string): IgnoreLayer | undefined {
  const rules: IgnoreRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    let pattern = line.trim();
    if (!pattern || pattern.startsWith('#')) continue;
    let negated = false;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let directoryOnly = false;
    while (pattern.endsWith('/')) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }
    // `**/name` is git's spelling of "at any depth", which is what an
    // un-anchored pattern already means here.
    while (pattern.startsWith('**/')) pattern = pattern.slice(3);
    const rooted = pattern.startsWith('/');
    if (rooted) pattern = pattern.replace(/^\/+/, '');
    if (!pattern || pattern === '.' || pattern === '..') continue;
    // git: a separator anywhere but the end makes the pattern relative to the
    // file's own directory; without one it matches a name at any depth.
    const anchored = rooted || pattern.includes('/');
    let expression: RegExp;
    try {
      expression = new RegExp(
        `^${pattern.split('/').map(segmentExpression).join('/')}$`,
        // Windows checkouts are case-insensitive in practice (`core.ignorecase`
        // defaults to true there), and the same file would otherwise be ignored
        // on one machine and walked on another.
        process.platform === 'win32' ? 'i' : ''
      );
    } catch {
      continue;
    }
    rules.push({ negated, directoryOnly, anchored, expression });
  }
  return rules.length ? { base, rules } : undefined;
}

/**
 * Whether the ignore layers in scope hide this entry.
 *
 * Layers are applied outermost first and the last match wins, so a deeper
 * `.gitignore` overrides a shallower one — git's own precedence.
 */
export function isIgnored(
  layers: readonly IgnoreLayer[],
  path: string,
  directory: boolean
): boolean {
  let ignored = false;
  for (const layer of layers) {
    const candidate = relative(layer.base, path).replaceAll(sep, '/');
    if (!candidate || candidate === '..' || candidate.startsWith('../')) continue;
    const name = candidate.slice(candidate.lastIndexOf('/') + 1);
    for (const rule of layer.rules) {
      if (rule.directoryOnly && !directory) continue;
      if (!rule.expression.test(rule.anchored ? candidate : name)) continue;
      ignored = !rule.negated;
    }
  }
  return ignored;
}
