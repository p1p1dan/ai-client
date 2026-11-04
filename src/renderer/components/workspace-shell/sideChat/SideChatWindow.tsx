import { SIDE_CHAT_WINDOW_DEFAULT_SIZE, SIDE_CHAT_WINDOW_NAME } from '@shared/sideChatWindow';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSideChatStore } from '@/stores/sideChat';
import { resolveShellShortcut } from '../shellShortcuts';
import { openPopoutWindow, type PopoutWindow } from './popoutWindow';
import { SideChat } from './SideChat';

/**
 * Decision 209 §3: the side chat in a window of its own. Mounted while the
 * side chat is open in that form; opening the window is this component's
 * mount, closing it its unmount, so the window lives exactly as long as the
 * side chat stays in that form.
 *
 *  - The window cannot be opened (Main refused it): the side chat docks.
 *  - The user closes the window itself (Alt+F4, the window manager): the side
 *    chat closes, as its own ✕ would.
 *  - Ctrl/Cmd+; inside the window does what it does in the main one; the main
 *    window's listener cannot hear keys pressed here.
 */
export function SideChatWindow() {
  const { t } = useI18n();
  const [popout, setPopout] = useState<PopoutWindow | null>(null);
  const title = t('Side chat');
  // The window opens once per mount; its title follows in the effect below.
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => {
    let cancelled = false;
    let teardown: (() => void) | null = null;
    // A microtask later: React's development double-run of effects would
    // otherwise open the window, close it and open it again.
    queueMicrotask(() => {
      if (cancelled) return;
      const opened = openPopoutWindow({
        name: SIDE_CHAT_WINDOW_NAME,
        title: titleRef.current,
        ...SIDE_CHAT_WINDOW_DEFAULT_SIZE,
      });
      if (!opened) {
        useSideChatStore.getState().setForm('dock');
        return;
      }
      const onClosedByUser = () => useSideChatStore.getState().close();
      const onKeyDown = (event: KeyboardEvent) => {
        const action = resolveShellShortcut({
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isMac: window.electronAPI?.env?.platform === 'darwin',
          targetIsEditable: true,
          isComposing: event.isComposing,
        });
        if (action?.type !== 'toggle-side-chat') return;
        event.preventDefault();
        useSideChatStore.getState().toggleFor(useChatSessionsStore.getState().activeSessionId);
      };
      opened.window.addEventListener('pagehide', onClosedByUser);
      opened.window.addEventListener('keydown', onKeyDown, true);
      opened.window.focus();
      setPopout(opened);
      teardown = () => {
        // Listeners off first: closing it from here is not the user closing it.
        opened.window.removeEventListener('pagehide', onClosedByUser);
        opened.window.removeEventListener('keydown', onKeyDown, true);
        opened.dispose();
        setPopout(null);
      };
    });
    return () => {
      cancelled = true;
      teardown?.();
    };
  }, []);

  useEffect(() => {
    if (popout) popout.window.document.title = title;
  }, [popout, title]);

  return popout ? createPortal(<SideChat placement="window" />, popout.container) : null;
}
