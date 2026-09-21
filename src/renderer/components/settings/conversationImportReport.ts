import type { Translate } from '@shared/i18n';
import type { LegacyImportItemResult, LegacyImportWorkspaceOutcome } from '@shared/types';

/**
 * What the import pane says after the batch, split by where each conversation's
 * folder ended up.
 *
 * The old single line ("Imported 3, already here 0, failed 0.") answered a
 * question nobody asked, and left the one the user did ask — "did my project
 * come with these conversations, or did they land somewhere detached?" —
 * unanswered. That is the whole of the 2026-09-20 complaint: a folder that was
 * never registered here imported as a temporary chat, silently, and the line
 * that would have said so did not exist.
 *
 * Only `kept` counts as "came with its project". `missing` and `none` both mean
 * the conversation runs detached, and they are reported together because the
 * user's next step is the same for both — but each names its directory, because
 * "which folder was it" is the only thing that makes the message actionable.
 */
export interface ConversationImportReportRow {
  /** The directory the conversations under this row came from. */
  path: string;
  count: number;
}

export interface ConversationImportReport {
  /**
   * Directories this run registered as projects for the first time, with the
   * number of conversations imported into each.
   */
  newProjects: ConversationImportReportRow[];
  /** Directories that were already registered here, and their conversation count. */
  existingProjects: ConversationImportReportRow[];
  /** Directories that could not be used, and their conversation count. */
  detached: ConversationImportReportRow[];
  imported: number;
  alreadyImported: number;
  failed: number;
}

function workspaceOutcomeOf(result: LegacyImportItemResult): LegacyImportWorkspaceOutcome | null {
  return result.outcome?.workspace ?? null;
}

/**
 * Which directory a row is grouped and reported under.
 *
 * For a detached row this is the RECORDED directory, not the scratch one it
 * landed in: the sentence says the folder "is not on this machine any more",
 * and the useful half of that is the folder the user remembers — a path under
 * the app's own temporary directory is noise they can do nothing with. For a
 * kept row the two are the same string.
 */
function reportedPathOf(result: LegacyImportItemResult): string {
  const outcome = result.outcome;
  if (!outcome) return '';
  if (outcome.workspace === 'kept')
    return outcome.workspacePath ?? outcome.recordedWorkspacePath ?? '';
  return outcome.recordedWorkspacePath ?? outcome.workspacePath ?? '';
}

function countByPath(
  results: LegacyImportItemResult[],
  pathOfRow: (item: LegacyImportItemResult) => string
): ConversationImportReportRow[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    const path = pathOfRow(result);
    if (!path) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  // Directory name asc, so the list reads the same way twice for one batch.
  return [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Build the report from a batch result.
 *
 * `wasAlreadyRegistered` is the renderer's answer, not Main's: only this side
 * holds the project list, and only this side registers the kept directories.
 * Main reports where each folder ended up; this function asks the caller
 * whether that folder was already known BEFORE this run touched it, which is
 * the difference between "we added your project" and "we put these in your
 * project".
 */
export function summarizeConversationImport(
  results: readonly LegacyImportItemResult[],
  wasAlreadyRegistered: (path: string) => boolean
): ConversationImportReport {
  const importedResults = results.filter((result) => result.status === 'imported');
  const kept = importedResults.filter((result) => workspaceOutcomeOf(result) === 'kept');
  const detached = importedResults.filter((result) => {
    const outcome = workspaceOutcomeOf(result);
    return outcome === 'missing' || outcome === 'none';
  });

  return {
    newProjects: countByPath(
      kept.filter((result) => !wasAlreadyRegistered(reportedPathOf(result))),
      reportedPathOf
    ),
    existingProjects: countByPath(
      kept.filter((result) => wasAlreadyRegistered(reportedPathOf(result))),
      reportedPathOf
    ),
    detached: countByPath(detached, reportedPathOf),
    imported: importedResults.length,
    alreadyImported: results.filter((result) => result.status === 'already-imported').length,
    failed: results.filter((result) => result.status === 'failed').length,
  };
}

/**
 * The report as sentences, split so the pane can render an empty group as
 * nothing rather than as a zero.
 */
export function describeConversationImport(
  report: ConversationImportReport,
  t: Translate
): string[] {
  const lines: string[] = [];
  for (const row of report.newProjects) {
    lines.push(
      t('Added {{path}} as a project and imported {{count}} conversations into it.', {
        path: row.path,
        count: row.count,
      })
    );
  }
  for (const row of report.existingProjects) {
    lines.push(
      t('Imported {{count}} conversations into the project {{path}}.', {
        path: row.path,
        count: row.count,
      })
    );
  }
  for (const row of report.detached) {
    lines.push(
      t(
        '{{count}} conversations imported as temporary chats because the folder {{path}} is not on this machine any more.',
        { path: row.path, count: row.count }
      )
    );
  }
  lines.push(
    t('Imported {{imported}}, already here {{skipped}}, failed {{failed}}.', {
      imported: report.imported,
      skipped: report.alreadyImported,
      failed: report.failed,
    })
  );
  return lines;
}
