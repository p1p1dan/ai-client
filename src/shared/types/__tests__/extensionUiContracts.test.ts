import {
  EXTENSION_UI_DIALOG_METHODS,
  EXTENSION_UI_METHODS,
  type ExtensionUiMethod,
  isExtensionUiDialogMethod,
  isExtensionUiMethod,
  readExtensionUiDialogArgs,
  readExtensionUiResponse,
} from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';

/**
 * T07 — the Extension UI contracts at the protocol boundary.
 *
 * Both readers take UNTRUSTED input. `readExtensionUiDialogArgs` reads what a pi
 * extension asked for (arbitrary third-party code, not our own callers), and
 * `readExtensionUiResponse` reads what a renderer sent back — a value that
 * decides whether a blocked extension sees the user's answer or the bridge's
 * no-answer fallback. Every assertion below is about a way one of those can be
 * wrong.
 */

describe('extension UI method tables', () => {
  it('treats every dialog method as a method', () => {
    for (const method of EXTENSION_UI_DIALOG_METHODS) {
      expect(isExtensionUiMethod(method)).toBe(true);
      expect(isExtensionUiDialogMethod(method)).toBe(true);
    }
  });

  /**
   * The load-bearing half of the split: a display-state method must never open a
   * modal, because nothing is awaiting it and the dialog would never be closed
   * by an answer.
   */
  it('classifies fire-and-forget display methods as non-dialogs', () => {
    const nonDialogs = EXTENSION_UI_METHODS.filter(
      (m) => !(EXTENSION_UI_DIALOG_METHODS as readonly string[]).includes(m)
    );
    expect(nonDialogs).toContain('notify');
    expect(nonDialogs).toContain('setStatus');
    expect(nonDialogs).toContain('unsupported');
    for (const method of nonDialogs) {
      expect(isExtensionUiDialogMethod(method)).toBe(false);
      expect(readExtensionUiDialogArgs(method, { title: 'x' })).toBeUndefined();
    }
  });

  it('refuses values outside the table', () => {
    for (const bogus of ['', 'Select', 'prompt', 42, null, undefined, {}]) {
      expect(isExtensionUiMethod(bogus)).toBe(false);
      expect(isExtensionUiDialogMethod(bogus)).toBe(false);
    }
  });
});

describe('readExtensionUiDialogArgs', () => {
  it('reads a select and keeps its options in order', () => {
    expect(readExtensionUiDialogArgs('select', { title: 'Pick', options: ['a', 'b'] })).toEqual({
      method: 'select',
      title: 'Pick',
      options: ['a', 'b'],
    });
  });

  /**
   * Partial salvage, stated in the type doc: a human can still answer from the
   * entries that ARE strings, and dropping the dialog would strand the turn.
   */
  it('drops malformed options rather than the whole select', () => {
    const parsed = readExtensionUiDialogArgs('select', {
      title: 'Pick',
      options: ['keep', 3, null, { label: 'no' }, 'also-keep'],
    });
    expect(parsed).toEqual({ method: 'select', title: 'Pick', options: ['keep', 'also-keep'] });
  });

  it('refuses a select with nothing left to pick', () => {
    expect(readExtensionUiDialogArgs('select', { title: 'Pick', options: [] })).toBeUndefined();
    expect(readExtensionUiDialogArgs('select', { title: 'Pick', options: [1, 2] })).toBeUndefined();
    expect(readExtensionUiDialogArgs('select', { title: 'Pick' })).toBeUndefined();
  });

  /**
   * A confirm with no message is still answerable — the title carries the
   * question. Refusing it would send a yes/no the extension is blocked on to the
   * fallback path for a cosmetic reason.
   */
  it('accepts a confirm with a missing message, defaulting it to empty', () => {
    expect(readExtensionUiDialogArgs('confirm', { title: 'Delete?' })).toEqual({
      method: 'confirm',
      title: 'Delete?',
      message: '',
    });
  });

  it('reads optional input/editor fields only when they are strings', () => {
    expect(readExtensionUiDialogArgs('input', { title: 'Name', placeholder: 'yours' })).toEqual({
      method: 'input',
      title: 'Name',
      placeholder: 'yours',
    });
    expect(readExtensionUiDialogArgs('input', { title: 'Name', placeholder: 7 })).toEqual({
      method: 'input',
      title: 'Name',
    });
    expect(readExtensionUiDialogArgs('editor', { title: 'Edit', prefill: 'body' })).toEqual({
      method: 'editor',
      title: 'Edit',
      prefill: 'body',
    });
    expect(readExtensionUiDialogArgs('editor', { title: 'Edit' })).toEqual({
      method: 'editor',
      title: 'Edit',
    });
  });

  it('refuses a dialog with no title and non-object args', () => {
    expect(readExtensionUiDialogArgs('confirm', { message: 'no title' })).toBeUndefined();
    expect(readExtensionUiDialogArgs('confirm', { title: 9, message: 'x' })).toBeUndefined();
    for (const args of [null, undefined, 'string', 42, ['a']]) {
      expect(readExtensionUiDialogArgs('confirm', args)).toBeUndefined();
    }
  });
});

describe('readExtensionUiResponse', () => {
  it('reads a well-formed answer', () => {
    expect(
      readExtensionUiResponse({ runtimeId: 'r1', uiRequestId: 'q1', ok: true, value: 'a' })
    ).toEqual({ runtimeId: 'r1', uiRequestId: 'q1', ok: true, value: 'a' });
  });

  /**
   * `value: undefined` is a real answer on this wire — `ui.select` resolving to
   * undefined is how "the user picked nothing" reaches the extension — so the
   * KEY's presence is what matters, not its truthiness.
   */
  it('preserves an explicitly-sent undefined value', () => {
    const parsed = readExtensionUiResponse({
      runtimeId: 'r1',
      uiRequestId: 'q1',
      ok: true,
      value: undefined,
    });
    expect(parsed).toBeDefined();
    expect(parsed && 'value' in parsed).toBe(true);
  });

  it('omits the value key when the sender omitted it', () => {
    const parsed = readExtensionUiResponse({ runtimeId: 'r1', uiRequestId: 'q1', ok: false });
    expect(parsed && 'value' in parsed).toBe(false);
  });

  /**
   * The one that must not bend: `ok` decides between the user's answer and the
   * bridge's fallback, so a truthy non-boolean would turn a dismissal into a
   * confirmation.
   */
  it('refuses a non-boolean ok rather than coercing it', () => {
    for (const ok of ['true', 1, {}, null, undefined]) {
      expect(readExtensionUiResponse({ runtimeId: 'r1', uiRequestId: 'q1', ok })).toBeUndefined();
    }
  });

  it('refuses a response that addresses nobody', () => {
    expect(readExtensionUiResponse({ uiRequestId: 'q1', ok: true })).toBeUndefined();
    expect(readExtensionUiResponse({ runtimeId: 'r1', ok: true })).toBeUndefined();
    expect(readExtensionUiResponse({ runtimeId: '', uiRequestId: 'q1', ok: true })).toBeUndefined();
    expect(readExtensionUiResponse({ runtimeId: 'r1', uiRequestId: '', ok: true })).toBeUndefined();
    for (const value of [null, undefined, 'x', 42, []]) {
      expect(readExtensionUiResponse(value)).toBeUndefined();
    }
  });

  it('keeps an error string and drops a non-string one', () => {
    expect(
      readExtensionUiResponse({ runtimeId: 'r1', uiRequestId: 'q1', ok: false, error: 'closed' })
    ).toMatchObject({ error: 'closed' });
    const parsed = readExtensionUiResponse({
      runtimeId: 'r1',
      uiRequestId: 'q1',
      ok: false,
      error: { code: 1 },
    });
    expect(parsed && 'error' in parsed).toBe(false);
  });
});

describe('protocol surface', () => {
  /**
   * The table is the pi `ExtensionUIContext` subset a GUI can honour, plus the
   * `unsupported` diagnostic. Growing it is a protocol change that needs a
   * renderer to match, so the count is pinned deliberately.
   */
  it('exposes exactly the fourteen portable methods', () => {
    expect(EXTENSION_UI_METHODS).toHaveLength(14);
    expect(new Set<ExtensionUiMethod>(EXTENSION_UI_METHODS).size).toBe(14);
  });
});
