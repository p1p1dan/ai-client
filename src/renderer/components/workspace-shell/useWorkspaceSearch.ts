import { useCallback, useEffect, useState } from 'react';
import type { ChatSearchRow } from '@/components/search/useChatSearch';
import type { SearchMode } from '@/components/search/useGlobalSearch';
import { useEditor } from '@/hooks/useEditor';
import { useChatJumpStore } from '@/stores/chatJump';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSettingsStore } from '@/stores/settings';
import { useActivateSession } from './useActivateSession';
import { readWorkspaceRootPath, useWorkspaceRootPath } from './useWorkspaceRootPath';
import { resolveWorkspaceSearchShortcut } from './workspaceSearchShortcuts';

/**
 * The shell's search dialog. Chat search (stage 3) opens it without a
 * workspace too: only the file and content tabs need one, so `rootPath` is
 * null on a home page with no repository picked.
 */
export function useWorkspaceSearch() {
  const rootPath = useWorkspaceRootPath();
  const bindings = useSettingsStore((state) => state.searchKeybindings);
  const { navigateToFile } = useEditor();
  const activateSession = useActivateSession();
  const [request, setRequest] = useState<{ rootPath: string | null; mode: SearchMode } | null>(
    null
  );

  useEffect(() => {
    setRequest((current) => (current?.rootPath === rootPath ? current : null));
  }, [rootPath]);

  const openSearch = useCallback((mode: SearchMode) => {
    const currentRoot = readWorkspaceRootPath();
    if (currentRoot || mode === 'chat') setRequest({ rootPath: currentRoot, mode });
  }, []);

  const closeSearch = useCallback(() => setRequest(null), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const mode = resolveWorkspaceSearchShortcut(event, bindings);
      if (!mode || (mode !== 'chat' && !readWorkspaceRootPath())) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      openSearch(mode);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [bindings, openSearch]);

  const onOpenFile = useCallback(
    (path: string, line?: number, column?: number, matchLength?: number) => {
      const searchRoot = request?.rootPath;
      if (!searchRoot || readWorkspaceRootPath() !== searchRoot) return;
      void navigateToFile(path, line, column, matchLength, undefined, {
        stillValid: () => readWorkspaceRootPath() === searchRoot,
      });
    },
    [request, navigateToFile]
  );

  /**
   * Chat search (stage 4): open the chat the way a sidebar click does, then
   * ask its timeline to show the first match (`useChatJumpReveal`). A chat
   * that matched by title only just opens.
   */
  const onOpenChat = useCallback(
    (row: ChatSearchRow, query: string) => {
      const known = useChatSessionsStore
        .getState()
        .sessions.some((session) => session.id === row.sessionId);
      if (!known) return;
      activateSession(row.sessionId);
      const jump = useChatJumpStore.getState();
      if (row.messageKeys.length > 0) {
        jump.requestJump({ sessionId: row.sessionId, query, messageKeys: row.messageKeys });
      } else {
        jump.clear();
      }
    },
    [activateSession]
  );

  return {
    request: request?.rootPath === rootPath ? request : null,
    openSearch,
    closeSearch,
    onOpenFile,
    onOpenChat,
  };
}
