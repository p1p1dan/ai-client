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
 *  2. Every other call is one step, with a one-line RESULT under it when the
 *     call produced something worth a glance: a command's last output line,
 *     a failure's first line, an unknown outcome's warning.
 *  3. Thinking is not a step. The turn's status line says 「思考中」 while it
 *     happens; the footer keeps 「思考 N 秒」, which opens the text.
 *
 * Pure: rows in, rows out. `deriveToolGroupRows` still words each call.
 */

import type { ToolGroupEntry, ToolRowView } from './toolCard';

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

/** Thinking entries leave the step list (rule 3). */
export function withoutThinking(entries: readonly ToolGroupEntry[]): ToolGroupEntry[] {
  return entries.filter((entry) => entry.kind !== 'thinking');
}

/** 「搜索了 2 处，读取了 5 个文件」 / 「正在搜索 2 处，读取 5 个文件…」. */
export function lookupSummary(
  counts: { search: number; read: number; list: number },
  running: boolean,
  t: Translate
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
  return running ? `${text}…` : text;
}

function mergeLookups(rows: readonly ToolRowView[], t: Translate): ToolRowView {
  const counts = { search: 0, read: 0, list: 0 };
  for (const row of rows) counts[row.iconKind as 'search' | 'read' | 'list'] += 1;
  const running = rows.some((row) => row.running);
  return {
    key: `lookup:${rows[0].key}`,
    verb: '',
    title: lookupSummary(counts, running, t),
    iconKind: counts.search > 0 ? 'search' : counts.read > 0 ? 'read' : 'list',
    running,
    failed: false,
    expandable: true,
    body: 'detail',
    detail: [...rows],
  };
}

function mergeEdits(rows: readonly ToolRowView[], t: Translate): ToolRowView {
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
      : t('Edited {{count}} {{noun}}', { count: files.size, noun }),
    iconKind: 'edit',
    running,
    failed: false,
    expandable: true,
    body: 'detail',
    detail: [...rows],
    ...(counted ? { changeStat: { added, removed } } : {}),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is exactly what an ANSI colour code starts with
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const RESULT_MAX_CHARS = 140;

/** Engine placeholders that say nothing about the result. */
const NO_OUTPUT = /^\((no output|empty)\)$/i;
/** DSH's note for an output it spilled to a temp file: not shown, it names a scratch path. */
const SPILLED = /^\(Omitted \d+ bytes\b/;

function meaningfulLines(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .replace(ANSI, '')
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NO_OUTPUT.test(line));
}

function clip(line: string): string {
  return line.length > RESULT_MAX_CHARS ? `${line.slice(0, RESULT_MAX_CHARS - 1)}…` : line;
}

/**
 * The one line under a step (rule 2), or `null`.
 *
 *  - an unknown outcome: the warning Claude Code gives for a call the session
 *    ended under — check before re-running;
 *  - a failure: the first line of what it said;
 *  - a settled command: its LAST output line (a test run's or build's summary
 *    is where they put the verdict), with the total when there was more.
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
  const lines = meaningfulLines(row.output);
  if (row.failed) {
    return lines.length ? { text: clip(lines[0]), tone: 'bad' } : null;
  }
  if (row.iconKind !== 'terminal' || lines.length === 0) return null;
  if (lines.every((line) => SPILLED.test(line))) {
    return { text: t('Large output, open the step to see it'), tone: 'muted' };
  }
  const last = clip(lines[lines.length - 1]);
  return {
    text: lines.length > 1 ? `${last} · ${t('{{count}} lines', { count: lines.length })}` : last,
    // A non-zero exit is not a failed call (the row says 「退出码 N」 neutrally),
    // but the line it ended on is usually why: worth the red.
    tone: typeof row.exitCode === 'number' && row.exitCode !== 0 ? 'bad' : 'muted',
  };
}

export interface StepRowView extends ToolRowView {
  resultLine?: StepResultLine;
}

/**
 * Tool rows → steps (rules 1 and 2): the stretch's lookups as one line and its
 * edits as one line (each where its first call was, when there are two or
 * more), every other call as its own line with its result.
 */
export function deriveStepRows(rows: readonly ToolRowView[], t: Translate): StepRowView[] {
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
    const resultLine = deriveStepResult(row, t);
    out.push(resultLine ? { ...row, resultLine } : row);
  }
  return out;
}
