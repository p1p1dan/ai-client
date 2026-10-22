/**
 * A08: wires `resolveShellShortcut` to the shell layout store via a window
 * `keydown` listener. Mounted once from `WorkspaceShell`, so it is only live
 * while the new shell is rendered — the legacy shell's own global shortcuts
 * (`App/useAppKeyboardShortcuts.ts`) are untouched and keep working there.
 */
import { useEffect, useRef } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { useSideChatStore } from '@/stores/sideChat';
import { resolveShellShortcut } from './shellShortcuts';
import type { PaneView } from './workPanelModel';

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
 * `paneView` is what is on screen now (the shell derives it,
 * `resolvePaneView`): a digit for a pane on screen closes it instead of
 * re-opening it, and Ctrl/Cmd+\ closes the focused one.
 */
export function useShellShortcuts({ paneView }: { paneView: PaneView }): void {
  const toggleSidebar = useShellLayoutStore((state) => state.toggleSidebar);
  const focusChatList = useShellLayoutStore((state) => state.focusChatList);
  const togglePane = useShellLayoutStore((state) => state.togglePane);
  const closePane = useShellLayoutStore((state) => state.closePane);
  // Read at key time: the listener is installed once, not per shell render.
  const paneViewRef = useRef(paneView);
  paneViewRef.current = paneView;

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
      const { panes: visiblePanes, focused: focusedPane } = paneViewRef.current;
      // Nothing to close: leave the chord to whoever else wants it.
      if (action.type === 'close-focused-pane' && !focusedPane) {
        return;
      }
      // Layout 5f: no conversation open and no side chat to close.
      const activeSessionId = useChatSessionsStore.getState().activeSessionId;
      if (
        action.type === 'toggle-side-chat' &&
        !activeSessionId &&
        !useSideChatStore.getState().open
      ) {
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
        case 'toggle-pane':
          togglePane(action.pane, visiblePanes);
          break;
        case 'close-focused-pane':
          if (focusedPane) closePane(focusedPane);
          break;
        case 'toggle-side-chat':
          useSideChatStore.getState().toggleFor(activeSessionId);
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
  }, [toggleSidebar, focusChatList, togglePane, closePane]);
}
