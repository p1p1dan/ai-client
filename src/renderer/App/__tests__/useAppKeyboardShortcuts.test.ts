import { describe, expect, it } from 'vitest';
import { shouldHandleMainTabShortcut } from '../mainTabShortcutGate';

/**
 * M2 (double-trigger fix): the legacy `mainTabKeybindings` branch in
 * `useAppKeyboardShortcuts.ts` and the OpenChamber shell's own
 * `useShellShortcuts` (workspace-shell/shellShortcuts.ts) both bind
 * Ctrl/Cmd+1..4 on Linux/Windows. `App.tsx` mounts this hook unconditionally
 * regardless of which shell is rendered, so without a gate both fire on the
 * same keypress. `shouldHandleMainTabShortcut` is the pure decision this gate
 * reduces to — everything else (reading the settings store, wiring the
 * effect) is DOM/store plumbing this file's other tests intentionally do not
 * re-derive.
 */
describe('shouldHandleMainTabShortcut', () => {
  it('handles the legacy mainTab shortcut when the OpenChamber shell is off', () => {
    expect(shouldHandleMainTabShortcut(false)).toBe(true);
  });

  it('yields to the OpenChamber shell once it is active', () => {
    expect(shouldHandleMainTabShortcut(true)).toBe(false);
  });
});
