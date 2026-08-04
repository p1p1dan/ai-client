import { describe, expect, it } from 'vitest';
import { decideUnsavedCloseAction, shouldPromptUnsavedClose } from '../editorTabCloseDecision';

describe('shouldPromptUnsavedClose', () => {
  it('prompts when autosave is off and the tab is dirty', () => {
    expect(shouldPromptUnsavedClose({ isDirty: true, autoSave: 'off' })).toBe(true);
  });

  it('does not prompt when the tab is clean, regardless of autosave mode', () => {
    expect(shouldPromptUnsavedClose({ isDirty: false, autoSave: 'off' })).toBe(false);
    expect(shouldPromptUnsavedClose({ isDirty: false, autoSave: 'afterDelay' })).toBe(false);
  });

  it('does not prompt when any autosave mode is on, even if dirty', () => {
    expect(shouldPromptUnsavedClose({ isDirty: true, autoSave: 'afterDelay' })).toBe(false);
    expect(shouldPromptUnsavedClose({ isDirty: true, autoSave: 'onFocusChange' })).toBe(false);
    expect(shouldPromptUnsavedClose({ isDirty: true, autoSave: 'onWindowChange' })).toBe(false);
  });
});

describe('decideUnsavedCloseAction', () => {
  it('maps save to save-then-close', () => {
    expect(decideUnsavedCloseAction('save')).toBe('save-then-close');
  });

  it('maps dontSave to close', () => {
    expect(decideUnsavedCloseAction('dontSave')).toBe('close');
  });

  it('maps cancel to cancel', () => {
    expect(decideUnsavedCloseAction('cancel')).toBe('cancel');
  });
});
