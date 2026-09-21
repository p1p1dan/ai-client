import { getDisplayPath, normalizePath } from '@shared/utils/path';
import type { DiffTabWorkdirTarget } from '@/stores/diffTabTarget';
import type { SessionReviewEntry } from './sessionReview';
import { resolveIntentPath } from './surfaces/resolveIntentPath';

export function sessionReviewDiffTarget(
  entry: Pick<SessionReviewEntry, 'path' | 'status'>,
  workspacePath: string
): DiffTabWorkdirTarget | null {
  const root = normalizePath(getDisplayPath(workspacePath));
  const absolute = resolveIntentPath(getDisplayPath(entry.path), root);
  if (!absolute) return null;
  // Review records use absolute paths; git's :path and HEAD:path require a
  // workspace-relative path. Reuse the editor's dot-segment normalization.
  const prefix = `${root.replace(/\/+$/, '')}/`;
  const windows = /^[a-zA-Z]:\//.test(root) || root.startsWith('//');
  const within = windows
    ? absolute.toLowerCase().startsWith(prefix.toLowerCase())
    : absolute.startsWith(prefix);
  if (!within || absolute.length === prefix.length) return null;
  return {
    kind: 'workdir',
    path: absolute.slice(prefix.length),
    staged: false,
    status: entry.status === 'added' ? 'A' : entry.status === 'modified' ? 'M' : undefined,
  };
}
