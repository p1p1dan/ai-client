/**
 * Decision 208, desktop style: as Claude Code's desktop app draws a turn, each
 * run of steps between two paragraphs is ONE muted line — 「运行了 3 条命令，
 * 读取了 2 个文件」 — that opens to the rows.
 *
 * Pure: step rows in, runs and their wording out. A tool group never spans a
 * paragraph (`mergeAdjacentToolGroups` joins only neighbours), so a run is cut
 * from one group's rows; a special row (review findings, a delegation's lane,
 * a todo list) keeps its own drawing and cuts the run in two.
 */

import { isRefusedStep, isSpecialStepRow, stepLabel } from './stepPresentation';
import type { ToolRowView } from './toolCard';
import { isThoughtRow, thoughtForText } from './turnSteps';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface StepRun {
  kind: 'run';
  /**
   * The run's first call. Merged steps carry `lookup:` / `edits:` before it;
   * stripped so the run keeps its key (and its remembered open state) when a
   * second lookup arrives and the first one is folded into a merged step.
   */
  key: string;
  rows: ToolRowView[];
}

export interface SpecialStep {
  kind: 'special';
  row: ToolRowView;
}

export type StepRunEntry = StepRun | SpecialStep;

function runKey(row: ToolRowView): string {
  return row.key.replace(/^(?:lookup|edits):/, '');
}

export function partitionStepRuns(rows: readonly ToolRowView[]): StepRunEntry[] {
  const out: StepRunEntry[] = [];
  let current: StepRun | null = null;
  for (const row of rows) {
    if (isSpecialStepRow(row)) {
      current = null;
      out.push({ kind: 'special', row });
      continue;
    }
    if (!current) {
      current = { kind: 'run', key: runKey(row), rows: [] };
      out.push(current);
    }
    current.rows.push(row);
  }
  return out;
}

/** A merged step stands for the calls (and thinking) in its `detail`; count those. */
function flattenSteps(rows: readonly ToolRowView[]): ToolRowView[] {
  return rows.flatMap((row) =>
    (row.key.startsWith('lookup:') || row.key.startsWith('edits:')) && row.detail
      ? row.detail
      : [row]
  );
}

export interface StepRunSummary {
  /**
   * 「思考了 4 秒，运行了 3 条命令，读取了 2 个文件」; for one call, its own
   * label and description instead.
   */
  text: string;
  single?: { label: string; description?: string };
  change?: { added: number; removed: number };
  refused: number;
  failed: number;
  /** The newest call (or thought) still running, shown in place of the summary while it works. */
  running?: ToolRowView;
  /**
   * Decision 208 (user ruling 2026-11-03): the run is thinking and nothing
   * else — the desktop app's 「思考了 N 秒 ›」, which opens to the text itself.
   */
  thoughtOnly?: boolean;
}

/**
 * The run's thinking as its leading clause, as the CLI's collapsed group says
 * 「Thought for 4s, read 2 files」: only when all of it was measured, except a
 * run of nothing but thinking, which still says 「思考」.
 */
function thoughtsClause(
  thoughts: readonly ToolRowView[],
  alone: boolean,
  t: Translate
): string | null {
  if (thoughts.length === 0) return null;
  let total = 0;
  for (const thought of thoughts) {
    if (typeof thought.thoughtMs !== 'number') return alone ? t('Thought') : null;
    total += thought.thoughtMs;
  }
  return thoughtForText(total, t) ?? (alone ? t('Thought') : null);
}

type Clause = 'command' | 'read' | 'search' | 'list' | 'edit' | 'tool';

const CLAUSE_ORDER: readonly Clause[] = ['command', 'read', 'search', 'list', 'edit', 'tool'];

const CLAUSE_KEYS: Readonly<Record<Clause, readonly [string, string]>> = {
  command: ['Ran {{count}} {{noun}}', 'ran {{count}} {{noun}}'],
  read: ['Read {{count}} {{noun}}', 'read {{count}} {{noun}}'],
  search: ['Searched {{count}} {{noun}}', 'searched {{count}} {{noun}}'],
  list: ['Listed {{count}} {{noun}}', 'listed {{count}} {{noun}}'],
  edit: ['Edited {{count}} {{noun}}', 'edited {{count}} {{noun}}'],
  tool: ['Called {{count}} {{noun}}', 'called {{count}} {{noun}}'],
};

const CLAUSE_NOUNS: Readonly<Record<Clause, readonly [string, string]>> = {
  command: ['command', 'commands'],
  read: ['file', 'files'],
  search: ['pattern', 'patterns'],
  list: ['directory', 'directories'],
  edit: ['file', 'files'],
  tool: ['tool', 'tools'],
};

function clauseOf(row: ToolRowView): Clause {
  switch (row.iconKind) {
    case 'terminal':
      return 'command';
    case 'read':
      return 'read';
    case 'search':
      return 'search';
    case 'list':
      return 'list';
    case 'edit':
      return 'edit';
    default:
      return 'tool';
  }
}

export function summarizeStepRun(rows: readonly ToolRowView[], t: Translate): StepRunSummary {
  const steps = flattenSteps(rows);
  const calls = steps.filter((step) => !isThoughtRow(step));
  const thoughts = steps.filter(isThoughtRow);
  const counts: Record<Clause, number> = {
    command: 0,
    read: 0,
    search: 0,
    list: 0,
    edit: 0,
    tool: 0,
  };
  const editedFiles = new Set<string>();
  let added = 0;
  let removed = 0;
  let counted = false;
  for (const call of calls) {
    const clause = clauseOf(call);
    if (clause === 'edit') {
      editedFiles.add(call.link?.path ?? call.arg ?? call.key);
      const stat = call.diff ?? call.changeStat;
      if (stat) {
        counted = true;
        added += stat.added;
        removed += stat.removed;
      }
    } else {
      counts[clause] += 1;
    }
  }
  counts.edit = editedFiles.size;

  const lead = thoughtsClause(thoughts, calls.length === 0, t);
  const parts: string[] = lead ? [lead] : [];
  for (const clause of CLAUSE_ORDER) {
    const count = counts[clause];
    if (count <= 0) continue;
    const [first, later] = CLAUSE_KEYS[clause];
    const [one, many] = CLAUSE_NOUNS[clause];
    parts.push(t(parts.length === 0 ? first : later, { count, noun: t(count === 1 ? one : many) }));
  }

  const summary: StepRunSummary = {
    text: parts.join(t(', ')),
    refused: calls.filter((call) => !call.running && isRefusedStep(call)).length,
    failed: calls.filter(
      (call) =>
        !call.running &&
        !isRefusedStep(call) &&
        (call.failed || (typeof call.exitCode === 'number' && call.exitCode !== 0))
    ).length,
  };
  if (counted) summary.change = { added, removed };
  const running = [...steps].reverse().find((step) => step.running);
  if (running) summary.running = running;
  if (rows.length === 1 && calls.length === 1) {
    const only = rows[0] as ToolRowView;
    summary.single = { label: stepLabel(only), description: only.arg };
  }
  if (calls.length === 0 && thoughts.length > 0) summary.thoughtOnly = true;
  return summary;
}
