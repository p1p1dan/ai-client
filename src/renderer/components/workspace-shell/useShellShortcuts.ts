/**
 * A08: wires `resolveShellShortcut` to the shell layout store via a window
 * `keydown` listener. Mounted once from `WorkspaceShell`, so it is only live
 * while the new shell is rendered — the legacy shell's own global shortcuts
 * (`App/useAppKeyboardShortcuts.ts`) are untouched and keep working there.
 */
import { useEffect } from 'react';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { resolveShellShortcut } from './shellShortcuts';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    return true;
  }
  return target.isContentEditable;
}

function isMacPlatform(): boolean {
  return window.electronAPI.env.platform === 'darwin';
}

export function useShellShortcuts(): void {
  const toggleContextPanel = useShellLayoutStore((state) => state.toggleContextPanel);
  const selectSurface = useShellLayoutStore((state) => state.selectSurface);
  const openSurface = useShellLayoutStore((state) => state.openSurface);
  const toggleSidebarCollapsed = useShellLayoutStore((state) => state.toggleSidebarCollapsed);
  // Same order the tab strip and rail render — see `numberedSurfaceIds`.
  const railOrder = useShellLayoutStore((state) => state.railOrder);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveShellShortcut({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isMac: isMacPlatform(),
        targetIsEditable: isEditableTarget(event.target),
        // m15: IME composition guard (mirrors App/useAppKeyboardShortcuts.ts).
        isComposing: event.isComposing,
        railOrder,
      });
      if (!action) {
        return;
      }
      event.preventDefault();
      switch (action.type) {
        case 'toggle-context-panel':
          toggleContextPanel();
          break;
        case 'select-surface':
          selectSurface(action.surfaceId);
          break;
        case 'open-terminal':
          openSurface('terminal');
          break;
        case 'toggle-sidebar':
          toggleSidebarCollapsed();
          break;
        default:
          break;
      }
    };

    // Capture phase (matches other shell-critical listeners in this codebase,
    // e.g. `App/useAppKeyboardShortcuts.ts`): intercepts before Monaco/xterm's
    // own element-level handlers can consume the event.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [toggleContextPanel, selectSurface, openSurface, toggleSidebarCollapsed, railOrder]);
}
