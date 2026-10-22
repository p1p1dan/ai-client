/**
 * A08: wires `resolveShellShortcut` to the shell layout store via a window
 * `keydown` listener. Mounted once from `WorkspaceShell`, so it is only live
 * while the new shell is rendered — the legacy shell's own global shortcuts
 * (`App/useAppKeyboardShortcuts.ts`) are untouched and keep working there.
 */
import { useEffect } from 'react';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { resolveShellShortcut } from './shellShortcuts';
import type { WorkPanelTab } from './workPanelModel';

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

/**
 * `shownPanelTab` is the tab the work panel shows now (the shell derives it,
 * `resolveWorkPanelView`), so a digit for that tab closes the panel instead of
 * re-opening it.
 */
export function useShellShortcuts({ shownPanelTab }: { shownPanelTab: WorkPanelTab | null }): void {
  const toggleSidebar = useShellLayoutStore((state) => state.toggleSidebar);
  const focusChatList = useShellLayoutStore((state) => state.focusChatList);
  const toggleWorkPanel = useShellLayoutStore((state) => state.toggleWorkPanel);

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
      });
      if (!action) {
        return;
      }
      event.preventDefault();
      switch (action.type) {
        case 'toggle-sidebar':
          toggleSidebar();
          break;
        case 'focus-chat-list':
          focusChatList();
          break;
        case 'toggle-panel-tab':
          toggleWorkPanel(action.tab, shownPanelTab);
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
  }, [toggleSidebar, focusChatList, toggleWorkPanel, shownPanelTab]);
}
