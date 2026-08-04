/**
 * M2: gate for the legacy `mainTabKeybindings` branch in
 * `useAppKeyboardShortcuts.ts`. The OpenChamber shell (App.tsx's own
 * `useOpenChamberShell = SKIP_ONBOARDING_GATE || settings.useOpenChamberShell`)
 * binds its own Ctrl/Cmd+1..4 via `workspace-shell/shellShortcuts.ts`'s
 * `useShellShortcuts`. That hook is mounted unconditionally in App.tsx
 * regardless of which shell renders, so on Linux/Windows (both bind `ctrlKey`)
 * the two handlers double-fire on the same keypress — the legacy branch
 * silently mutates activeTab/worktreeTabMap/exitHomeView behind the new
 * shell's back. `stopPropagation` cannot fix this: both listeners are
 * capture-phase on `window`, and the legacy one (mounted first, in App.tsx)
 * runs before the new shell's. Once the new shell is active, the legacy branch
 * must yield entirely.
 *
 * Lives in its own module (not `useAppKeyboardShortcuts.ts`) so node-env
 * vitest can import it without dragging in the settings store's import graph.
 */
export function shouldHandleMainTabShortcut(useOpenChamberShell: boolean): boolean {
  return !useOpenChamberShell;
}
