import type { FileChangeStatus } from '@shared/types';

/**
 * Design system v2 §2.4: one colour per git status, on the semantic tokens,
 * shared by every list that shows a status letter (changes list, changes
 * tree, commit file list). Added / untracked are new-file green, modified is
 * amber, deleted red, rename / copy the info hue. A conflict has no hue of
 * its own; it takes red (it needs the user's hand) and is told apart from a
 * deletion by its letter and icon.
 */
export const GIT_STATUS_TONE: Record<FileChangeStatus, string> = {
  M: 'text-warning',
  A: 'text-success',
  D: 'text-destructive',
  R: 'text-info',
  C: 'text-info',
  U: 'text-success',
  X: 'text-destructive',
};
