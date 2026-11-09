/**
 * The turn as Claude Code's CLI reads it (PiLab R1, user ruling 2026-10-30 on
 * `docs/design/2026-10-30-turn-display-claude-code-preview.html`): the main
 * area says what the agent is doing, what it did, and what came of it — and
 * nothing else.
 *
 *  1. A stretch's reads / searches / listings are ONE step:
 *     「搜索了 2 处，读取了 5 个文件」, 「正在读取 3 个文件…」 while running,
 *     and its file edits another: 「修改了 2 个文件 +6 −2」. Counted over the
 *     whole stretch (between two paragraphs), not only adjacent calls,
 *     because the agent interleaves looking, editing and running (user
 *     2026-10-30). Claude Code 2.1.307's main view merges only ADJACENT
 *     lookups; its stretch-wide tally (`toolStats`) feeds subagent summaries.
 *     This goes one step further. Each sits where its first call did; the
 *     individual calls are its expandable detail.
 *     Decision 208 (user ruling 2026-11-03): the terminal style merges only
 *     adjacent calls, as the CLI and the comparison mockup's ① do (`merge:
 *     'adjacent'`); the desktop style keeps the stretch-wide rule.
 *  2. Every other call is one step, with a one-line RESULT under it only when
 *     something went wrong: a failure's first line, an unknown outcome's
 *     warning. A command that ran clean says nothing more (decision 210, user
 *     2026-11-08: its last output line was mostly a closing brace or a rule).
 *     Claude Code's desktop app shows no output under a step either; it opens
 *     with a click. The terminal style previews output as the CLI does
 *     (`deriveTerminalStepResult`).
 *  3. Thinking is drawn where it happened. Rule 3 used to keep it out of the
 *     steps, readable only from the footer's 「思考 N 秒」; the user overruled
 *     that on 2026-11-03 (decision 208): neither the CLI nor the desktop app
 *     gathers a turn's thinking at its end. Thought rows pass through here.
 *
 * Pure: rows in, rows out. `deriveToolGroupRows` still words each call.
 */

import type { ToolGroupEntry, ToolRowView } from './toolCard';
import { dshShellOutputHead } from './toolOutputHead';
import { formatWorkedForDuration } from './turnTiming';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type StepResultTone = 'muted' | 'bad' | 'unknown';

export interface StepResultLine {
  text: string;
  tone: StepResultTone;
}

/** Calls that only look at the workspace: merged into one step when two or more are adjacent. */
const LOOKUP_KINDS = new Set(['read', 'search', 'list']);

/** Nothing about the call needs its own line: it worked, plainly allowed if asked. */
function isPlain(row: ToolRowView): boolean {
  return (
    !row.failed &&
    !row.outcome &&
    (!row.permissionVerb || row.permissionVerb === 'Allowed') &&
    !row.permissionAutoNote &&
    !row.reviewNote &&
    row.title === undefined
  );
}

function isMergeableLookup(row: ToolRowView): boolean {
  return LOOKUP_KINDS.has(row.iconKind ?? '') && isPlain(row);
}

function isMergeableEdit(row: ToolRowView): boolean {
  return row.iconKind === 'edit' && isPlain(row);
}

/** Thinking entries leave the step list (the retired rule 3; outside the timeline only). */
export function withoutThinking(entries: readonly ToolGroupEntry[]): ToolGroupEntry[] {
  return entries.filter((entry) => entry.kind !== 'thinking');
}

/** A thought row (`deriveToolGroupRows`): thinking, in place since decision 208. */
export function isThoughtRow(row: ToolRowView): boolean {
  return row.iconKind === 'thinking';
}

/**
 * `Thought for 12s`, or `null` when nothing measured the thinking. English and
 * never translated, as the tool names are (user ruling 2026-11-03): the CLI
 * and the desktop app both word it so.
 */
export function thoughtForText(ms: number | null | undefined): string | null {
  return typeof ms === 'number' ? `Thought for ${formatWorkedForDuration(ms)}` : null;
}

/** What a thought row says in the timeline: `Thinking…`, `Thought for 12s`, or `Thought` unmeasured. */
export function thoughtWords(row: ToolRowView): string {
  if (row.running) return 'Thinking…';
  return thoughtForText(row.thoughtMs) ?? 'Thought';
}

/** The thinking inside a merged step, as its lead, when all of it was measured. */
function thoughtsLead(detail: readonly ToolRowView[]): string | null {
  const thoughts = detail.filter(isThoughtRow);
  if (thoughts.length === 0) return null;
  let total = 0;
  for (const thought of thoughts) {
    if (typeof thought.thoughtMs !== 'number') return null;
    total += thought.thoughtMs;
  }
  return thoughtForText(total);
}

/** The thinking lead before a sentence in the reader's language, set apart rather than joined. */
export function withThoughtLead(lead: string | null | undefined, text: string): string {
  return lead ? `${lead} · ${text}` : text;
}

/**
 * 「搜索了 2 处，读取了 5 个文件」 / 「正在搜索 2 处，读取 5 个文件…」. A `lead`
 * goes first, as the CLI's collapsed group says `Thought for 3s, searched for
 * 2 patterns`; it stays English, so ` · ` sets it apart from the counts.
 */
export function lookupSummary(
  counts: { search: number; read: number; list: number },
  running: boolean,
  t: Translate,
  lead?: string | null
): string {
  const parts: string[] = [];
  const add = (count: number, kind: 'search' | 'read' | 'list') => {
    if (count <= 0) return;
    const first = parts.length === 0;
    const noun =
      kind === 'search'
        ? t(count === 1 ? 'pattern' : 'patterns')
        : kind === 'read'
          ? t(count === 1 ? 'file' : 'files')
          : t(count === 1 ? 'directory' : 'directories');
    const key = {
      search: running
        ? first
          ? 'Searching {{count}} {{noun}}'
          : 'searching {{count}} {{noun}}'
        : first
          ? 'Searched {{count}} {{noun}}'
          : 'searched {{count}} {{noun}}',
      read: running
        ? first
          ? 'Reading {{count}} {{noun}}'
          : 'reading {{count}} {{noun}}'
        : first
          ? 'Read {{count}} {{noun}}'
          : 'read {{count}} {{noun}}',
      list: running
        ? first
          ? 'Listing {{count}} {{noun}}'
          : 'listing {{count}} {{noun}}'
        : first
          ? 'Listed {{count}} {{noun}}'
          : 'listed {{count}} {{noun}}',
    }[kind];
    parts.push(t(key, { count, noun }));
  };
  add(counts.search, 'search');
  add(counts.read, 'read');
  add(counts.list, 'list');
  const text = parts.join(t(', '));
  return withThoughtLead(lead, running ? `${text}…` : text);
}

/**
 * `detail` is what the step opens to: its calls, and in the terminal style the
 * thinking that sat between two of them, in order.
 */
function mergeLookups(
  rows: readonly ToolRowView[],
  t: Translate,
  detail: readonly ToolRowView[] = rows
): ToolRowView {
  const counts = { search: 0, read: 0, list: 0 };
  for (const row of rows) counts[row.iconKind as 'search' | 'read' | 'list'] += 1;
  const running = rows.some((row) => row.running);
  return {
    key: `lookup:${rows[0].key}`,
    verb: '',
    title: lookupSummary(counts, running, t, running ? null : thoughtsLead(detail)),
    iconKind: counts.search > 0 ? 'search' : counts.read > 0 ? 'read' : 'list',
    running,
    failed: false,
    expandable: true,
    body: 'detail',
    detail: [...detail],
  };
}

function mergeEdits(
  rows: readonly ToolRowView[],
  t: Translate,
  detail: readonly ToolRowView[] = rows
): ToolRowView {
  const files = new Set(rows.map((row) => row.link?.path ?? row.arg ?? row.key));
  let added = 0;
  let removed = 0;
  let counted = false;
  for (const row of rows) {
    const stat = row.diff ?? row.changeStat;
    if (!stat) continue;
    counted = true;
    added += stat.added;
    removed += stat.removed;
  }
  const running = rows.some((row) => row.running);
  const noun = t(files.size === 1 ? 'file' : 'files');
  return {
    key: `edits:${rows[0].key}`,
    verb: '',
    title: running
      ? `${t('Editing {{count}} {{noun}}', { count: files.size, noun })}…`
      : withThoughtLead(
          thoughtsLead(detail),
          t('Edited {{count}} {{noun}}', { count: files.size, noun })
        ),
    iconKind: 'edit',
    running,
    failed: false,
    expandable: true,
    body: 'detail',
    detail: [...detail],
    ...(counted ? { changeStat: { added, removed } } : {}),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is exactly what an ANSI colour code starts with
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const RESULT_MAX_CHARS = 140;

/** Engine placeholders that say nothing about the result. */
const NO_OUTPUT = /^\((no output|empty)\)$/i;
/** DSH's note for an output it spilled to a temp file: not shown, it names a scratch path. */
export const SPILLED = /^\(Omitted \d+ bytes\b/;
/**
 * Claude Code's own note after a command that left the working directory: it
 * says nothing about the result, yet it is the LAST line of such an output, so
 * a preview of the end showed only it (the 2026-11-03 field screenshots).
 */
const CWD_RESET = /^Shell cwd was reset to /;

export function meaningfulLines(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .replace(ANSI, '')
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NO_OUTPUT.test(line) && !CWD_RESET.test(line));
}

/**
 * Lines DSH's shells write around a command's output rather than in it
 * (`dsh-tool-bash` / `dsh-tool-pwsh`): the stderr section's heading, the note
 * that only the tail was kept (it names a scratch path), and the exit marker,
 * which the row already says as 「退出码 N」. The opened body keeps them.
 */
const DSH_SHELL_MARKERS = [
  /^\[stderr\]$/,
  /^\[output truncated; full output: /,
  /^\[exit code: -?\d+\]$/,
];

/**
 * A command's output as a preview may show it (decision 210): from the first
 * whole line on (a tail DSH cut mid-line starts at the next one), without
 * blank lines, placeholders, Claude Code's cwd-reset note, DSH's markers or a
 * spill note. Unlike `meaningfulLines`, leading whitespace stays: code, JSON
 * and trees read by their indentation, and the CLI keeps it too.
 */
export function outputPreviewLines(text: string | undefined): string[] {
  if (!text) return [];
  return dshShellOutputHead(text)
    .text.replace(ANSI, '')
    .split(/\r\n|\n|\r/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const bare = line.trim();
      return (
        bare.length > 0 &&
        !NO_OUTPUT.test(bare) &&
        !CWD_RESET.test(bare) &&
        !SPILLED.test(bare) &&
        !DSH_SHELL_MARKERS.some((marker) => marker.test(bare))
      );
    });
}

function clip(line: string): string {
  return line.length > RESULT_MAX_CHARS ? `${line.slice(0, RESULT_MAX_CHARS - 1)}…` : line;
}

/** How Claude Code opens a failed command's result: the code, then what it printed. */
const EXIT_CODE_LEAD = /^Exit code -?\d+$/;

/**
 * The one line under a step (rule 2), or `null`.
 *
 *  - an unknown outcome: the warning Claude Code gives for a call the session
 *    ended under — check before re-running;
 *  - a failure: the first line of what it said, red. A leading `Exit code N`
 *    gives way to the line after it: the red mark already says it failed, and
 *    the one line is better spent on why (the full text opens with the step).
 *
 * Nothing else. Until decision 210 a settled command showed its LAST output
 * line and the count (「} · 69 行」); the user found it noise (2026-11-08).
 * A non-zero exit gets no line either: the row says 「退出码 N」, and which
 * line explains it differs by tool (a test run's verdict is last, a compiler's
 * first error first), so a guess here would often be the wrong line.
 */
export function deriveStepResult(row: ToolRowView, t: Translate): StepResultLine | null {
  if (row.running) return null;
  if (row.outcome === 'outcomeUnknown') {
    return {
      text: t(
        'Outcome unknown: the engine stopped before this finished. Check whether it took effect before running it again.'
      ),
      tone: 'unknown',
    };
  }
  if (row.outcome) return null; // refused / not started / stopped: the row's own word says it
  if (!row.failed) return null;
  const [first, second] = outputPreviewLines(row.output);
  const line = second !== undefined && EXIT_CODE_LEAD.test(first.trim()) ? second : first;
  return line ? { text: clip(line.trim()), tone: 'bad' } : null;
}

export interface StepRowView extends ToolRowView {
  resultLine?: StepResultLine;
}

export interface DeriveStepRowsOptions {
  /**
   * `stretch` (PiLab R1, the default): a stretch's lookups make one step and
   * its edits another, wherever they fall in it. `adjacent` (decision 208,
   * the terminal style): only calls next to each other merge, and thinking
   * between two of them goes into the step with them, as the CLI's collapsed
   * group takes it.
   */
  merge?: 'stretch' | 'adjacent';
}

function withResult(row: ToolRowView, t: Translate): StepRowView {
  if (isThoughtRow(row)) return row;
  const resultLine = deriveStepResult(row, t);
  return resultLine ? { ...row, resultLine } : row;
}

/**
 * Tool rows → steps (rules 1 and 2): the stretch's lookups as one line and its
 * edits as one line (each where its first call was, when there are two or
 * more), every other call as its own line with its result.
 */
export function deriveStepRows(
  rows: readonly ToolRowView[],
  t: Translate,
  options: DeriveStepRowsOptions = {}
): StepRowView[] {
  if (options.merge === 'adjacent') return deriveAdjacentStepRows(rows, t);
  const lookups = rows.filter(isMergeableLookup);
  const edits = rows.filter(isMergeableEdit);
  const mergeLookupRows = lookups.length >= 2;
  const mergeEditRows = edits.length >= 2;
  const out: StepRowView[] = [];
  let lookupsPlaced = false;
  let editsPlaced = false;
  for (const row of rows) {
    if (mergeLookupRows && isMergeableLookup(row)) {
      if (!lookupsPlaced) out.push(mergeLookups(lookups, t));
      lookupsPlaced = true;
      continue;
    }
    if (mergeEditRows && isMergeableEdit(row)) {
      if (!editsPlaced) out.push(mergeEdits(edits, t));
      editsPlaced = true;
      continue;
    }
    out.push(withResult(row, t));
  }
  return out;
}

type MergeKind = 'lookup' | 'edit';

function mergeKindOf(row: ToolRowView): MergeKind | null {
  if (isMergeableLookup(row)) return 'lookup';
  if (isMergeableEdit(row)) return 'edit';
  return null;
}

/**
 * The terminal style's rule: two or more lookups (or edits) in a row are one
 * step. Thinking between two of them joins the step; thinking before the first
 * or after the last stays a line of its own.
 */
function deriveAdjacentStepRows(rows: readonly ToolRowView[], t: Translate): StepRowView[] {
  const out: StepRowView[] = [];
  let kind: MergeKind | null = null;
  let members: ToolRowView[] = [];
  /** The open run's calls, and the thinking between them, in order. */
  let span: ToolRowView[] = [];
  /** Thinking after the run's last call: inside only if another call joins. */
  let trailing: ToolRowView[] = [];
  const flush = () => {
    if (kind !== null && members.length >= 2) {
      out.push(kind === 'lookup' ? mergeLookups(members, t, span) : mergeEdits(members, t, span));
    } else {
      for (const row of span) out.push(withResult(row, t));
    }
    out.push(...trailing);
    kind = null;
    members = [];
    span = [];
    trailing = [];
  };
  for (const row of rows) {
    if (isThoughtRow(row)) {
      if (kind !== null) trailing.push(row);
      else out.push(row);
      continue;
    }
    const rowKind = mergeKindOf(row);
    if (rowKind !== null && rowKind === kind) {
      span.push(...trailing, row);
      trailing = [];
      members.push(row);
      continue;
    }
    flush();
    if (rowKind !== null) {
      kind = rowKind;
      members = [row];
      span = [row];
      continue;
    }
    out.push(withResult(row, t));
  }
  flush();
  return out;
}
