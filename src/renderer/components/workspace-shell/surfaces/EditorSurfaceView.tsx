/**
 * T-13: the editor surface — `FileTree` + `EditorArea` wired onto the context
 * panel via the EXISTING `useFileTree`/`useEditor` hooks (zero changes to
 * either, #12 freeze). See:
 * - `editorSurfaceLayout.ts` for the width-driven tree/editor layout.
 * - `resolveIntentPath.ts` / `fileIntentToCursor.ts` for turning a
 *   `fileOpenIntent` request into a `navigateToFile` call.
 *
 * Workspace resolution mirrors `useGitChangeCount.ts` (activeSession →
 * workspace → path) rather than building a dedicated resolver file — spec §3
 * names that hook as the pattern to follow, unlike T-12/T-15's own
 * `resolveGitWorkdir`/`resolveTerminalWorkspace`.
 */

import { normalizePath } from '@shared/utils/path';
import { AlertTriangle, FileCode, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorArea } from '@/components/files/EditorArea';
import { FileTree } from '@/components/files/FileTree';
import { NewItemDialog } from '@/components/files/NewItemDialog';
import type { UnsavedChangesChoice } from '@/components/files/UnsavedChangesDialog';
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { toastManager } from '@/components/ui/toast';
import { useEditor } from '@/hooks/useEditor';
import { useFileTree } from '@/hooks/useFileTree';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useEditorStore } from '@/stores/editor';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useSettingsStore } from '@/stores/settings';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { requestUnsavedChoice } from '@/stores/unsavedPrompt';
import { SURFACE_ESCAPE_HOLD_ATTR } from '../shellLayoutModel';
import type { SurfaceViewProps } from '../surfaceViews';
import { EDITOR_TREE_WIDTH, resolveEditorSurfaceLayout } from './editorSurfaceLayout';
import { decideUnsavedCloseAction, shouldPromptUnsavedClose } from './editorTabCloseDecision';
import { fileIntentToCursor } from './fileIntentToCursor';
import { isAbsoluteIntentPath, resolveIntentPath } from './resolveIntentPath';

/** New-shell-local preference, distinct from the old shell's own key — not a new store field. */
const TREE_COLLAPSED_STORAGE_KEY = 'aiclient-editor-surface-tree-collapsed';

/** Computed key so a rename of the constant cannot leave a dead attribute behind. */
const ESCAPE_HOLD_PROPS = { [SURFACE_ESCAPE_HOLD_ATTR]: '' };

type NewItemType = 'file' | 'directory' | null;

function EditorEmptyState({ description }: { description: string }) {
  const { t } = useI18n();
  return (
    <Empty className="h-full gap-3 border-0 p-2 md:p-2">
      <EmptyMedia variant="icon">
        <FileCode className="h-4.5 w-4.5" />
      </EmptyMedia>
      <EmptyHeader>
        {/* D25 §3.3: cancel EmptyTitle's 18px-sized negative tracking when
            overriding to 14px, same as SurfacePlaceholder/other surfaces. */}
        <EmptyTitle className="text-ui tracking-normal">{t('Editor')}</EmptyTitle>
        <EmptyDescription className="text-meta">{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function EditorSurfaceView({ surfaceId }: SurfaceViewProps) {
  const { t } = useI18n();

  // Workspace resolution (useGitChangeCount.ts pattern, spec §3).
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  const rootPath = activeWorkspace?.path || null;

  const activeSurfaceId = useShellLayoutStore((state) => state.activeSurfaceId);
  const surfaceActive = activeSurfaceId === surfaceId;

  const editorAutoSave = useSettingsStore((state) => state.editorSettings.autoSave);

  // Per-Workspace tab isolation (spec §3): `switchWorktree` currently has NO
  // caller anywhere in the renderer (only the old shell's `useWorktreeSelection`
  // wires it, off a different worktree concept) — this effect is what makes the
  // new shell stop leaking one workspace's open tabs into the next.
  useEffect(() => {
    useEditorStore.getState().switchWorktree(rootPath ? normalizePath(rootPath) : null);
  }, [rootPath]);

  const {
    tree,
    isLoading: isTreeLoading,
    expandedPaths,
    toggleExpand,
    createFile,
    createDirectory,
    renameItem,
    deleteItem,
    refresh,
  } = useFileTree({
    rootPath: rootPath ?? undefined,
    enabled: !!rootPath,
    isActive: surfaceActive,
  });

  const {
    tabs,
    activeTab,
    pendingCursor,
    navigateToFile,
    closeFile,
    setActiveFile,
    updateFileContent,
    setTabViewState,
    reorderTabs,
    setPendingCursor,
    saveFile,
    refreshFileContent,
  } = useEditor();

  // ── tree visibility toggle (existing EditorArea seam) ──────────────────
  const [treeCollapsed, setTreeCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(TREE_COLLAPSED_STORAGE_KEY) === 'true';
  });
  useEffect(() => {
    window.localStorage.setItem(TREE_COLLAPSED_STORAGE_KEY, String(treeCollapsed));
  }, [treeCollapsed]);
  const handleToggleFileTree = useCallback(() => setTreeCollapsed((prev) => !prev), []);

  // ── self-measured panel width (no new store field) ─────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setPanelWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = resolveEditorSurfaceLayout({
    panelWidth,
    hasOpenTab: tabs.length > 0,
    treeRequested: !treeCollapsed,
  });

  // ── fileOpenIntent consumption (spec §3) ────────────────────────────────
  const intent = useFileOpenIntentStore((state) => state.intent);
  const [intentNotice, setIntentNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!intent) return;

    const needsWorkspace = !isAbsoluteIntentPath(normalizePath(intent.path));
    if (needsWorkspace && rootPath === null) {
      // Workspace not resolved YET — do not ack. This effect re-fires the
      // moment `rootPath` changes, so a genuinely-relative intent that
      // arrived before the workspace was ready gets retried instead of
      // failing (an absolute-path intent never hits this branch).
      return;
    }

    let cancelled = false;
    const requestId = intent.requestId;
    const rawPath = intent.path;

    const resolved = resolveIntentPath(rawPath, rootPath);
    if (!resolved) {
      setIntentNotice(
        t('Could not open "{{path}}" — the path is outside the workspace.', { path: rawPath })
      );
      useFileOpenIntentStore.getState().ackFileOpen(requestId);
      return;
    }

    const cursor = fileIntentToCursor(intent);
    setIntentNotice(null);

    void navigateToFile(resolved, cursor?.line, cursor?.column, cursor?.matchLength).then(() => {
      if (cancelled) return;
      // `navigateToFile` swallows its own read failure (returns silently on
      // both success and error) — checking the store directly is how this
      // effect tells them apart without touching that frozen call chain.
      const opened = useEditorStore.getState().tabs.some((tab) => tab.path === resolved);
      if (!opened) {
        setIntentNotice(t('Could not open "{{path}}".', { path: rawPath }));
      }
      useFileOpenIntentStore.getState().ackFileOpen(requestId);
    });

    return () => {
      cancelled = true;
    };
  }, [intent, rootPath, navigateToFile, t]);

  // ── file tree CRUD plumbing (FileTree's props are non-optional) ────────
  const [newItemType, setNewItemType] = useState<NewItemType>(null);
  const [newItemParentPath, setNewItemParentPath] = useState('');

  const handleCreateFile = useCallback((parentPath: string) => {
    setNewItemType('file');
    setNewItemParentPath(parentPath);
  }, []);

  const handleCreateDirectory = useCallback((parentPath: string) => {
    setNewItemType('directory');
    setNewItemParentPath(parentPath);
  }, []);

  const handleNewItemConfirm = useCallback(
    async (name: string) => {
      const fullPath = `${newItemParentPath}/${name}`;
      if (newItemType === 'file') {
        await createFile(fullPath);
      } else if (newItemType === 'directory') {
        await createDirectory(fullPath);
      }
      setNewItemType(null);
      setNewItemParentPath('');
    },
    [newItemType, newItemParentPath, createFile, createDirectory]
  );

  const handleDelete = useCallback(
    async (path: string) => {
      if (!window.confirm(`Delete "${path.split('/').pop()}"?`)) return;
      await deleteItem(path);
      closeFile(path);
    },
    [deleteItem, closeFile]
  );

  // Spec §3: "onFileClick → navigateToFile" — navigateToFile already handles
  // both branches (existing tab → activate + background refresh, new path →
  // open), so the tree click handler does not need to re-derive them.
  const handleFileClick = useCallback(
    (path: string) => {
      navigateToFile(path);
    },
    [navigateToFile]
  );

  const handleTabClick = useCallback(
    (path: string) => {
      setActiveFile(path);
      refreshFileContent(path);
    },
    [setActiveFile, refreshFileContent]
  );

  // Coordinator ruling (post-review): a dirty tab must go through the SAME
  // unsaved-changes confirmation the old shell's `FilePanel.tsx` uses
  // (`requestUnsavedChoice` → the existing `UnsavedChangesDialog`, hosted by
  // `UnsavedPromptHost` which `App.tsx` already mounts unconditionally,
  // outside the old-shell/new-shell branch — nothing new to mount here).
  // Silently discarding edits on close is a real data-loss regression, not
  // an acceptable scope cut.
  const handleTabClose = useCallback(
    async (path: string) => {
      const tab = tabs.find((item) => item.path === path);
      const prompt = shouldPromptUnsavedClose({
        isDirty: tab?.isDirty ?? false,
        autoSave: editorAutoSave,
      });

      let choice: UnsavedChangesChoice = 'dontSave';
      if (prompt) {
        const fileName = path.split(/[/\\]/).pop() ?? path;
        choice = await requestUnsavedChoice(fileName);
      }

      const action = decideUnsavedCloseAction(choice);
      if (action === 'cancel') return;

      if (action === 'save-then-close') {
        try {
          await saveFile.mutateAsync(path);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toastManager.add({ type: 'error', title: t('Save failed'), description: message });
          return;
        }
      }

      closeFile(path);
    },
    [tabs, editorAutoSave, saveFile, closeFile, t]
  );

  const handleSave = useCallback((path: string) => saveFile.mutate(path), [saveFile]);

  const handleClearPendingCursor = useCallback(() => setPendingCursor(null), [setPendingCursor]);

  if (!rootPath) {
    return <EditorEmptyState description={t('Select a Workspace to browse files')} />;
  }

  const showTree = layout === 'tree-only' || layout === 'split';
  const showEditor = layout === 'editor-only' || layout === 'split';

  return (
    <div ref={containerRef} className="flex h-full min-h-0 min-w-0 flex-col">
      {intentNotice && (
        <Alert variant="warning" className="m-1 items-center gap-x-2 px-2 py-1 text-meta">
          <AlertTriangle />
          <AlertTitle className="min-w-0 truncate font-normal" title={intentNotice}>
            {intentNotice}
          </AlertTitle>
          <AlertAction>
            <button
              type="button"
              onClick={() => setIntentNotice(null)}
              aria-label={t('Dismiss notice')}
              className="flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/50 hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </AlertAction>
        </Alert>
      )}
      <div className="flex min-h-0 flex-1">
        {showTree && (
          <div
            className={cn(
              'h-full min-h-0 shrink-0 overflow-hidden',
              layout === 'split' ? 'border-r' : 'w-full'
            )}
            style={layout === 'split' ? { width: EDITOR_TREE_WIDTH } : undefined}
          >
            <FileTree
              tree={tree}
              expandedPaths={expandedPaths}
              onToggleExpand={toggleExpand}
              onFileClick={handleFileClick}
              onCreateFile={handleCreateFile}
              onCreateDirectory={handleCreateDirectory}
              onRename={renameItem}
              onDelete={handleDelete}
              onRefresh={refresh}
              isLoading={isTreeLoading}
              rootPath={rootPath}
            />
          </div>
        )}
        {showEditor && (
          <div className="h-full min-h-0 min-w-0 flex-1" {...ESCAPE_HOLD_PROPS}>
            <EditorArea
              tabs={tabs}
              activeTab={activeTab}
              activeTabPath={activeTab?.path ?? null}
              pendingCursor={pendingCursor}
              rootPath={rootPath}
              onTabClick={handleTabClick}
              onTabClose={handleTabClose}
              onNavigateToFile={navigateToFile}
              onTabReorder={reorderTabs}
              onContentChange={updateFileContent}
              onViewStateChange={setTabViewState}
              onSave={handleSave}
              onClearPendingCursor={handleClearPendingCursor}
              isFileTreeCollapsed={treeCollapsed}
              onToggleFileTree={handleToggleFileTree}
            />
          </div>
        )}
      </div>
      <NewItemDialog
        isOpen={newItemType !== null}
        type={newItemType || 'file'}
        onConfirm={(name) => void handleNewItemConfirm(name)}
        onCancel={() => {
          setNewItemType(null);
          setNewItemParentPath('');
        }}
      />
    </div>
  );
}
