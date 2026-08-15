/**
 * T-32 (D27 / open-q #28 ①): the editor, back in the CENTER column beside chat
 * (A08 `chat ║ editor`, a08:1208-1241) instead of wedged into the 380px panel.
 *
 * This is the other half of the old `EditorSurfaceView`; the tree half is
 * `../surfaces/FilesSurfaceView.tsx`. Everything that owns editor tabs lives
 * here: per-workspace tab isolation, `fileOpenIntent` consumption, the unsaved
 * close prompt, and A08's editor head actions.
 *
 * Renders nothing when no file is open — `editorOpen` is what the shell reads
 * to decide whether the column exists at all, so "no tabs" must cost no box.
 *
 * D34-E: a git diff can also open a page here (`GitSurfaceView` calling
 * `useEditorStore.getState().openDiffTab`), the same open-mode as a file —
 * it is just another `EditorTab` (with `diffTarget` set) in the same `tabs`
 * array, so this column, `useEditorWorktreeSync`, and `deriveEditorOpen` all
 * need zero changes to carry it. Only `EditorArea`'s body picks a different
 * renderer for it (`DiffViewer` instead of Monaco).
 */

import { normalizePath } from '@shared/utils/path';
import { AlertTriangle, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { EditorArea } from '@/components/files/EditorArea';
import type { UnsavedChangesChoice } from '@/components/files/UnsavedChangesDialog';
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useEditor } from '@/hooks/useEditor';
import { useI18n } from '@/i18n';
import { useEditorStore } from '@/stores/editor';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useSettingsStore } from '@/stores/settings';
import { requestUnsavedChoice } from '@/stores/unsavedPrompt';
import { SURFACE_ESCAPE_HOLD_ATTR } from '../shellLayoutModel';
import {
  decideUnsavedCloseAction,
  shouldPromptUnsavedClose,
} from '../surfaces/editorTabCloseDecision';
import { fileIntentToCursor } from '../surfaces/fileIntentToCursor';
import { isAbsoluteIntentPath, resolveIntentPath } from '../surfaces/resolveIntentPath';
import { readWorkspaceRootPath, useWorkspaceRootPath } from '../useWorkspaceRootPath';

/** Computed key so a rename of the constant cannot leave a dead attribute behind. */
const ESCAPE_HOLD_PROPS = { [SURFACE_ESCAPE_HOLD_ATTR]: '' };

/**
 * Gate for a fileOpenIntent, evaluated once per effect run (T-13 adversarial
 * review m12 + the pre-existing relative-path wait):
 * - `'wait'`: a relative intent arrived before any workspace resolved — the
 *   effect re-fires the moment `rootPath` changes, so this retries instead of
 *   failing (no ack).
 * - `'blocked'`: no workspace at all. A relative intent cannot be resolved
 *   without one; an absolute one COULD, but with no workspace the column has
 *   no honest place to show the file, so both fail definitively (ack, no
 *   retry) instead of stashing an invisible tab.
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
 * Pure race guard (T-13 Codex major): whether an in-flight `navigateToFile`
 * request should still land its side effects. `false` when a newer intent
 * arrived, or the active workspace changed under it. Exported for direct unit
 * testing without mounting the column.
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

// D35 (user feedback, 2026-08-14): retired the column's only prop pair
// (`onHideChat`/`chatVisible`, the "Chat column" head button below) — it took
// no arguments left after that, so the props type goes with it.
export function EditorColumn() {
  const { t } = useI18n();
  const rootPath = useWorkspaceRootPath();
  const editorAutoSave = useSettingsStore((state) => state.editorSettings.autoSave);

  // Per-workspace tab isolation moved OUT of this component in m7 — see
  // `../useEditorWorktreeSync.ts`. Keeping it here deadlocked the column once
  // m6 gated its mount on `editorOpen`: `switchWorktree` clears the tabs, so
  // the first mount erased the very file that caused it.

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

  // ── fileOpenIntent consumption (T-13 spec §3, moved verbatim) ───────────
  const intent = useFileOpenIntentStore((state) => state.intent);
  const [intentNotice, setIntentNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!intent) return;

    const requestId = intent.requestId;
    const rawPath = intent.path;
    const pathIsAbsolute = isAbsoluteIntentPath(normalizePath(rawPath));
    const gate = gateFileOpenIntent(pathIsAbsolute, rootPath);

    if (gate === 'wait') {
      // Workspace not resolved YET — do not ack, so a genuinely-relative
      // intent that arrived early is retried when `rootPath` lands.
      return;
    }

    if (gate === 'blocked') {
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

    // T-13 Codex major: `cancelled` alone is too late — it is only checked in
    // the `.then()`, by which point `navigateToFile` already ran `openFile`
    // internally. `stillValid` is passed INTO `navigateToFile` so it can veto
    // the side effect right after the read settles, reading LIVE store state
    // so it also catches a workspace switch that hasn't re-rendered yet.
    const capturedRootPath = rootPath;
    const stillValid = () =>
      isNavigationIntentStillValid({
        requestId,
        liveIntentRequestId: useFileOpenIntentStore.getState().intent?.requestId ?? null,
        capturedRootPath,
        liveRootPath: readWorkspaceRootPath(),
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

  const handleTabClick = useCallback(
    (path: string) => {
      setActiveFile(path);
      // D34-E: a diff tab's `path` is a `git-diff://` pseudo path, not a real
      // fs location — refreshing it would just be a wasted (harmlessly
      // caught) IPC read. Content freshness for a diff tab comes from
      // `DiffViewer`'s own live query instead.
      const tab = tabs.find((t) => t.path === path);
      if (!tab?.diffTarget) {
        refreshFileContent(path);
      }
    },
    [setActiveFile, refreshFileContent, tabs]
  );

  // T-13 coordinator ruling, unchanged: a dirty tab goes through the SAME
  // unsaved-changes confirmation the old shell uses. Silently discarding edits
  // on close is a data-loss regression, not an acceptable scope cut.
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

  // A08's「关闭文件」head button closes the ACTIVE tab, through the same
  // unsaved-changes path as the tab strip's own ✕ — two ways to close, one
  // guarantee about unsaved work.
  const handleCloseActive = useCallback(() => {
    if (activeTab) {
      void handleTabClose(activeTab.path);
    }
  }, [activeTab, handleTabClose]);

  // "No tabs" must cost no box: the shell keys the whole column off this.
  if (tabs.length === 0 || !rootPath) {
    return null;
  }

  return (
    // Escape is held for the whole column: Monaco's find widget and suggest
    // popup own their own Escape, and the panel's capture-phase handler would
    // otherwise eat it (S0 / F-c).
    <div
      className="flex h-full min-h-0 min-w-0 flex-col border-l"
      {...ESCAPE_HOLD_PROPS}
      data-testid="editor-column"
    >
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
      <div className="min-h-0 flex-1">
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
          headerActions={
            // A08 editor head (a08:1224-1227) originally paired hide-chat +
            // close-file here. D35 (user feedback, 2026-08-14, 「折叠按钮太多
            // 搞得人懵」) retires the hide-chat half: its only effect —
            // temporarily showing chat at full width — is already reachable
            // by closing the open tab(s) (`deriveEditorOpen` keys `editorOpen`
            // off `tabs.length`, and `WorkspaceShell`'s
            // `!editorOpen && ... clearManualOverrides()` effect resets
            // `manualChat` to `null` the moment the column has none, which
            // `resolveShellChrome` reads back as `chatVisible: true` by
            // default) — so the dedicated button was a second control for a
            // state already one click away via any tab's ✕ or its context
            // menu's "Close All Tabs". `headerActions` remains an optional
            // additive prop — EditorArea's other hosts pass nothing and
            // render exactly as before (same discipline as T-12's DiffViewer
            // prop).
            <div className="flex shrink-0 items-center gap-0.5 pr-1">
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-6 w-6"
                onClick={handleCloseActive}
                aria-label={t('Close file')}
                title={t('Close file')}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          }
        />
      </div>
    </div>
  );
}
