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
  // D08: Ctrl/Cmd+J is UNBOUND. It toggled the right context panel, which no
  // longer exists; the surfaces moved into the dock, and Ctrl/Cmd+B toggles
  // that. A key left pointing at a deleted column is a dead key, so it goes
  // rather than becoming a silent alias.
  describe('Ctrl/Cmd+J — no longer bound (D08)', () => {
    it('resolves to nothing on either platform', () => {
      expect(resolveShellShortcut(input({ code: 'KeyJ', ctrlKey: true }))).toBeNull();
      expect(resolveShellShortcut(input({ code: 'KeyJ', metaKey: true, isMac: true }))).toBeNull();
    });

    it('is not honored while editable either — its focus exemption went with it', () => {
      expect(
        resolveShellShortcut(input({ code: 'KeyJ', ctrlKey: true, targetIsEditable: true }))
      ).toBeNull();
    });
  });

  describe('Ctrl/Cmd+1..5 — select surface', () => {
    // D08: the dock has five entries and `chat` leads them, so every digit
    // shifted by one and Digit5 became bound.
    const expected = ['chat', 'git', 'editor', 'context', 'run'];

    it('maps Digit1..5 to chat/git/files/context/run in rail order on non-mac', () => {
      for (let digit = 1; digit <= expected.length; digit++) {
        const action = resolveShellShortcut(input({ code: `Digit${digit}`, ctrlKey: true }));
        expect(action).toEqual({ type: 'select-surface', surfaceId: expected[digit - 1] });
      }
    });

    it('maps Digit1..5 the same way on mac with metaKey', () => {
      for (let digit = 1; digit <= expected.length; digit++) {
        const action = resolveShellShortcut(
          input({ code: `Digit${digit}`, metaKey: true, isMac: true })
        );
        expect(action).toEqual({ type: 'select-surface', surfaceId: expected[digit - 1] });
      }
    });

    it('does not resolve Digit6 (only the five dock entries are bound)', () => {
      expect(resolveShellShortcut(input({ code: 'Digit6', ctrlKey: true }))).toBeNull();
    });

    it('is not honored when the target is editable', () => {
      expect(
        resolveShellShortcut(input({ code: 'Digit1', ctrlKey: true, targetIsEditable: true }))
      ).toBeNull();
    });
  });

  // 2026-09-04: Ctrl/Cmd+` is unbound — the terminal surface lost its rail
  // button, and a shortcut that opens something unreachable is a dead key.
  describe('Ctrl/Cmd+` — no longer bound', () => {
    it('resolves to nothing on non-mac with ctrlKey', () => {
      expect(resolveShellShortcut(input({ code: 'Backquote', ctrlKey: true }))).toBeNull();
    });

    it('resolves to nothing on mac with metaKey', () => {
      expect(
        resolveShellShortcut(input({ code: 'Backquote', metaKey: true, isMac: true }))
      ).toBeNull();
    });
  });

  describe('Ctrl/Cmd+B — toggle the dock panel', () => {
    it('resolves on non-mac with ctrlKey', () => {
      expect(resolveShellShortcut(input({ code: 'KeyB', ctrlKey: true }))).toEqual({
        type: 'toggle-dock',
      });
    });

    it('resolves on mac with metaKey', () => {
      expect(resolveShellShortcut(input({ code: 'KeyB', metaKey: true, isMac: true }))).toEqual({
        type: 'toggle-dock',
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
        type: 'toggle-dock',
      });
    });

    it('still resolves on mac with metaKey alone (no ctrlKey regression)', () => {
      expect(resolveShellShortcut(input({ code: 'KeyB', metaKey: true, isMac: true }))).toEqual({
        type: 'toggle-dock',
      });
    });
  });

  // m15: IME composition guard (mirrors App/useAppKeyboardShortcuts.ts's own
  // `e.isComposing` check).
  describe('IME composition guard', () => {
    it('returns null for every binding while composing', () => {
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
        resolveShellShortcut(input({ code: 'KeyB', ctrlKey: true, isComposing: false }))
      ).toEqual({ type: 'toggle-dock' });
    });
  });

  describe('unrelated keys', () => {
    it('returns null for a key outside the four bindings', () => {
      expect(resolveShellShortcut(input({ code: 'KeyA', ctrlKey: true }))).toBeNull();
    });
  });
});
