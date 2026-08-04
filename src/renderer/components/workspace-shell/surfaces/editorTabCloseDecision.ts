/**
 * T-13 follow-up (coordinator ruling): closing a dirty tab with no
 * confirmation is a silent data-loss path — the old shell (`FilePanel.tsx`'s
 * `shouldPromptUnsaved` / `requestCloseTab`) always prompts first, so the new
 * editor surface must not regress behind it.
 *
 * Pure decision logic only. The actual prompt (`requestUnsavedChoice`, the
 * EXISTING `stores/unsavedPrompt.ts` + `UnsavedChangesDialog` +
 * `UnsavedPromptHost` already mounted once at `App.tsx` root — reused as-is,
 * nothing new to mount), the save mutation and `closeFile` all need I/O and
 * stay in `EditorSurfaceView`.
 */

import type { UnsavedChangesChoice } from '@/components/files/UnsavedChangesDialog';
import type { EditorAutoSave } from '@/stores/settings/types';

export interface ShouldPromptUnsavedCloseInput {
  isDirty: boolean;
  autoSave: EditorAutoSave;
}

/**
 * Mirrors `FilePanel.tsx`'s `shouldPromptUnsaved` exactly: only prompt when
 * autosave is fully off AND the tab actually has unsaved edits. With any
 * autosave mode on, Monaco's debounced/focus/window-change save already
 * keeps the tab clean well before a close reaches this check, so prompting
 * there would be a false alarm the old shell never showed either.
 */
export function shouldPromptUnsavedClose(input: ShouldPromptUnsavedCloseInput): boolean {
  return input.autoSave === 'off' && input.isDirty;
}

export type UnsavedCloseAction = 'save-then-close' | 'close' | 'cancel';

/**
 * Maps the dialog's three-way choice onto what the caller does next — same
 * semantics as `FilePanel.tsx`'s `requestCloseTab`: `'save'` saves then
 * closes (aborting the close on a save failure is the caller's job, since
 * that needs the save mutation's result), `'dontSave'` closes without
 * saving, `'cancel'` does nothing at all (tab stays open, dirty or not).
 */
export function decideUnsavedCloseAction(choice: UnsavedChangesChoice): UnsavedCloseAction {
  switch (choice) {
    case 'save':
      return 'save-then-close';
    case 'dontSave':
      return 'close';
    case 'cancel':
      return 'cancel';
  }
}
