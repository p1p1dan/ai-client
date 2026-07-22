import type { GitWorktree } from '@shared/types';
import { useQueryClient } from '@tanstack/react-query';
import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useEditorStore } from '@/stores/editor';
import { useNavigationStore } from '@/stores/navigation';
import { useSettingsStore } from '@/stores/settings';
import { requestUnsavedChoice } from '@/stores/unsavedPrompt';

const DEFERRED_GIT_FETCH_MS = 2500;

export function useWorktreeSelection(
  activeWorktree: GitWorktree | null,
  setActiveWorktree: (worktree: GitWorktree | null) => void,
  currentWorktreePathRef: MutableRefObject<string | null>,
  selectedRepo: string | null,
  setSelectedRepo: (repo: string) => void
) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const editorSettings = useSettingsStore((s) => s.editorSettings);
  const switchEditorWorktree = useEditorStore((s) => s.switchWorktree);
  const currentEditorWorktree = useEditorStore((s) => s.currentWorktreePath);
  const setActiveTab = useNavigationStore((s) => s.setActiveTab);
  const setWorktreeTab = useNavigationStore((s) => s.setWorktreeTab);
  const pendingGitFetchRef = useRef<{
    worktreePath: string;
    timeoutId: ReturnType<typeof setTimeout>;
  } | null>(null);

  // Sync editor state with active worktree
  useEffect(() => {
    const targetPath = activeWorktree?.path ?? null;
    if (targetPath !== currentEditorWorktree) {
      switchEditorWorktree(targetPath);
    }
  }, [activeWorktree, currentEditorWorktree, switchEditorWorktree]);

  useEffect(() => {
    return () => {
      if (pendingGitFetchRef.current) {
        clearTimeout(pendingGitFetchRef.current.timeoutId);
      }
    };
  }, []);

  // Helper function to refresh git data for a worktree
  const refreshGitData = useCallback(
    (worktreePath: string) => {
      // Update ref to track current worktree for race condition prevention
      currentWorktreePathRef.current = worktreePath;

      // Immediately refresh local git data
      const localKeys = [
        'status',
        'file-changes',
        'file-diff',
        'log',
        'log-infinite',
        'submodules',
      ];
      for (const key of localKeys) {
        queryClient.invalidateQueries({ queryKey: ['git', key, worktreePath] });
      }
      queryClient.invalidateQueries({
        queryKey: ['git', 'submodule', 'changes', worktreePath],
      });

      const pendingFetch = pendingGitFetchRef.current;
      if (pendingFetch?.worktreePath === worktreePath) {
        return;
      }
      if (pendingFetch) {
        clearTimeout(pendingFetch.timeoutId);
      }

      const timeoutId = setTimeout(() => {
        const scheduledFetch = pendingGitFetchRef.current;
        if (!scheduledFetch || scheduledFetch.worktreePath !== worktreePath) {
          return;
        }
        pendingGitFetchRef.current = null;

        if (currentWorktreePathRef.current !== worktreePath) {
          return;
        }

        window.electronAPI.git
          .fetch(worktreePath)
          .then(() => {
            if (currentWorktreePathRef.current === worktreePath) {
              queryClient.invalidateQueries({
                queryKey: ['git', 'branches', worktreePath],
              });
              queryClient.invalidateQueries({
                queryKey: ['git', 'status', worktreePath],
              });
            }
          })
          .catch(() => {
            // Fetch errors are non-critical and should not block worktree switching.
          });
      }, DEFERRED_GIT_FETCH_MS);

      pendingGitFetchRef.current = { worktreePath, timeoutId };
    },
    [queryClient, currentWorktreePathRef]
  );

  const handleSelectWorktree = useCallback(
    async (worktree: GitWorktree, nextRepoPath?: string) => {
      if (editorSettings.autoSave === 'off') {
        const editorState = useEditorStore.getState();
        const dirtyTabs = editorState.tabs.filter((tab) => tab.isDirty);

        for (const tab of dirtyTabs) {
          const fileName = tab.path.split(/[/\\]/).pop() ?? tab.path;
          const choice = await requestUnsavedChoice(fileName);

          if (choice === 'cancel') {
            return;
          }

          if (choice === 'save') {
            try {
              await window.electronAPI.file.write(tab.path, tab.content, tab.encoding);
              useEditorStore.getState().markFileSaved(tab.path);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              toastManager.add({
                type: 'error',
                title: t('Save failed'),
                description: message,
              });
              return;
            }
          } else {
            try {
              const { content, isBinary } = await window.electronAPI.file.read(tab.path);
              if (!isBinary) {
                useEditorStore.getState().updateFileContent(tab.path, content, false);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              toastManager.add({
                type: 'error',
                title: t('File read failed'),
                description: message,
              });
              return;
            }
          }
        }
      }

      if (nextRepoPath && nextRepoPath !== selectedRepo) {
        setSelectedRepo(nextRepoPath);
      }

      // Save current worktree's tab state before switching
      if (activeWorktree?.path) {
        setWorktreeTab(activeWorktree.path, useNavigationStore.getState().activeTab);
      }

      // Switch to new worktree
      setActiveWorktree(worktree);

      // Restore the new worktree's tab state
      const savedTab = useNavigationStore.getState().worktreeTabMap[worktree.path] || 'chat';
      setActiveTab(savedTab);

      // Refresh git data for the new worktree
      refreshGitData(worktree.path);
    },
    [
      activeWorktree,
      editorSettings.autoSave,
      t,
      refreshGitData,
      selectedRepo,
      setSelectedRepo,
      setActiveWorktree,
      setActiveTab,
      setWorktreeTab,
    ]
  );

  return {
    refreshGitData,
    handleSelectWorktree,
  };
}
