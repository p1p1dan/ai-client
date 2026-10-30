import type { AppCloseRequestPayload, AppCloseRequestReason } from '@shared/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import {
  describeFileSaveFailure,
  flagConflictingDiskContent,
  isFileContentConflict,
} from '@/lib/fileSaveFailure';
import { useEditorStore } from '@/stores/editor';
import { useSettingsStore } from '@/stores/settings';

export function useAppLifecycle(setCloseDialogOpen: (open: boolean) => void) {
  const { t } = useI18n();
  const pendingRequestIdRef = useRef<string | null>(null);
  // T065: what the dialog is actually confirming. Main has always said, and
  // this side always asked about quitting the whole app.
  const [closeRequestReason, setCloseRequestReason] = useState<AppCloseRequestReason>('quit-app');
  const getDirtyPaths = useCallback(() => {
    const state = useEditorStore.getState();
    const editorSettings = useSettingsStore.getState().editorSettings;
    const allTabs = [...state.tabs, ...Object.values(state.worktreeStates).flatMap((s) => s.tabs)];

    return editorSettings.autoSave === 'off'
      ? Array.from(new Set(allTabs.filter((t) => t.isDirty).map((t) => t.path)))
      : [];
  }, []);

  // Called by the close confirmation dialog when user confirms
  const confirmCloseAndRespond = useCallback(() => {
    const requestId = pendingRequestIdRef.current;
    if (!requestId) return;
    pendingRequestIdRef.current = null;

    window.electronAPI.app.respondCloseRequest(requestId, {
      confirmed: true,
      dirtyPaths: getDirtyPaths(),
    });
  }, [getDirtyPaths]);

  // Called by the close confirmation dialog when user cancels (or dismisses)
  const cancelCloseAndRespond = useCallback(() => {
    const requestId = pendingRequestIdRef.current;
    if (!requestId) return;
    pendingRequestIdRef.current = null;

    window.electronAPI.app.respondCloseRequest(requestId, { confirmed: false, dirtyPaths: [] });
  }, []);

  // Listen for close request from main process
  useEffect(() => {
    const cleanup = window.electronAPI.app.onCloseRequest((payload: AppCloseRequestPayload) => {
      if (payload.reason === 'replace-window') {
        window.electronAPI.app.respondCloseRequest(payload.requestId, {
          confirmed: true,
          dirtyPaths: getDirtyPaths(),
        });
        return;
      }

      pendingRequestIdRef.current = payload.requestId;
      setCloseRequestReason(payload.reason);
      setCloseDialogOpen(true);
    });
    return cleanup;
  }, [getDirtyPaths, setCloseDialogOpen]);

  // Main process asks renderer to save a specific dirty file before closing
  useEffect(() => {
    const cleanup = window.electronAPI.app.onCloseSaveRequest(async (requestId, path) => {
      try {
        const state = useEditorStore.getState();
        const allTabs = [
          ...state.tabs,
          ...Object.values(state.worktreeStates).flatMap((s) => s.tabs),
        ];
        const tab = allTabs.find((t) => t.path === path);
        if (!tab) {
          window.electronAPI.app.respondCloseSaveRequest(requestId, {
            ok: false,
            error: 'File not found in editor tabs',
          });
          return;
        }

        if (tab.baseContent === undefined) throw new Error('File content baseline is missing');
        await window.electronAPI.file.write(path, tab.content, tab.encoding, tab.baseContent);
        useEditorStore.getState().markFileSaved(path, tab.content);

        window.electronAPI.app.respondCloseSaveRequest(requestId, {
          ok: true,
        });
      } catch (err) {
        // Main shows this text in its "Save failed" dialog and keeps the window open.
        if (isFileContentConflict(err)) void flagConflictingDiskContent(path);
        window.electronAPI.app.respondCloseSaveRequest(requestId, {
          ok: false,
          error: describeFileSaveFailure(err, t, { withBannerHint: true }),
        });
      }
    });
    return cleanup;
  }, [t]);

  return { confirmCloseAndRespond, cancelCloseAndRespond, closeRequestReason };
}
