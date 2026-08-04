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

/**
 * Gate for a fileOpenIntent, evaluated once per effect run (adversarial
 * review m12 + the pre-existing relative-path wait):
 * - `'wait'`: a relative intent arrived before any workspace resolved — the
 *   effect re-fires the moment `rootPath` changes, so this retries instead
 *   of failing (no ack).
 * - `'blocked'`: no workspace at all. A relative intent cannot be resolved
 *   without one; an absolute intent COULD resolve, but the surface renders
 *   the "Select a Workspace" empty state whenever `rootPath` is null, so a
 *   tab opened here would land in the store with nothing on screen to show
 *   it. Both fail definitively (ack, no retry) instead of leaving the
 *   request to replay forever or stash an invisible tab.
 * - `'proceed'`: resolve and navigate.
 */
export function gateFileOpenIntent(
  pathIsAbsolute: boolean,
  rootPath: string | null
): 'wait' | 'blocked' | 'proceed' {
  if (rootPath !== null) {
    return 'proceed';
  }
  return pathIsAbsolute ? 'blocked' : 'wait';
}

/**
 * Live re-derivation of the same `activeSession → workspace → path` chain
 * the component computes at render time (spec §3, `useGitChangeCount.ts`
 * pattern) — used by the `stillValid` guard below so a workspace switch is
 * caught even if it happens in the gap between this effect's last render and
 * an in-flight `navigateToFile` read resolving, without depending on React
 * having already re-rendered/cleaned up this effect instance.
 */
function resolveLiveWorkspaceRootPath(): string | null {
  const state = useChatSessionsStore.getState();
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
  const activeWorkspace = state.workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  return activeWorkspace?.path || null;
}

/**
 * Pure race guard (Codex major, adversarial review batch B): whether an
 * in-flight `navigateToFile` request is still the one that should land its
 * side effects. `false` when either a newer intent has arrived (a different
 * `requestId` now sits in the store) or the active workspace has changed
 * (`liveRootPath` no longer matches what was captured when the request
 * started) — both mean the read's result belongs to a request that no
 * longer represents "what the user is looking at". Exported for direct unit
 * testing without mounting the surface.
 */
export function isNavigationIntentStillValid(params: {
  requestId: number;
  liveIntentRequestId: number | null;
  capturedRootPath: string | null;
  liveRootPath: string | null;
}): boolean {
  return (
    params.liveIntentRequestId === params.requestId &&
    params.liveRootPath === params.capturedRootPath
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

    const requestId = intent.requestId;
    const rawPath = intent.path;
    const pathIsAbsolute = isAbsoluteIntentPath(normalizePath(rawPath));
    const gate = gateFileOpenIntent(pathIsAbsolute, rootPath);

    if (gate === 'wait') {
      // Workspace not resolved YET — do not ack. This effect re-fires the
      // moment `rootPath` changes, so a genuinely-relative intent that
      // arrived before the workspace was ready gets retried instead of
      // failing.
      return;
    }

    if (gate === 'blocked') {
      // m12 (adversarial review): an absolute-path intent CAN resolve with
      // no workspace, but the surface renders the "Select a Workspace" empty
      // state below whenever `rootPath` is null — navigating here would
      // stash a tab in the store that nothing on screen shows. Fail
      // definitively (ack, so the intent does not replay) instead.
      setIntentNotice(t('Select a Workspace to browse files'));
      useFileOpenIntentStore.getState().ackFileOpen(requestId);
      return;
    }

    let cancelled = false;

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

    // Codex major (adversarial review batch B): `cancelled` alone is too
    // late — it is only checked in the `.then()` below, by which point
    // `navigateToFile` has already run `openFile` internally. `stillValid`
    // is instead passed INTO `navigateToFile` so it can veto the side effect
    // right after the read settles. It re-reads the LIVE store state (not
    // the closed-over `rootPath`/`intent` from this render) so it also
    // catches a workspace switch or a newer intent that hasn't triggered a
    // re-render yet.
    const capturedRootPath = rootPath;
    const stillValid = () =>
      isNavigationIntentStillValid({
        requestId,
        liveIntentRequestId: useFileOpenIntentStore.getState().intent?.requestId ?? null,
        capturedRootPath,
        liveRootPath: resolveLiveWorkspaceRootPath(),
      });

    void navigateToFile(resolved, cursor?.line, cursor?.column, cursor?.matchLength, undefined, {
      stillValid,
    }).then(() => {
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
    // M6 (adversarial review): Escape must be held for the WHOLE surface
    // subtree, not just the editor pane — FileTree's rename input lives in
    // the tree pane, and an unheld Escape there closed the entire panel (via
    // ContextPanel's onKeyDownCapture) before the rename's own Escape
    // handler ever ran, silently dropping the in-progress rename.
    <div ref={containerRef} className="flex h-full min-h-0 min-w-0 flex-col" {...ESCAPE_HOLD_PROPS}>
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
          <div className="h-full min-h-0 min-w-0 flex-1">
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
