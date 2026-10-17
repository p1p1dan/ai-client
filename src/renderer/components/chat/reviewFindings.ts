import { readStreamingToolArgs } from '@shared/streamingToolArgs';
import type { FileLinkTarget, ToolGroupEntry, ToolRun } from './toolCard';

/**
 * Route B S-6 feedback 1 (ruling 24): `ReportFindings`, the Agent SDK engine's tool a code
 * review (`code-review`, `security-review`, …) hands its findings to the window with. The
 * timeline draws its call as the review card (`ToolRows.tsx`), not as a tool row.
 *
 * Pure: the input as the CLI checked it (2.1.300's schema, `additionalProperties: false`),
 * read tolerantly all the same — a replayed transcript is not re-checked.
 */
export const REPORT_FINDINGS_TOOL = 'ReportFindings';

export type ReviewLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type FindingVerdict = 'CONFIRMED' | 'PLAUSIBLE';
export type FindingOutcome = 'fixed' | 'skipped' | 'no_change_needed';

export interface ReviewFinding {
  /** Repository-relative, as the model wrote it. */
  file: string;
  line?: number;
  summary: string;
  shortSummary?: string;
  failureScenario: string;
  category?: string;
  verdict?: FindingVerdict;
  outcome?: FindingOutcome;
}

/** One call's report, findings in the model's order (most severe first). */
export interface ReviewFindings {
  level?: ReviewLevel;
  findings: ReviewFinding[];
}

const LEVELS: readonly ReviewLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const VERDICTS: readonly FindingVerdict[] = ['CONFIRMED', 'PLAUSIBLE'];
const OUTCOMES: readonly FindingOutcome[] = ['fixed', 'skipped', 'no_change_needed'];

/** The composer's effort words, which already say these five levels. */
export const REVIEW_LEVEL_LABEL: Readonly<Record<ReviewLevel, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

export const FINDING_VERDICT_LABEL: Readonly<Record<FindingVerdict, string>> = {
  CONFIRMED: 'Confirmed',
  PLAUSIBLE: 'Plausible',
};

export const FINDING_OUTCOME_LABEL: Readonly<Record<FindingOutcome, string>> = {
  fixed: 'Fixed',
  skipped: 'Skipped',
  no_change_needed: 'No change needed',
};

/** The CLI's own budget for `short_summary`, applied to a label cut from `summary`. */
export const FINDING_LABEL_MAX_CHARS = 60;

/**
 * How many findings open at first, from the top. A short report opens whole; a longer one
 * opens its first finding only, the most severe, so the folded rows still read as a list.
 */
export const FINDINGS_OPEN_ALL_UP_TO = 3;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

/**
 * The report a call carries, or `undefined` while its input is still streaming (the
 * `__streaming` marker) or when the input is not a report at all.
 */
export function readReviewFindings(input: unknown): ReviewFindings | undefined {
  const rec = record(input);
  if (!rec || readStreamingToolArgs(input) || !Array.isArray(rec.findings)) return undefined;
  const findings: ReviewFinding[] = [];
  for (const entry of rec.findings) {
    const f = record(entry);
    if (!f) continue;
    const line = typeof f.line === 'number' && Number.isInteger(f.line) && f.line > 0 ? f.line : 0;
    const shortSummary = text(f.short_summary);
    const category = text(f.category);
    const verdict = oneOf(f.verdict, VERDICTS);
    const outcome = oneOf(f.outcome, OUTCOMES);
    findings.push({
      file: typeof f.file === 'string' ? f.file : '',
      ...(line ? { line } : {}),
      summary: typeof f.summary === 'string' ? f.summary : '',
      ...(shortSummary ? { shortSummary } : {}),
      failureScenario: typeof f.failure_scenario === 'string' ? f.failure_scenario : '',
      ...(category ? { category } : {}),
      ...(verdict ? { verdict } : {}),
      ...(outcome ? { outcome } : {}),
    });
  }
  const level = oneOf(rec.level, LEVELS);
  return { ...(level ? { level } : {}), findings };
}

/** The row's label: the model's short one, else the summary cut to the same budget. */
export function findingLabel(finding: ReviewFinding): string {
  if (finding.shortSummary) return finding.shortSummary;
  const chars = [...finding.summary.replace(/\s+/g, ' ').trim()];
  return chars.length > FINDING_LABEL_MAX_CHARS
    ? `${chars.slice(0, FINDING_LABEL_MAX_CHARS - 1).join('')}…`
    : chars.join('');
}

/** Where a finding points, for the editor; none when the model named no file. */
export function findingTarget(finding: ReviewFinding): FileLinkTarget | undefined {
  if (!finding.file.trim()) return undefined;
  return { path: finding.file, ...(finding.line ? { line: finding.line } : {}) };
}

export function findingOpensAtFirst(index: number, total: number): boolean {
  return total <= FINDINGS_OPEN_ALL_UP_TO || index === 0;
}

/** A report call the card draws: a failed or refused one stays an ordinary row. */
export function isReviewFindingsRun(run: Pick<ToolRun, 'toolName' | 'status'>): boolean {
  return run.toolName === REPORT_FINDINGS_TOOL && run.status !== 'failed';
}

/**
 * A timeline item that is one report call and nothing else (`groupTimeline` gives every
 * such call a group of its own). The turn places it with the reply, not in the folded work
 * group: the review's result is what the turn was for, and the model is told not to repeat
 * it as text.
 */
export function isReviewFindingsGroup(item: {
  kind: string;
  entries?: readonly ToolGroupEntry[];
}): boolean {
  const only = item.kind === 'toolGroup' && item.entries?.length === 1 ? item.entries[0] : null;
  return only?.kind === 'run' && isReviewFindingsRun(only.run);
}
