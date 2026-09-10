import { AUTH_OPEN_ONBOARDING_EVENT } from '@shared/authGate';
import { getEffectiveTemporaryBasePath } from '@shared/defaultPaths';
import type {
  GitWorktree,
  RemoteConnectionStatus,
  WorktreeMergeOptions,
  WorktreeMergeResult,
} from '@shared/types';
import { getDisplayPathBasename } from '@shared/utils/path';
import { isRemoteVirtualPath, toRemoteVirtualPath } from '@shared/utils/remotePath';
import { buildRepositoryId } from '@shared/utils/workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsIntentStore } from '@/stores/settingsIntent';
import { type Repository, TEMP_REPO_ID } from './App/constants';
import {
  useAppLifecycle,
  useBackgroundImage,
  useFileDragDrop,
  useMenuActions,
  useMergeState,
  useOpenPathListener,
  usePanelState,
  useRepositoryState,
  useSettingsState,
  useTempWorkspaceSync,
  useTerminalNavigation,
  useWorktreeSelection,
  useWorktreeState,
  useWorktreeSync,
} from './App/hooks';
import { getStoredWorktreeMap, pathsEqual, STORAGE_KEYS } from './App/storage';
import { DevToolsOverlay } from './components/DevToolsOverlay';
import { UnsavedPromptHost } from './components/files/UnsavedPromptHost';
import { AddRepositoryDialog } from './components/git';
import { CloneProgressFloat } from './components/git/CloneProgressFloat';
import { BackgroundLayer } from './components/layout/BackgroundLayer';
import { GitMissingNotice } from './components/layout/GitMissingNotice';
import { WindowTitleBar } from './components/layout/WindowTitleBar';
import { RemoteAuthPromptHost } from './components/remote/RemoteAuthPromptHost';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { TempWorkspaceDialogs } from './components/temp-workspace/TempWorkspaceDialogs';
import { UpdateNotification } from './components/UpdateNotification';
import { Button } from './components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from './components/ui/dialog';
import { addToast, toastManager } from './components/ui/toast';
import { WorkspaceShell } from './components/workspace-shell';
import { MergeEditor, MergeWorktreeDialog } from './components/worktree';
import { useAutoFetchListener, useGitBranches } from './hooks/useGit';
import { useWebInspector } from './hooks/useWebInspector';
import {
  useWorktreeList,
  useWorktreeMerge,
  useWorktreeMergeAbort,
  useWorktreeMergeContinue,
  useWorktreeResolveConflict,
} from './hooks/useWorktree';
import { useI18n } from './i18n';
import { initCloneProgressListener } from './stores/cloneTasks';
import { useEditorStore } from './stores/editor';
import { startPermissionGateWatch } from './stores/permissionGate';
import { useSettingsStore } from './stores/settings';
import { useTempWorkspaceStore } from './stores/tempWorkspace';
import { useWorkspaceModeStore } from './stores/workspaceMode';
import { useWorktreeStore } from './stores/worktree';
import { initAgentActivityListener, useWorktreeActivityStore } from './stores/worktreeActivity';

function createPlaceholderWorktree(path: string): GitWorktree {
  return {
    path,
    head: '',
    branch: null,
    isMainWorktree: true,
    isLocked: false,
    prunable: false,
  };
}

// Initialize global clone progress listener
initCloneProgressListener();

export default function App() {
  const { t } = useI18n();

  // D47 S5: `ONBOARDING_LIVE_CREDENTIALS_STATUS` is retired — `auth.stateChanged`
  // is now the single push channel for credential-state changes.
  // `credentials_invalid` (rejected/corrupt/decrypt_failed) routes straight
  // back to the login gate instead of a dismissable toast: the old
  // "temporarily unavailable" warning let the user keep working in a chat
  // session whose agent spawns would now be gated, which just delayed the
  // failure instead of explaining it.
  useEffect(() => {
    return window.electronAPI.auth.onStateChanged((state) => {
      if (state.status === 'credentials_invalid') {
        window.dispatchEvent(new CustomEvent(AUTH_OPEN_ONBOARDING_EVENT));
      }
    });
  }, []);

  // Initialize agent activity listener for tree sidebar status display
  useEffect(() => {
    return initAgentActivityListener();
  }, []);

  // D10: watch which permission system each worker comes up on. Mounted here,
  // not in the tier control that reads it — `session.created` for a restored
  // session can land before the Composer renders, and a gate reported to nobody
  // is a tier picker that silently keeps promising four tiers.
  useEffect(() => {
    return startPermissionGateWatch();
  }, []);

  // Listen for auto-fetch completion events to refresh git status
  useAutoFetchListener();

  const repoState = useRepositoryState();
  const wtState = useWorktreeState();
  const settingsState = useSettingsState();
  const panelState = usePanelState();

  // R02-c: `/settings` typed in the composer. The composer sits several levels
  // below this and has no path to `openSettings`; threading a callback down
  // would put a prop on every component in between purely as a conduit. Same
  // pending-request shape as `navigation.ts`.
  const pendingSettingsOpen = useSettingsIntentStore((state) => state.pendingOpen);
  const openSettingsFromSlash = settingsState.openSettings;
  useEffect(() => {
    if (!pendingSettingsOpen) return;
    useSettingsIntentStore.getState().clearSettingsRequest();
    openSettingsFromSlash();
  }, [pendingSettingsOpen, openSettingsFromSlash]);

  const {
    repositories,
    selectedRepo,
    hydrated,
    setSelectedRepo: setSelectedRepoState,
    saveRepositories,
  } = repoState;

  const isGitRepo = useWorkspaceModeStore((s) => s.isGitRepo);
  const setIsGitRepo = useWorkspaceModeStore((s) => s.setIsGitRepo);

  const {
    worktreeTabMap,
    repoWorktreeMap,
    activeTab,
    activeWorktree,
    currentWorktreePathRef,
    setWorktreeTabMap,
    setRepoWorktreeMap,
    setActiveTab,
    setActiveWorktree,
    saveActiveWorktreeToMap,
  } = wtState;

  const {
    settingsCategory,
    settingsDialogOpen,
    setSettingsDialogOpen,
    openSettings,
    handleSettingsCategoryChange,
  } = settingsState;

  const {
    addRepoDialogOpen,
    initialLocalPath,
    addRepoInitialMode,
    closeDialogOpen,
    switchWorktreePathRef,
    setAddRepoDialogOpen,
    setInitialLocalPath,
    setAddRepoInitialMode,
    setCloseDialogOpen,
  } = panelState;

  const openLocalAddRepositoryDialog = useCallback(() => {
    setAddRepoDialogOpen(true);
  }, [setAddRepoDialogOpen]);

  const { isFileDragOver, repositorySidebarRef } = useFileDragDrop(
    true,
    setInitialLocalPath,
    openLocalAddRepositoryDialog
  );

  const [activatedRemoteRepos, setActivatedRemoteRepos] = useState<Set<string>>(() => new Set());
  const [remoteStatuses, setRemoteStatuses] = useState<Record<string, RemoteConnectionStatus>>({});

  const repositoryByPath = useMemo(
    () => new Map(repositories.map((repo) => [repo.path, repo])),
    [repositories]
  );

  useEffect(() => {
    return window.electronAPI.remote.onStatusChange(({ connectionId, status }) => {
      setRemoteStatuses((prev) => ({
        ...prev,
        [connectionId]: status,
      }));
    });
  }, []);

  const isRemoteRepoPath = useCallback(
    (repoPath: string | null | undefined) => {
      if (!repoPath || repoPath === TEMP_REPO_ID) {
        return false;
      }

      const repo = repositoryByPath.get(repoPath);
      return repo?.kind === 'remote' || isRemoteVirtualPath(repoPath);
    },
    [repositoryByPath]
  );

  const activateRemoteRepo = useCallback(
    (repoPath: string | null | undefined) => {
      if (!repoPath || !isRemoteRepoPath(repoPath)) {
        return;
      }

      const repo = repositoryByPath.get(repoPath);
      if (repo?.connectionId) {
        window.electronAPI.remote.connect(repo.connectionId).catch((error) => {
          console.warn('[remote] Failed to activate remote repository:', error);
        });
      }

      setActivatedRemoteRepos((prev) => {
        if (prev.has(repoPath)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(repoPath);
        return next;
      });
    },
    [isRemoteRepoPath, repositoryByPath]
  );

  const canLoadRepo = useCallback(
    (repoPath: string | null | undefined) => {
      if (!repoPath || repoPath === TEMP_REPO_ID) {
        return false;
      }
      return !isRemoteRepoPath(repoPath) || activatedRemoteRepos.has(repoPath);
    },
    [activatedRemoteRepos, isRemoteRepoPath]
  );

  // Detect whether the selected folder is a git repository.
  // This drives the UI mode (git mode vs normal folder mode).
  useEffect(() => {
    if (!selectedRepo || selectedRepo === TEMP_REPO_ID) {
      setIsGitRepo(null);
      return;
    }

    if (isRemoteRepoPath(selectedRepo)) {
      setIsGitRepo(true);
      return;
    }

    let cancelled = false;
    setIsGitRepo(null);

    window.electronAPI.folder
      .checkType(selectedRepo)
      .then((result) => {
        if (!cancelled) {
          setIsGitRepo(result);
        }
      })
      .catch((error) => {
        console.warn('[folder] Failed to check folder type:', error);
        if (!cancelled) {
          // Be permissive if detection fails.
          setIsGitRepo(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isRemoteRepoPath, selectedRepo, setIsGitRepo]);

  // In normal (non-git) mode, treat the selected folder itself as the working directory.
  useEffect(() => {
    if (!selectedRepo || selectedRepo === TEMP_REPO_ID) {
      return;
    }

    // Source Control tab is hidden outside git mode; ensure we don't end up on a blank view.
    if (activeTab === 'source-control' && isGitRepo !== true) {
      setActiveTab('chat');
    }

    if (isGitRepo !== false) {
      return;
    }

    if (activeWorktree?.path !== selectedRepo) {
      setActiveWorktree(createPlaceholderWorktree(selectedRepo));
    }
  }, [activeTab, activeWorktree?.path, isGitRepo, selectedRepo, setActiveTab, setActiveWorktree]);

  const setSelectedRepoForWorktreeSelection = useCallback(
    (repoPath: string) => {
      if (isRemoteRepoPath(repoPath)) {
        activateRemoteRepo(repoPath);
      }
      setSelectedRepoState(repoPath);
    },
    [activateRemoteRepo, isRemoteRepoPath, setSelectedRepoState]
  );

  const { refreshGitData, handleSelectWorktree: selectWorktree } = useWorktreeSelection(
    activeWorktree,
    setActiveWorktree,
    currentWorktreePathRef,
    worktreeTabMap,
    setWorktreeTabMap,
    activeTab,
    setActiveTab,
    selectedRepo,
    setSelectedRepoForWorktreeSelection
  );

  const handleSelectWorktree = useCallback(
    async (worktree: GitWorktree, nextRepoPath?: string) => {
      await selectWorktree(worktree, nextRepoPath);
    },
    [selectWorktree]
  );

  const {
    mergeDialogOpen,
    mergeWorktree,
    mergeConflicts,
    pendingMergeOptions,
    setMergeDialogOpen,
    setMergeConflicts,
    setPendingMergeOptions,
  } = useMergeState();

  const temporaryWorkspaceEnabled = useSettingsStore((s) => s.temporaryWorkspaceEnabled);
  const defaultTemporaryPath = useSettingsStore((s) => s.defaultTemporaryPath);
  const isWindows = window.electronAPI?.env.platform === 'win32';
  const pathSep = isWindows ? '\\' : '/';
  const homeDir = window.electronAPI?.env.HOME || '';
  const effectiveTempBasePath = useMemo(
    () => getEffectiveTemporaryBasePath(defaultTemporaryPath, homeDir, pathSep),
    [defaultTemporaryPath, homeDir, pathSep]
  );

  const effectiveTemporaryWorkspaceEnabled = temporaryWorkspaceEnabled;

  const setWorktreeError = useWorktreeStore((s) => s.setError);
  const clearEditorWorktreeState = useEditorStore((s) => s.clearWorktreeState);
  const tempWorkspaces = useTempWorkspaceStore((s) => s.items);

  const removeTempWorkspace = useTempWorkspaceStore((s) => s.removeItem);
  const renameTempWorkspace = useTempWorkspaceStore((s) => s.renameItem);
  const rehydrateTempWorkspaces = useTempWorkspaceStore((s) => s.rehydrate);

  const openTempDelete = useTempWorkspaceStore((s) => s.openDelete);

  // Web Inspector: listen for element inspection data and write to active agent terminal
  useWebInspector(activeWorktree?.path, selectedRepo ?? undefined);

  useTerminalNavigation(activeWorktree?.path ?? null, setActiveTab, setWorktreeTabMap);
  useMenuActions(openSettings);
  const { confirmCloseAndRespond, cancelCloseAndRespond } = useAppLifecycle(
    panelState.setCloseDialogOpen
  );

  useTempWorkspaceSync(
    effectiveTemporaryWorkspaceEnabled,
    selectedRepo,
    activeWorktree,
    tempWorkspaces,
    repositories,
    setSelectedRepoState,
    setActiveWorktree
  );

  const isTempRepo = selectedRepo === TEMP_REPO_ID;

  const worktreeRepoPath = isTempRepo ? null : selectedRepo;
  const selectedRepoCanLoad = canLoadRepo(worktreeRepoPath);
  const selectedRepository = worktreeRepoPath ? repositoryByPath.get(worktreeRepoPath) : null;
  const selectedRemoteStatus = selectedRepository?.connectionId
    ? (remoteStatuses[selectedRepository.connectionId] ?? null)
    : null;
  const selectedRemoteReady =
    !selectedRepository?.connectionId ||
    !isRemoteRepoPath(worktreeRepoPath) ||
    selectedRemoteStatus?.connected !== false ||
    selectedRemoteStatus == null;
  const worktreeQueryEnabled = Boolean(worktreeRepoPath && selectedRepoCanLoad && isGitRepo);
  const inactiveSelectedRemoteRepo = Boolean(
    worktreeRepoPath &&
      isRemoteRepoPath(worktreeRepoPath) &&
      (!selectedRepoCanLoad || !selectedRemoteReady)
  );

  // Get worktrees for selected repo (used in columns mode)
  const {
    data: worktrees = [],
    isFetching: worktreesFetching,
    isFetched: worktreesFetched,
    refetch,
  } = useWorktreeList(worktreeRepoPath, {
    enabled: worktreeQueryEnabled,
  });

  // Get branches for selected repo
  const { data: branches = [], refetch: refetchBranches } = useGitBranches(worktreeRepoPath, {
    enabled: worktreeQueryEnabled,
  });

  // Worktree mutations

  // Merge mutations
  const mergeMutation = useWorktreeMerge();
  const resolveConflictMutation = useWorktreeResolveConflict();
  const abortMergeMutation = useWorktreeMergeAbort();
  const continueMergeMutation = useWorktreeMergeContinue();

  useEffect(() => {
    rehydrateTempWorkspaces();
  }, [rehydrateTempWorkspaces]);

  useEffect(() => {
    if (!inactiveSelectedRemoteRepo) {
      return;
    }
    setWorktreeError(null);
  }, [inactiveSelectedRemoteRepo, setWorktreeError]);

  useEffect(() => {
    if (!selectedRepo || selectedRepo === TEMP_REPO_ID) {
      return;
    }
    if (selectedRepoCanLoad || !activeWorktree) {
      return;
    }
    setActiveWorktree(null);
  }, [selectedRepo, selectedRepoCanLoad, activeWorktree, setActiveWorktree]);

  useEffect(() => {
    if (!selectedRepo) return;
    if (selectedRepo === TEMP_REPO_ID) return;

    const oldWorktreePath = localStorage.getItem(STORAGE_KEYS.ACTIVE_WORKTREE);
    const savedWorktreeMap = getStoredWorktreeMap();
    const needsMigration = oldWorktreePath && !savedWorktreeMap[selectedRepo];

    if (needsMigration && oldWorktreePath) {
      const migrated = {
        ...savedWorktreeMap,
        [selectedRepo]: oldWorktreePath,
      };
      localStorage.setItem(STORAGE_KEYS.ACTIVE_WORKTREES, JSON.stringify(migrated));
      setRepoWorktreeMap(migrated);
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_WORKTREE);
    }

    if (!selectedRepoCanLoad) return;

    if (!activeWorktree) {
      const savedWorktreePath = repoWorktreeMap[selectedRepo];
      if (!savedWorktreePath) return;
      if (!worktreesFetched) return;
      if (worktreesFetching) return;

      const matchedWorktree = worktrees.find((wt) => wt.path === savedWorktreePath);
      if (matchedWorktree) {
        setActiveWorktree(matchedWorktree);
        return;
      }

      // Remove stale saved mapping to avoid restore<->sync loops.
      setRepoWorktreeMap((prev) => {
        if (!prev[selectedRepo]) return prev;
        const updated = { ...prev };
        delete updated[selectedRepo];
        localStorage.setItem(STORAGE_KEYS.ACTIVE_WORKTREES, JSON.stringify(updated));
        return updated;
      });
    }
  }, [
    selectedRepo,
    activeWorktree,
    repoWorktreeMap,
    selectedRepoCanLoad,
    worktrees,
    worktreesFetched,
    worktreesFetching,
    setRepoWorktreeMap,
    setActiveWorktree,
  ]);

  // Gate on `hydrated` (not a literal `true`): before hydration finishes, this
  // effect would close over the pre-hydration `repositories === []`, and
  // `saveRepositories([...[], newRepo])` would wipe out existing repos.
  useOpenPathListener(hydrated, repositories, saveRepositories, setSelectedRepoState);
  useWorktreeSync(worktrees, activeWorktree, worktreesFetching, setActiveWorktree, selectedRepo);

  // Remove repository from workspace
  const handleRemoveRepository = useCallback(
    (repoPath: string) => {
      const updated = repositories.filter((r) => r.path !== repoPath);
      saveRepositories(updated);
      setActivatedRemoteRepos((prev) => {
        if (!prev.has(repoPath)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(repoPath);
        return next;
      });
      // Clear selection if removed repo was selected
      if (selectedRepo === repoPath) {
        setSelectedRepoState(null);
        setActiveWorktree(null);
      }
    },
    [repositories, saveRepositories, selectedRepo, setActiveWorktree, setSelectedRepoState]
  );

  useEffect(() => {
    if (!selectedRepo || selectedRepo === TEMP_REPO_ID) return;
    if (!selectedRepoCanLoad) return;
    if (!worktreesFetched) return;
    if (worktreesFetching) return;

    if (!activeWorktree) {
      saveActiveWorktreeToMap(selectedRepo, null);
      return;
    }

    const isWorktreeInSelectedRepo = worktrees.some((wt) => wt.path === activeWorktree.path);
    if (isWorktreeInSelectedRepo) {
      saveActiveWorktreeToMap(selectedRepo, activeWorktree);
    }
  }, [
    selectedRepo,
    activeWorktree,
    selectedRepoCanLoad,
    worktrees,
    worktreesFetched,
    worktreesFetching,
    saveActiveWorktreeToMap,
  ]);

  const handleSelectRepo = useCallback(
    (repoPath: string, options?: { activateRemote?: boolean }) => {
      // Save current worktree's tab state before switching
      if (activeWorktree?.path) {
        setWorktreeTabMap((prev) => ({
          ...prev,
          [activeWorktree.path]: activeTab,
        }));
      }

      const shouldActivateRemote = (options?.activateRemote ?? false) && isRemoteRepoPath(repoPath);
      if (shouldActivateRemote) {
        activateRemoteRepo(repoPath);
      }

      const nextRepoCanLoad =
        repoPath !== TEMP_REPO_ID &&
        (!isRemoteRepoPath(repoPath) || shouldActivateRemote || activatedRemoteRepos.has(repoPath));

      setSelectedRepoState(repoPath);

      if (!nextRepoCanLoad) {
        setActiveWorktree(null);
        setActiveTab('chat');
        return;
      }

      const savedWorktreePath = repoWorktreeMap[repoPath];
      if (savedWorktreePath) {
        setActiveWorktree(createPlaceholderWorktree(savedWorktreePath));
        const savedTab = worktreeTabMap[savedWorktreePath] || 'chat';
        setActiveTab(savedTab);
        return;
      }

      setActiveWorktree(null);
      setActiveTab('chat');
    },
    [
      activeTab,
      activeWorktree,

      activateRemoteRepo,
      activatedRemoteRepos,
      isRemoteRepoPath,
      repoWorktreeMap,
      setActiveTab,
      setActiveWorktree,
      setSelectedRepoState,
      setWorktreeTabMap,
      worktreeTabMap,
    ]
  );

  const handleSelectTempWorkspace = useCallback(
    async (path: string) => {
      await handleSelectWorktree({ path } as GitWorktree, TEMP_REPO_ID);
    },
    [handleSelectWorktree]
  );

  const closeAgentSessions = useWorktreeActivityStore((s) => s.closeAgentSessions);
  const closeTerminalSessions = useWorktreeActivityStore((s) => s.closeTerminalSessions);
  const clearWorktreeActivity = useWorktreeActivityStore((s) => s.clearWorktree);

  const handleRemoveTempWorkspace = useCallback(
    async (id: string) => {
      const target = tempWorkspaces.find((item) => item.id === id);
      if (!target) return;

      const toastId = toastManager.add({
        type: 'loading',
        title: t('Deleting...'),
        description: target.title,
        timeout: 0,
      });

      closeAgentSessions(target.path);
      closeTerminalSessions(target.path);

      const result = await window.electronAPI.tempWorkspace.remove(
        target.path,
        effectiveTempBasePath
      );
      if (!result.ok) {
        toastManager.close(toastId);
        toastManager.add({
          type: 'error',
          title: t('Delete failed'),
          description: result.message || t('Failed to delete temp session'),
        });
        return;
      }

      removeTempWorkspace(id);
      clearEditorWorktreeState(target.path);
      clearWorktreeActivity(target.path);

      if (activeWorktree?.path === target.path) {
        const remaining = tempWorkspaces.filter((item) => item.id !== id);
        if (remaining.length > 0) {
          await handleSelectTempWorkspace(remaining[0].path);
        } else {
          setActiveWorktree(null);
        }
      }

      toastManager.close(toastId);
      toastManager.add({
        type: 'success',
        title: t('Temp Session deleted'),
        description: target.title,
      });
    },
    [
      activeWorktree?.path,
      clearEditorWorktreeState,
      closeAgentSessions,
      closeTerminalSessions,
      clearWorktreeActivity,
      handleSelectTempWorkspace,
      removeTempWorkspace,
      tempWorkspaces,
      t,
      effectiveTempBasePath,
      setActiveWorktree,
    ]
  );

  const handleSwitchWorktreePath = useCallback(
    async (worktreePath: string) => {
      const tempMatch = tempWorkspaces.find((item) => item.path === worktreePath);
      if (tempMatch) {
        await handleSelectWorktree({ path: tempMatch.path } as GitWorktree, TEMP_REPO_ID);
        return;
      }

      const worktree = worktrees.find((wt) => wt.path === worktreePath);
      if (worktree) {
        handleSelectWorktree(worktree);
        return;
      }

      for (const repo of repositories) {
        if (isRemoteRepoPath(repo.path) && !canLoadRepo(repo.path)) {
          continue;
        }

        try {
          const repoWorktrees = await window.electronAPI.worktree.list(repo.path);
          const found = repoWorktrees.find((wt) => wt.path === worktreePath);
          if (found) {
            setSelectedRepoForWorktreeSelection(repo.path);
            setActiveWorktree(found);
            const savedTab = worktreeTabMap[found.path] || 'chat';
            setActiveTab(savedTab);

            // Refresh git data for the switched worktree
            refreshGitData(found.path);
            return;
          }
        } catch {}
      }
    },
    [
      tempWorkspaces,

      worktrees,
      repositories,
      isRemoteRepoPath,
      canLoadRepo,
      worktreeTabMap,
      handleSelectWorktree,
      refreshGitData,
      setActiveTab,
      setActiveWorktree,
      setSelectedRepoForWorktreeSelection,
    ]
  );

  // Assign to ref for use in keyboard shortcut callback
  switchWorktreePathRef.current = handleSwitchWorktreePath;

  // Handle adding a local repository
  const createRepositoryEntry = useCallback(
    (
      repoPath: string,
      groupId: string | null,
      options?: { kind?: 'local' | 'remote'; connectionId?: string }
    ): Repository => ({
      id: buildRepositoryId(options?.kind ?? 'local', repoPath, {
        connectionId: options?.connectionId,
        platform:
          window.electronAPI.env.platform === 'win32'
            ? 'win32'
            : window.electronAPI.env.platform === 'darwin'
              ? 'darwin'
              : 'linux',
      }),
      name: getDisplayPathBasename(repoPath),
      path: repoPath,
      kind: options?.kind ?? 'local',
      connectionId: options?.connectionId,
      groupId: groupId || undefined,
    }),
    []
  );

  const findExistingRepository = useCallback(
    (candidate: Repository) =>
      repositories.find(
        (repo) => repo.id === candidate.id || pathsEqual(repo.path, candidate.path)
      ),
    [repositories]
  );

  const handleAddLocalRepository = useCallback(
    (selectedPath: string, groupId: string | null) => {
      const candidate = createRepositoryEntry(selectedPath, groupId);
      const existingRepo = findExistingRepository(candidate);
      if (existingRepo) {
        handleSelectRepo(existingRepo.path);
        return;
      }

      const updated = [...repositories, candidate];
      saveRepositories(updated);

      handleSelectRepo(candidate.path);
    },
    [
      createRepositoryEntry,
      findExistingRepository,
      handleSelectRepo,
      repositories,
      saveRepositories,
    ]
  );

  // Handle cloning a remote repository
  const handleCloneRepository = useCallback(
    (clonedPath: string, groupId: string | null) => {
      const candidate = createRepositoryEntry(clonedPath, groupId);
      const existingRepo = findExistingRepository(candidate);
      if (existingRepo) {
        handleSelectRepo(existingRepo.path);
        return;
      }

      const updated = [...repositories, candidate];
      saveRepositories(updated);

      handleSelectRepo(candidate.path);
    },
    [
      createRepositoryEntry,
      findExistingRepository,
      handleSelectRepo,
      repositories,
      saveRepositories,
    ]
  );

  const handleAddRemoteRepository = useCallback(
    async (remoteRepoPath: string, groupId: string | null, connectionId: string) => {
      const candidate = createRepositoryEntry(
        toRemoteVirtualPath(connectionId, remoteRepoPath),
        groupId,
        {
          kind: 'remote',
          connectionId,
        }
      );
      const existingRepo = findExistingRepository(candidate);
      if (existingRepo) {
        handleSelectRepo(existingRepo.path);
        return;
      }

      const updated = [...repositories, candidate];
      saveRepositories(updated);
      handleSelectRepo(candidate.path);
    },
    [
      createRepositoryEntry,
      findExistingRepository,
      handleSelectRepo,
      repositories,
      saveRepositories,
    ]
  );

  const handleOpenRepositoryDialog = useCallback(
    (mode?: 'local' | 'remote' | 'ssh') => {
      // Callers that bind this directly as a DOM handler (e.g. LeftNav's
      // `onClick={onAddRepository}`) invoke it with the click SyntheticEvent
      // as the first arg — only accept real mode strings, everything else
      // (including "no arg") falls back to the dialog's default tab.
      setAddRepoInitialMode(typeof mode === 'string' ? mode : undefined);
      setAddRepoDialogOpen(true);
    },
    [setAddRepoDialogOpen, setAddRepoInitialMode]
  );

  const handleAddRepoDialogOpenChange = useCallback(
    (open: boolean) => {
      setAddRepoDialogOpen(open);
    },
    [setAddRepoDialogOpen]
  );

  const handleMerge = async (options: WorktreeMergeOptions): Promise<WorktreeMergeResult> => {
    if (!selectedRepo) {
      return { success: false, merged: false, error: 'No repository selected' };
    }
    return mergeMutation.mutateAsync({ workdir: selectedRepo, options });
  };

  const handleMergeConflicts = (result: WorktreeMergeResult, options: WorktreeMergeOptions) => {
    setMergeDialogOpen(false); // Close merge dialog first
    setMergeConflicts(result);
    // Store the merge options for cleanup after conflict resolution
    setPendingMergeOptions({
      worktreePath: options.worktreePath,
      sourceBranch: mergeWorktree?.branch || '',
      deleteWorktreeAfterMerge: options.deleteWorktreeAfterMerge,
      deleteBranchAfterMerge: options.deleteBranchAfterMerge,
    });

    // Notify user if changes were stashed, with specific paths
    const stashedPaths: string[] = [];
    if (result.mainStashStatus === 'stashed' && result.mainWorktreePath) {
      stashedPaths.push(result.mainWorktreePath);
    }
    if (result.worktreeStashStatus === 'stashed' && result.worktreePath) {
      stashedPaths.push(result.worktreePath);
    }
    if (stashedPaths.length > 0) {
      toastManager.add({
        type: 'info',
        title: t('Changes stashed'),
        description:
          t(
            'Your uncommitted changes were stashed. After resolving conflicts, run "git stash pop" in:'
          ) +
          '\n' +
          stashedPaths.join('\n'),
      });
    }
  };

  const handleResolveConflict = async (file: string, content: string) => {
    if (!selectedRepo) return;
    await resolveConflictMutation.mutateAsync({
      workdir: selectedRepo,
      resolution: { file, content },
    });
  };

  const handleAbortMerge = async () => {
    if (!selectedRepo) return;
    await abortMergeMutation.mutateAsync({ workdir: selectedRepo });
    setMergeConflicts(null);
    setPendingMergeOptions(null);
    refetch();
  };

  const handleCompleteMerge = async (message: string) => {
    if (!selectedRepo) return;
    const result = await continueMergeMutation.mutateAsync({
      workdir: selectedRepo,
      message,
      cleanupOptions: pendingMergeOptions || undefined,
    });
    if (result.success) {
      // Show warnings if any (combined into a single toast)
      if (result.warnings && result.warnings.length > 0) {
        addToast({
          type: 'warning',
          title: t('Merge completed with warnings'),
          description: result.warnings.join('\n'),
        });
      }
      setMergeConflicts(null);
      setPendingMergeOptions(null);
      refetch();
      refetchBranches();
    }
  };

  const getConflictContent = async (file: string) => {
    if (!selectedRepo) throw new Error('No repository selected');
    return window.electronAPI.worktree.getConflictContent(selectedRepo, file);
  };

  useBackgroundImage();

  return (
    <div className="relative z-0 flex h-screen flex-col overflow-hidden">
      <BackgroundLayer />
      {/* Custom Title Bar for Windows/Linux */}
      <WindowTitleBar />

      {/* DevTools Overlay for macOS traffic lights protection */}
      <DevToolsOverlay />

      {/* Main Layout */}
      <div className="relative flex flex-1 overflow-hidden">
        <WorkspaceShell
          onOpenSettings={openSettings}
          repositories={repositories}
          selectedRepoPath={selectedRepo}
          onAddRepository={handleOpenRepositoryDialog}
          onRemoveRepository={handleRemoveRepository}
          dropZoneRef={repositorySidebarRef}
          fileDragOver={isFileDragOver}
          tempWorkspaces={tempWorkspaces}
          onRequestTempDelete={openTempDelete}
        />

        <TempWorkspaceDialogs
          onConfirmDelete={handleRemoveTempWorkspace}
          onConfirmRename={renameTempWorkspace}
        />

        {/* Add Repository Dialog */}
        <AddRepositoryDialog
          open={addRepoDialogOpen}
          onOpenChange={handleAddRepoDialogOpenChange}
          onAddLocal={handleAddLocalRepository}
          onCloneComplete={handleCloneRepository}
          onAddRemote={handleAddRemoteRepository}
          initialLocalPath={initialLocalPath ?? undefined}
          onClearInitialLocalPath={() => setInitialLocalPath(null)}
          initialMode={addRepoInitialMode}
        />

        {/* Update Notification */}
        <UpdateNotification />

        {/* A3/D65 — git is a real dependency of a worktree manager, so the check
            survives the onboarding probes that were retired; it just no longer
            blocks the way in. */}
        <GitMissingNotice />

        {/* Unsaved Prompt Host */}
        <UnsavedPromptHost />

        {/* Remote SSH Auth Prompt Host */}
        <RemoteAuthPromptHost />

        {/* Close Confirmation Dialog */}
        <Dialog
          open={closeDialogOpen}
          onOpenChange={(open) => {
            setCloseDialogOpen(open);
            if (!open) {
              cancelCloseAndRespond();
            }
          }}
        >
          <DialogPopup className="sm:max-w-sm" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{t('Confirm exit')}</DialogTitle>
              <DialogDescription>{t('Are you sure you want to exit the app?')}</DialogDescription>
            </DialogHeader>
            <DialogFooter variant="bare">
              <Button
                variant="outline"
                onClick={() => {
                  setCloseDialogOpen(false);
                  cancelCloseAndRespond();
                }}
              >
                {t('Cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setCloseDialogOpen(false);
                  confirmCloseAndRespond();
                }}
              >
                {t('Exit')}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>

        {/* Merge Worktree Dialog */}
        {mergeWorktree && (
          <MergeWorktreeDialog
            open={mergeDialogOpen}
            onOpenChange={setMergeDialogOpen}
            worktree={mergeWorktree}
            branches={branches}
            isLoading={mergeMutation.isPending}
            onMerge={handleMerge}
            onConflicts={handleMergeConflicts}
            onSuccess={({ deletedWorktree }) => {
              if (deletedWorktree && mergeWorktree) {
                clearEditorWorktreeState(mergeWorktree.path);
                if (activeWorktree?.path === mergeWorktree.path) {
                  setActiveWorktree(null);
                }
              }
              refetch();
              refetchBranches();
            }}
          />
        )}

        {/* Merge Conflict Editor */}
        {mergeConflicts?.conflicts && mergeConflicts.conflicts.length > 0 && (
          <Dialog open={true} onOpenChange={() => {}}>
            <DialogPopup className="h-[90vh] max-w-[95vw] p-0" showCloseButton={false}>
              <MergeEditor
                conflicts={mergeConflicts.conflicts}
                workdir={selectedRepo || ''}
                sourceBranch={mergeWorktree?.branch || undefined}
                onResolve={handleResolveConflict}
                onComplete={handleCompleteMerge}
                onAbort={handleAbortMerge}
                getConflictContent={getConflictContent}
              />
            </DialogPopup>
          </Dialog>
        )}

        {/* Clone Progress Float - shows clone progress in bottom right corner */}
        <CloneProgressFloat onCloneComplete={handleCloneRepository} />

        {/* Settings shared by the menu, dock and slash command. */}
        <SettingsDialog
          open={settingsDialogOpen}
          onOpenChange={setSettingsDialogOpen}
          activeCategory={settingsCategory}
          onCategoryChange={handleSettingsCategoryChange}
          repoPath={selectedRepo ?? undefined}
        />
      </div>
    </div>
  );
}
