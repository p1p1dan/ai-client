/**
 * Layout 5c (ui-cohesion §6, ruling L3): a turn's file edits, aggregated for
 * the ONE change card the timeline shows under that turn —
 * 「改了 N 个文件 +A −D」, the first file name(s), and the entry the right
 * panel's changes tab should show when the card is clicked.
 *
 * Same counting as the session review (`workspace-shell/sessionReview.ts`'s
 * `deriveMessageReview`), restated here because chat may not import the shell
 * directory: only SUCCESSFUL `edit` / `write` calls count; a recorded review
 * (`details.review`) is preferred and its patch lines are counted, otherwise
 * the argument diff stands in when it names a path. Entry ids are the review's
 * own (`${messageId}:${toolCallId}`), so the card can name the panel entry it
 * means. If the two counts ever disagree, the card and the panel totals will.
 *
 * Pure so vitest's node environment covers it.
 */
import { reviewFromToolResult } from '@shared/sessionFileChange';
import type { ChatMessage } from '@/stores/chatSessions';
import { pairToolBlocks, type ToolRun } from './toolCard';
import { deriveToolDiff } from './toolDiff';

const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'Edit',
  'Write',
  'MultiEdit',
]);

export interface TurnChangedFile {
  path: string;
  added: number;
  removed: number;
  /** Review entry id of this file's FIRST change in the turn. */
  firstEntryId: string;
}

export interface TurnChangeSummary {
  /** Distinct files, in the order the turn first touched them. */
  files: TurnChangedFile[];
  added: number;
  removed: number;
}

/**
 * Per turn → files, +/−, first path. `null` when the turn changed no file.
 * Several calls on one path fold into one file whose counts add up.
 */
export function deriveTurnChanges(body: readonly ChatMessage[]): TurnChangeSummary | null {
  const byPath = new Map<string, TurnChangedFile>();
  const seen = new Set<string>();
  for (const message of body) {
    for (const run of pairToolBlocks(message.blocks)) {
      if (run.status !== 'ok' || !FILE_CHANGE_TOOLS.has(run.toolName)) continue;
      const entryId = `${message.id}:${run.toolCallId}`;
      if (seen.has(entryId)) continue;
      seen.add(entryId);
      const change = runChange(run);
      if (!change) continue;
      const existing = byPath.get(change.path);
      if (existing) {
        existing.added += change.added;
        existing.removed += change.removed;
      } else {
        byPath.set(change.path, { ...change, firstEntryId: entryId });
      }
    }
  }
  if (byPath.size === 0) return null;
  const files = [...byPath.values()];
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

function runChange(run: ToolRun): { path: string; added: number; removed: number } | null {
  const review = reviewFromToolResult(run.result);
  if (review) {
    const lines = review.patch?.split('\n') ?? [];
    return {
      path: review.path,
      added: lines.filter((line) => line.startsWith('+')).length,
      removed: lines.filter((line) => line.startsWith('-')).length,
    };
  }
  const preview = deriveToolDiff(run);
  if (!preview?.path) return null;
  return { path: preview.path, added: preview.added, removed: preview.removed };
}

/** How many file names the card's second line spells before 「等 N 个」. */
export const TURN_CHANGE_NAMED_FILES = 2;

/** The names the card shows, and how many it leaves out. */
export function turnChangeNamedFiles(summary: TurnChangeSummary): {
  paths: string[];
  more: number;
} {
  const paths = summary.files.slice(0, TURN_CHANGE_NAMED_FILES).map((file) => file.path);
  return { paths, more: summary.files.length - paths.length };
}
