/**
 * Layout 5d: the diff pane lists FILES (the reference's diff pane), not the
 * individual tool calls `deriveSessionReview` records. One row per path, in
 * the order each file was first changed; its changes stay in order inside it.
 * Pure so vitest's node environment covers it.
 */
import type { SessionReviewEntry } from './sessionReview';

export interface SessionReviewFile {
  /** The path as the tools recorded it; also the row's key. */
  path: string;
  /** Last path segment. */
  name: string;
  /** Everything before it, '' for a bare name. */
  dir: string;
  entries: SessionReviewEntry[];
  added: number;
  removed: number;
  /** Every change was recorded as added (a new file). */
  created: boolean;
  /** No change has a diff to count (too large, binary, unreadable). */
  unavailable: boolean;
}

function splitPath(path: string): { name: string; dir: string } {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index < 0
    ? { name: normalized, dir: '' }
    : { name: normalized.slice(index + 1), dir: normalized.slice(0, index) };
}

export function groupReviewByFile(entries: readonly SessionReviewEntry[]): SessionReviewFile[] {
  const files = new Map<string, SessionReviewFile>();
  for (const entry of entries) {
    let file = files.get(entry.path);
    if (!file) {
      file = {
        path: entry.path,
        ...splitPath(entry.path),
        entries: [],
        added: 0,
        removed: 0,
        created: true,
        unavailable: true,
      };
      files.set(entry.path, file);
    }
    file.entries.push(entry);
    if (!entry.unavailable) {
      file.added += entry.added;
      file.removed += entry.removed;
      file.unavailable = false;
    }
    if (entry.status !== 'added') file.created = false;
  }
  return [...files.values()];
}

/** The file a change-card request names: by its entry first, then by path. */
export function fileForChangeFocus(
  files: readonly SessionReviewFile[],
  focus: { entryId: string; path: string }
): SessionReviewFile | undefined {
  return (
    files.find((file) => file.entries.some((entry) => entry.id === focus.entryId)) ??
    files.find((file) => file.path === focus.path)
  );
}

/** The directory, shortened in the middle the way the reference does (`backend/src/…/dto`). */
export function shortenDir(dir: string, max = 28): string {
  if (dir.length <= max) return dir;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${dir.slice(0, keep)}…${dir.slice(dir.length - keep)}`;
}
