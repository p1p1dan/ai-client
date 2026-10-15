/**
 * The `grep` tool of the `aiclient-fs-search` row (dsh-rebase decision 190),
 * as pure functions: the model-facing schema and wording, argument checks,
 * the ripgrep argv, parsing of ripgrep's output, and the paged rendering.
 *
 * It replaces dsh-tool-fs-search's three-argument grep (`pattern`, `path`,
 * `include`, capped at 250 matches) with what a coding agent needs from one
 * search: three output modes, context lines, case folding, file types,
 * multiline patterns and paging. Ripgrep's own output shapes are kept
 * (`path:line:text`, `path-line-text` for context, `--` between groups,
 * `path:count`) because models know them, and the hit list of a tool row
 * already reads them (`toolHits.ts` in the renderer).
 *
 * No DSH imports, so the rules are testable without a host: `grepTool.ts`
 * registers the tool and runs ripgrep through `ctx.subprocess`.
 */

/** What one call lists. */
export type GrepOutputMode = 'content' | 'files_with_matches' | 'count';

export const GREP_OUTPUT_MODES: readonly GrepOutputMode[] = [
  'content',
  'files_with_matches',
  'count',
];

/** Claude Code's default too: a broad search should list files before it prints lines. */
export const DEFAULT_GREP_OUTPUT_MODE: GrepOutputMode = 'files_with_matches';

/** Entries one call shows when it names no `head_limit`. */
export const DEFAULT_GREP_HEAD_LIMIT = 250;

/** The largest `-A` / `-B` / `-C` a call may ask for. */
export const MAX_GREP_CONTEXT_LINES = 100;

/** Shown in place of a line ripgrep could not decode as UTF-8 (dsh-tool-fs-search's wording). */
export const NON_UTF8_LINE = '(line is not valid UTF-8)';

/** Appended to a line cut at `maxLineBytes` (dsh-tool-fs-search's wording). */
export const LINE_TRUNCATED = ' (line truncated)';

export const GREP_TOOL_DESCRIPTION = [
  'Search file contents with a ripgrep regular expression.',
  'Searches hidden files too and honours .gitignore, but never VCS metadata such as .git.',
  'output_mode picks what comes back: "files_with_matches" (the default) lists the matching files, most recently modified first; "content" prints matching lines as path:line:text, with -A / -B / -C lines of context printed as path-line-text and "--" between separate groups; "count" prints path:count, the matching lines per file.',
  'Results are paged: at most head_limit entries (lines in content mode, files otherwise; 250 by default) starting at offset, and a capped result says which offset fetches the next page.',
  'Narrow with path, glob or type rather than paging through a broad search.',
].join(' ');

/** The prompt section beside the tool (dsh-tool-fs-search's `tool:grep` slot). */
export const GREP_TOOL_GUIDANCE =
  'Use the grep tool, not shell grep, rg or Select-String, to search file contents. Start a broad search with output_mode files_with_matches or count, then use content with -C for the lines around the matches you need.';

/** The model-facing parameters, in DSH's schema DSL (`defineTool`). */
export const GREP_PARAMETERS = {
  pattern: {
    type: 'string',
    required: true,
    description:
      'Regular expression to search for, in ripgrep (Rust regex) syntax. Escape regex characters you mean literally, e.g. "interface\\{\\}" or "foo\\(".',
  },
  path: {
    type: 'string',
    description:
      'File or directory to search. Defaults to the session workspace; a relative path resolves against it.',
  },
  glob: {
    type: 'string',
    description:
      'Only search files matching this glob, e.g. "*.ts" or "*.{ts,tsx}". Separate several with commas; a leading "!" excludes, e.g. "!*.test.ts".',
  },
  type: {
    type: 'string',
    description:
      'Only search files of this ripgrep file type, e.g. "ts", "js", "py", "rust", "go", "java".',
  },
  output_mode: {
    type: 'string',
    enum: GREP_OUTPUT_MODES,
    description:
      '"files_with_matches" (default): matching file paths. "content": matching lines with line numbers. "count": matching lines per file.',
  },
  '-A': {
    type: 'integer',
    description: 'Lines of context after each match. content mode only.',
  },
  '-B': {
    type: 'integer',
    description: 'Lines of context before each match. content mode only.',
  },
  '-C': {
    type: 'integer',
    description:
      'Lines of context before and after each match; -A or -B, when given, wins for its side. content mode only.',
  },
  '-n': {
    type: 'boolean',
    description: 'Show line numbers in content mode. Defaults to true.',
  },
  '-i': {
    type: 'boolean',
    description: 'Match case-insensitively.',
  },
  multiline: {
    type: 'boolean',
    description:
      'Let the pattern span lines: "." also matches a newline. Slower; leave it off unless a match must cross lines.',
  },
  head_limit: {
    type: 'integer',
    description:
      'Show at most this many entries: lines in content mode, files otherwise. Defaults to 250; 0 shows everything (use sparingly).',
  },
  offset: {
    type: 'integer',
    description:
      'Skip this many entries first, to fetch the next page of a capped result. Defaults to 0.',
  },
} as const;

/** The canonical value's schema, in DSH's schema DSL (`GrepValue`). */
export const GREP_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: GREP_OUTPUT_MODES, required: true },
    entries: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          line: { type: 'integer' },
          text: { type: 'string' },
          context: { type: 'boolean' },
          count: { type: 'integer' },
        },
      },
    },
    notes: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const;

/** The arguments as the model sent them, after DSH checked their types. */
export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: GrepOutputMode;
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  '-n'?: boolean;
  '-i'?: boolean;
  multiline?: boolean;
  head_limit?: number;
  offset?: number;
}

/** One call, checked and defaulted. */
export interface GrepInput {
  pattern: string;
  path?: string;
  globs: string[];
  type?: string;
  outputMode: GrepOutputMode;
  before: number;
  after: number;
  lineNumbers: boolean;
  caseInsensitive: boolean;
  multiline: boolean;
  /** 0 = no limit. */
  headLimit: number;
  offset: number;
}

/**
 * One result entry. content: one printed line (`context` marks a context
 * line); files_with_matches: one file; count: one file and its `count`.
 */
export interface GrepEntry {
  path: string;
  line?: number;
  text?: string;
  context?: boolean;
  count?: number;
}

/**
 * The tool's canonical value: every entry the search found, in display order,
 * and ripgrep's complaints about paths it could not read. Paging is the
 * render's (`renderGrep`), so the permission row's filter
 * (`permissions/searchFilter.ts`) sees every entry, and the totals and pages
 * are counted after it.
 */
export interface GrepValue {
  mode: GrepOutputMode;
  entries: GrepEntry[];
  notes: string[];
}

function integerArg(value: unknown, name: string, max?: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number of 0 or more`);
  }
  if (max !== undefined && value > max) throw new Error(`${name} must be at most ${max}`);
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string when given`);
  }
  return value;
}

/**
 * Split a `glob` argument into ripgrep globs: on commas outside a brace
 * group (`*.{ts,tsx}` stays one glob), each trimmed.
 */
export function splitGlobs(glob: string): string[] {
  const globs: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of glob) {
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      globs.push(current);
      current = '';
    } else current += char;
  }
  globs.push(current);
  return globs.map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Check what the schema cannot (non-empty strings, ranges) and apply the
 * defaults. A thrown `Error` is an ordinary argument error for the model.
 * `context` is read as `-C` too: Claude Code's Grep has that alias, and the
 * parameter root is open, so a model trained on it would otherwise be ignored.
 */
export function parseGrepArgs(raw: GrepArgs & { context?: unknown }): GrepInput {
  if (typeof raw.pattern !== 'string' || raw.pattern.length === 0) {
    throw new Error('pattern must be a non-empty string');
  }
  const path = optionalText(raw.path, 'path');
  const glob = optionalText(raw.glob, 'glob');
  const globs = glob === undefined ? [] : splitGlobs(glob);
  if (glob !== undefined && globs.length === 0) throw new Error('glob must name at least one glob');
  const type = optionalText(raw.type, 'type');
  if (type !== undefined && /\s/.test(type)) {
    throw new Error('type must be one ripgrep file type name, such as "ts" or "py"');
  }
  const outputMode = raw.output_mode ?? DEFAULT_GREP_OUTPUT_MODE;
  if (!GREP_OUTPUT_MODES.includes(outputMode)) {
    throw new Error(`output_mode must be one of ${GREP_OUTPUT_MODES.join(', ')}`);
  }
  const both =
    integerArg(raw['-C'], '-C', MAX_GREP_CONTEXT_LINES) ??
    integerArg(raw.context, 'context', MAX_GREP_CONTEXT_LINES);
  const before = integerArg(raw['-B'], '-B', MAX_GREP_CONTEXT_LINES) ?? both ?? 0;
  const after = integerArg(raw['-A'], '-A', MAX_GREP_CONTEXT_LINES) ?? both ?? 0;
  return {
    pattern: raw.pattern,
    ...(path !== undefined ? { path } : {}),
    globs,
    ...(type !== undefined ? { type } : {}),
    outputMode,
    before,
    after,
    lineNumbers: raw['-n'] ?? true,
    caseInsensitive: raw['-i'] ?? false,
    multiline: raw.multiline ?? false,
    headLimit: integerArg(raw.head_limit, 'head_limit') ?? DEFAULT_GREP_HEAD_LIMIT,
    offset: integerArg(raw.offset, 'offset') ?? 0,
  };
}

/**
 * The ripgrep argv for one call (the binary and `--no-config` excluded). Every
 * model value is one argv element in `--flag=value` form, or behind `--` for
 * the path, so none can be read as a flag. Hidden files are searched and
 * ignore files honoured; `vcsExcludes` (dsh-tool-fs-search's list) keeps VCS
 * metadata out, last so no positive glob can bring it back.
 */
export function buildGrepArgv(input: GrepInput, vcsExcludes: readonly string[]): string[] {
  const argv = ['--hidden'];
  if (input.outputMode === 'content') argv.push('--json');
  else if (input.outputMode === 'files_with_matches') argv.push('--files-with-matches', '--null');
  else argv.push('--count', '--with-filename', '--null');
  if (input.caseInsensitive) argv.push('--ignore-case');
  if (input.multiline) argv.push('--multiline', '--multiline-dotall');
  if (input.outputMode === 'content') {
    if (input.before > 0) argv.push(`--before-context=${input.before}`);
    if (input.after > 0) argv.push(`--after-context=${input.after}`);
  }
  if (input.type !== undefined) argv.push(`--type=${input.type}`);
  for (const glob of input.globs) argv.push(`--glob=${glob}`);
  for (const name of vcsExcludes) argv.push(`--glob=!**/${name}`, `--glob=!**/${name}/**`);
  argv.push(`--regexp=${input.pattern}`);
  if (input.path !== undefined) argv.push('--', input.path);
  return argv;
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes on a character boundary, and say so. */
export function capLine(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return `${text.slice(0, end)}${LINE_TRUNCATED}`;
}

/** Thrown for ripgrep output this module cannot read; the tool turns it into `SEARCH_FAILED`. */
export class GrepOutputError extends Error {}

/** ripgrep's `{text}` / `{bytes}` field: text as is, base64 bytes decoded lossily. */
function textOf(field: unknown): string | undefined {
  if (typeof field !== 'object' || field === null) return undefined;
  const { text, bytes } = field as { text?: unknown; bytes?: unknown };
  if (typeof text === 'string') return text;
  if (typeof bytes === 'string') return Buffer.from(bytes, 'base64').toString('utf8');
  return undefined;
}

/**
 * `rg --json` output -> one entry per printed line, grouped by file in
 * ripgrep's order (a file's records are contiguous). A multi-line match is
 * split into its lines, numbered on from the first. `displayPath` maps each
 * path as ripgrep printed it to the form the model sees.
 */
export function parseContentOutput(
  stdout: string,
  displayPath: (path: string) => string,
  maxLineBytes: number
): Map<string, GrepEntry[]> {
  const files = new Map<string, GrepEntry[]>();
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    let record: { type?: unknown; data?: Record<string, unknown> };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      throw new GrepOutputError(
        'grep received malformed ripgrep --json output (a line is not JSON)'
      );
    }
    if (record.type !== 'match' && record.type !== 'context') continue;
    const data = record.data ?? {};
    const rawPath = textOf(data.path);
    if (rawPath === undefined) {
      throw new GrepOutputError(`grep received malformed ripgrep --json output (no path)`);
    }
    const first = typeof data.line_number === 'number' ? data.line_number : undefined;
    const lines = data.lines as { text?: unknown; bytes?: unknown } | undefined;
    const decoded = typeof lines?.text === 'string' ? lines.text : undefined;
    const pieces =
      decoded === undefined
        ? [NON_UTF8_LINE]
        : decoded
            .replace(/\r?\n$/, '')
            .split('\n')
            .map((piece) => piece.replace(/\r$/, ''));
    const path = displayPath(rawPath);
    let entries = files.get(path);
    if (!entries) {
      entries = [];
      files.set(path, entries);
    }
    pieces.forEach((piece, index) => {
      (entries as GrepEntry[]).push({
        path,
        ...(first !== undefined ? { line: first + index } : {}),
        text: capLine(piece, maxLineBytes),
        ...(record.type === 'context' ? { context: true } : {}),
      });
    });
  }
  return files;
}

/** `rg --files-with-matches --null` output -> one entry per file, in ripgrep's order. */
export function parseFilesOutput(
  stdout: string,
  displayPath: (path: string) => string
): GrepEntry[] {
  return stdout
    .split('\0')
    .filter((path) => path.length > 0)
    .map((path) => ({ path: displayPath(path) }));
}

/** `rg --count --with-filename --null` output (`path\0count\n`) -> one entry per file. */
export function parseCountOutput(
  stdout: string,
  displayPath: (path: string) => string
): GrepEntry[] {
  const entries: GrepEntry[] = [];
  const record = /([^\0]*)\0(\d+)\r?\n/gy;
  let match: RegExpExecArray | null;
  let consumed = 0;
  for (;;) {
    match = record.exec(stdout);
    if (!match) break;
    consumed = record.lastIndex;
    entries.push({ path: displayPath(match[1] as string), count: Number(match[2]) });
  }
  if (stdout.slice(consumed).trim().length > 0) {
    throw new GrepOutputError('grep received malformed ripgrep --count output');
  }
  return entries;
}

/** Plain code-unit order: the same on every platform and every run, which paging needs. */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** content mode's display order: files by path, each file's lines as ripgrep printed them. */
export function orderContent(files: Map<string, GrepEntry[]>): GrepEntry[] {
  return [...files.keys()].sort(comparePaths).flatMap((path) => files.get(path) ?? []);
}

/**
 * files_with_matches' display order: most recently modified first (the
 * workspace's live files lead), then by path. A file whose time is unknown
 * sorts as the oldest.
 */
export function orderByRecency(
  entries: GrepEntry[],
  mtimeMs: (path: string) => number | undefined
): GrepEntry[] {
  const times = new Map(entries.map((entry) => [entry.path, mtimeMs(entry.path) ?? 0]));
  return [...entries].sort(
    (a, b) => (times.get(b.path) ?? 0) - (times.get(a.path) ?? 0) || comparePaths(a.path, b.path)
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The first line of a result: what the search found in total. */
export function grepHeader(value: GrepValue): string {
  const entries = value.entries;
  if (entries.length === 0) return 'No matches found';
  if (value.mode === 'files_with_matches')
    return `Found ${plural(entries.length, 'file', 'files')}`;
  if (value.mode === 'count') {
    const lines = entries.reduce((sum, entry) => sum + (entry.count ?? 0), 0);
    return `Found ${plural(lines, 'matching line', 'matching lines')} in ${plural(entries.length, 'file', 'files')}`;
  }
  const matched = entries.filter((entry) => !entry.context).length;
  const files = new Set(entries.map((entry) => entry.path)).size;
  return `Found ${plural(matched, 'matching line', 'matching lines')} in ${plural(files, 'file', 'files')}`;
}

function contentLine(entry: GrepEntry, lineNumbers: boolean): string {
  const separator = entry.context ? '-' : ':';
  const number = lineNumbers && entry.line !== undefined ? `${entry.line}${separator}` : '';
  return `${entry.path}${separator}${number}${entry.text ?? ''}`;
}

/**
 * The model-facing text of one call: the header, the page `offset` ..
 * `offset + head_limit`, and when the page is not the whole result, which
 * offset comes next. ripgrep's complaints about unreadable paths close it.
 */
export function renderGrep(input: GrepInput, value: GrepValue): string {
  const total = value.entries.length;
  const start = Math.min(input.offset, total);
  const end = input.headLimit === 0 ? total : Math.min(total, start + input.headLimit);
  const page = value.entries.slice(start, end);
  const sections = [grepHeader(value)];
  if (page.length > 0) {
    const grouped = value.mode === 'content' && (input.before > 0 || input.after > 0);
    const lines: string[] = [];
    page.forEach((entry, index) => {
      const previous = page[index - 1];
      if (
        grouped &&
        previous !== undefined &&
        (previous.path !== entry.path ||
          entry.line === undefined ||
          previous.line === undefined ||
          entry.line !== previous.line + 1)
      ) {
        lines.push('--');
      }
      lines.push(
        value.mode === 'content'
          ? contentLine(entry, input.lineNumbers)
          : value.mode === 'count'
            ? `${entry.path}:${entry.count ?? 0}`
            : entry.path
      );
    });
    sections.push(lines.join('\n'));
  }
  if (total > 0 && (start > 0 || end < total)) {
    const unit = value.mode === 'content' ? 'lines' : 'files';
    if (start >= total) {
      sections.push(`(offset ${input.offset} is past the end: the search found ${total} ${unit}.)`);
    } else if (end < total) {
      sections.push(
        `(Showing ${unit} ${start + 1}-${end} of ${total}. Call grep again with the same arguments and offset: ${end} for the next page, or narrow the search.)`
      );
    } else {
      sections.push(`(Showing ${unit} ${start + 1}-${end} of ${total}: the last page.)`);
    }
  }
  if (value.notes.length > 0) {
    sections.push(`(Some paths could not be searched: ${value.notes.join('; ')})`);
  }
  return sections.join('\n\n');
}

/** ripgrep's stderr lines about paths it could not read, for a partial result's note. */
export function unreadablePathNotes(stderr: string, limit = 3): string[] {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `and ${lines.length - limit} more`];
}

/** A pending call's card title, as DSH's grep words it. */
export function presentGrepCall(args: GrepArgs): {
  card: 'generic';
  title: string;
  kind: 'search';
  rawInput: string;
} {
  const where = args.path !== undefined ? ` in ${args.path}` : '';
  const filters = [args.glob, args.type !== undefined ? `type ${args.type}` : undefined]
    .filter((item): item is string => item !== undefined)
    .join(', ');
  return {
    card: 'generic',
    title: `Grep ${args.pattern}${where}${filters ? ` (${filters})` : ''}`,
    kind: 'search',
    rawInput: args.pattern,
  };
}
