import { describe, expect, it } from 'vitest';
import { type ResolveShellShortcutInput, resolveShellShortcut } from '../shellShortcuts';

function input(overrides: Partial<ResolveShellShortcutInput> = {}): ResolveShellShortcutInput {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isMac: false,
    targetIsEditable: false,
    isComposing: false,
    ...overrides,
  };
}

describe('resolveShellShortcut', () => {
  describe('Ctrl/Cmd+J — toggle context panel', () => {
    it('resolves on non-mac with ctrlKey', () => {
      expect(resolveShellShortcut(input({ code: 'KeyJ', ctrlKey: true }))).toEqual({
        type: 'toggle-context-panel',
      });
    });

    it('resolves on mac with metaKey', () => {
      expect(resolveShellShortcut(input({ code: 'KeyJ', metaKey: true, isMac: true }))).toEqual({
        type: 'toggle-context-panel',
      });
    });

    it('is honored even when the target is editable (only exception)', () => {
      expect(
        resolveShellShortcut(input({ code: 'KeyJ', ctrlKey: true, targetIsEditable: true }))
      ).toEqual({ type: 'toggle-context-panel' });
    });

    it('does not resolve on mac with ctrlKey (wrong mod for the platform)', () => {
      expect(resolveShellShortcut(input({ code: 'KeyJ', ctrlKey: true, isMac: true }))).toBeNull();
    });

    it('does not resolve on non-mac with metaKey (wrong mod for the platform)', () => {
      expect(resolveShellShortcut(input({ code: 'KeyJ', metaKey: true }))).toBeNull();
    });
  });

  describe('Ctrl/Cmd+1..4 — select surface', () => {
    it('maps Digit1..4 to context/git/editor/terminal in rail order on non-mac', () => {
      const expected = ['context', 'git', 'editor', 'terminal'];
      for (let digit = 1; digit <= 4; digit++) {
        const action = resolveShellShortcut(input({ code: `Digit${digit}`, ctrlKey: true }));
        expect(action).toEqual({ type: 'select-surface', surfaceId: expected[digit - 1] });
      }
    });

    it('maps Digit1..4 the same way on mac with metaKey', () => {
      const expected = ['context', 'git', 'editor', 'terminal'];
      for (let digit = 1; digit <= 4; digit++) {
        const action = resolveShellShortcut(
          input({ code: `Digit${digit}`, metaKey: true, isMac: true })
        );
        expect(action).toEqual({ type: 'select-surface', surfaceId: expected[digit - 1] });
      }
    });

    it('does not resolve Digit5 (only the first four rail surfaces are bound)', () => {
      expect(resolveShellShortcut(input({ code: 'Digit5', ctrlKey: true }))).toBeNull();
    });

    it('is not honored when the target is editable', () => {
      expect(
        resolveShellShortcut(input({ code: 'Digit1', ctrlKey: true, targetIsEditable: true }))
      ).toBeNull();
    });
  });

  describe('Ctrl/Cmd+` — open terminal surface', () => {
    it('resolves on non-mac with ctrlKey', () => {
      expect(resolveShellShortcut(input({ code: 'Backquote', ctrlKey: true }))).toEqual({
        type: 'open-terminal',
      });
    });

    it('resolves on mac with metaKey', () => {
      expect(
        resolveShellShortcut(input({ code: 'Backquote', metaKey: true, isMac: true }))
      ).toEqual({ type: 'open-terminal' });
    });

    it('is not honored when the target is editable', () => {
      expect(
        resolveShellShortcut(input({ code: 'Backquote', ctrlKey: true, targetIsEditable: true }))
      ).toBeNull();
    });
  });

  describe('Ctrl/Cmd+B — toggle sidebar collapsed', () => {
    it('resolves on non-mac with ctrlKey', () => {
      expect(resolveShellShortcut(input({ code: 'KeyB', ctrlKey: true }))).toEqual({
        type: 'toggle-sidebar',
      });
    });

    it('resolves on mac with metaKey', () => {
      expect(resolveShellShortcut(input({ code: 'KeyB', metaKey: true, isMac: true }))).toEqual({
        type: 'toggle-sidebar',
      });
    });

    it('is not honored when the target is editable (avoids Monaco bold/cursor-left collision)', () => {
      expect(
        resolveShellShortcut(input({ code: 'KeyB', ctrlKey: true, targetIsEditable: true }))
      ).toBeNull();
    });
  });

  describe('modifier exclusions', () => {
    it('does not resolve when altKey is also pressed', () => {
      expect(resolveShellShortcut(input({ code: 'KeyJ', ctrlKey: true, altKey: true }))).toBeNull();
    });

    it('does not resolve when shiftKey is also pressed', () => {
      expect(
        resolveShellShortcut(input({ code: 'Digit1', ctrlKey: true, shiftKey: true }))
      ).toBeNull();
    });

    it('does not resolve without the platform mod key at all', () => {
      expect(resolveShellShortcut(input({ code: 'KeyB' }))).toBeNull();
    });

    // m16: each platform's mod key must exclude the other platform's own key.
    it('does not resolve on non-mac when metaKey is also pressed alongside ctrlKey (e.g. Super+Ctrl+1)', () => {
      expect(
        resolveShellShortcut(input({ code: 'Digit1', ctrlKey: true, metaKey: true }))
      ).toBeNull();
    });

    it('does not resolve on mac when ctrlKey is also pressed alongside metaKey', () => {
      expect(
        resolveShellShortcut(input({ code: 'Digit1', metaKey: true, ctrlKey: true, isMac: true }))
      ).toBeNull();
    });

    it('still resolves on non-mac with ctrlKey alone (no metaKey regression)', () => {
      expect(resolveShellShortcut(input({ code: 'KeyB', ctrlKey: true }))).toEqual({
        type: 'toggle-sidebar',
      });
    });

    it('still resolves on mac with metaKey alone (no ctrlKey regression)', () => {
      expect(resolveShellShortcut(input({ code: 'KeyB', metaKey: true, isMac: true }))).toEqual({
        type: 'toggle-sidebar',
      });
    });
  });

  // m15: IME composition guard (mirrors App/useAppKeyboardShortcuts.ts's own
  // `e.isComposing` check).
  describe('IME composition guard', () => {
    it('returns null for Ctrl/Cmd+J while composing — the one shortcut normally exempt from focus protection', () => {
      expect(
        resolveShellShortcut(input({ code: 'KeyJ', ctrlKey: true, isComposing: true }))
      ).toBeNull();
    });

    it('returns null for every other binding while composing', () => {
      expect(
        resolveShellShortcut(input({ code: 'Digit1', ctrlKey: true, isComposing: true }))
      ).toBeNull();
      expect(
        resolveShellShortcut(input({ code: 'Backquote', ctrlKey: true, isComposing: true }))
      ).toBeNull();
      expect(
        resolveShellShortcut(input({ code: 'KeyB', ctrlKey: true, isComposing: true }))
      ).toBeNull();
    });

    it('resolves normally once composition ends', () => {
      expect(
        resolveShellShortcut(input({ code: 'KeyJ', ctrlKey: true, isComposing: false }))
      ).toEqual({ type: 'toggle-context-panel' });
    });
  });

  describe('unrelated keys', () => {
    it('returns null for a key outside the four bindings', () => {
      expect(resolveShellShortcut(input({ code: 'KeyA', ctrlKey: true }))).toBeNull();
    });
  });
});
