/**
 * T-05 best-effort parser for Grep/Glob tool output into a hit list for the
 * hover popover (A07 F②). Format contract: input is the verbatim
 * `tool_result.content` text after `toolCard.normalizeToolOutput` has
 * flattened it — string as-is, or `{type:'text',text}[]` joined by `\n`
 * (mirrors `eventNormalizer.ts:94-118`'s raw `tool_result.content` passthrough
 * and `historyReader.ts:520-539`'s `stringifyToolResultContent`, which the
 * history replay path already stringifies the same way). History replay caps
 * at 16KB and does not forward its own `truncated` flag onto the block
 * (`sessionHistory.ts:29` / `chatSessions.ts` `mapHistoryBlock`), so this
 * module infers truncation itself: a missing trailing newline is necessary
 * but not sufficient — the last line is only treated as a cut fragment (and
 * dropped) when it also fails to parse as a hit AND everything parsed before
 * it is already trustworthy (T-05 adversarial fix #5). A last line that
 * parses cleanly (e.g. a single complete hit with no trailing newline) is
 * kept as real data instead of being unconditionally discarded.
 *
 * Pure, no fs access, no path-existence checks — a parse failure (returns
 * null) is a legitimate outcome the caller downgrades to a plain
 * click-to-expand row.
 */

export interface ToolHit {
  /** Original path (used to open the file). */
  path: string;
  /** basename — the `--foreground` column. */
  name: string;
  /** dirname — the `--muted-foreground` / `--t-code` column; '' for a root-level file. */
  dir: string;
  /** First matching line number (ripgrep content mode only). */
  line?: number;
}

export interface HitList {
  hits: ToolHit[];
  /** Total de-duplicated paths found (may exceed `hits.length` once `limit` truncates). */
  total: number;
  /** True when the 16KB history cap chopped off the last, incomplete line. */
  truncated: boolean;
}

export interface ParseHitListOptions {
  /** Max hits returned (default 50; the popover scrolls itself — A07 :2519 shows ~10 rows). */
  limit?: number;
  /** Minimum hit count required to trust the parse (default 1). */
  minHits?: number;
  /** Minimum share of non-noise lines that must parse cleanly (default 0.6). */
  minRatio?: number;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_MIN_HITS = 1;
const DEFAULT_MIN_RATIO = 0.6;

/** ① one nested path per line (Glob / `rg -l`) — has a directory separator. */
const PATH_ONLY_RE = /^(?:[A-Za-z]:)?[^\n:]*[\\/][^\\/]+$/;
/**
 * ①b a trustworthy root-level bare filename with no directory separator
 * (README.md, package.json, Makefile, .gitignore — T-05 adversarial fix #6).
 * No extension whitelist needed: the simple criterion is non-empty, no
 * spaces, no natural-language punctuation, so a prose noise line never
 * qualifies by accident.
 */
const BARE_FILENAME_RE = /^[A-Za-z0-9_.-]+$/;
/** ② ripgrep content mode: `path:line:content`. */
const CONTENT_LINE_RE = /^((?:[A-Za-z]:)?[^:]+):(\d+):(.*)$/;
/** ③ noise: summary/status lines and blanks — excluded from the parse-ratio denominator. */
const NOISE_RE = /^(--)?$|^Found\s+\d+\s+files?\b|^No matches found\b/i;

function isNoiseLine(line: string): boolean {
  return NOISE_RE.test(line.trim());
}

function splitPathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function baseName(path: string): string {
  const segments = splitPathSegments(path);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

function dirName(path: string): string {
  const segments = splitPathSegments(path);
  return segments.length > 1 ? segments.slice(0, -1).join('/') : '';
}

export function parseHitList(
  output: string | undefined,
  options: ParseHitListOptions = {}
): HitList | null {
  if (!output) return null;

  const limit = options.limit ?? DEFAULT_LIMIT;
  const minHits = options.minHits ?? DEFAULT_MIN_HITS;
  const minRatio = options.minRatio ?? DEFAULT_MIN_RATIO;

  const endsWithNewline = output.endsWith('\n');
  // A trailing newline produces one synthetic empty split element — drop
  // only that. Without one, the last element is real content (possibly a
  // 16KB history-cap fragment); T-05 adversarial fix #5 decides that
  // per-line below instead of unconditionally dropping it, which used to
  // silently eat a genuine last hit (e.g. a single Glob match with no
  // trailing newline).
  const lines = endsWithNewline ? output.split('\n').slice(0, -1) : output.split('\n');
  let truncated = false;

  let denominator = 0;
  let parseableCount = 0;
  const order: string[] = [];
  const byPath = new Map<string, ToolHit>();

  lines.forEach((line, index) => {
    if (isNoiseLine(line)) return;

    const contentMatch = CONTENT_LINE_RE.exec(line);
    if (contentMatch) {
      denominator += 1;
      parseableCount += 1;
      const path = contentMatch[1].trim();
      const lineNo = Number(contentMatch[2]);
      if (!byPath.has(path)) {
        byPath.set(path, { path, name: baseName(path), dir: dirName(path), line: lineNo });
        order.push(path);
      }
      return;
    }

    if (PATH_ONLY_RE.test(line) || BARE_FILENAME_RE.test(line)) {
      denominator += 1;
      parseableCount += 1;
      const path = line.trim();
      if (!byPath.has(path)) {
        byPath.set(path, { path, name: baseName(path), dir: dirName(path) });
        order.push(path);
      }
      return;
    }

    // Neither pattern matched. The very last line of output with no
    // trailing newline may be a 16KB history-cap fragment rather than
    // ordinary noise — but only treat it that way when everything parsed so
    // far is trustworthy; otherwise it's unstructured noise like any other
    // unparseable line, mid-output or not.
    const isLastLine = index === lines.length - 1;
    const prefixTrustworthy = denominator > 0 && parseableCount / denominator >= minRatio;
    if (isLastLine && !endsWithNewline && prefixTrustworthy) {
      truncated = true;
      return;
    }
    denominator += 1;
  });

  if (denominator === 0) return null;
  if (parseableCount < minHits) return null;
  if (parseableCount / denominator < minRatio) return null;

  const total = order.length;
  const hits = order.slice(0, limit).map((path) => byPath.get(path)!);

  return { hits, total, truncated };
}
