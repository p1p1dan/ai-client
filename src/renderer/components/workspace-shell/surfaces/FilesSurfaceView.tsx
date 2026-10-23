/**
 * T-32 (D27 / open-q #28 ①): the Files surface — the file TREE only.
 *
 * This is one half of the old `EditorSurfaceView`: A08 puts the editor in the
 * center column beside chat and keeps the panel's `files` tab as a plain tree
 * whose click "打开中列 editor（不再开 panel 内 tab）" (a08:1512). The editor
 * half now lives in `../center/EditorColumn.tsx`.
 *
 * Both halves call `useEditor()` — it is store-backed (`stores/editor.ts`), so
 * `navigateToFile` here and the tabs there are the same state, not two copies.
 *
 * The surface id stays `editor` (see surfaceRegistry for why the id was not
 * renamed); only its meaning and label changed.
 */

import { getDisplayPathBasename } from '@shared/utils/path';
import { FileCode, Search } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { FileTree } from '@/components/files/FileTree';
import { NewItemDialog } from '@/components/files/NewItemDialog';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { useEditor } from '@/hooks/useEditor';
import { useFileTree } from '@/hooks/useFileTree';
import { useI18n } from '@/i18n';
import { SURFACE_ESCAPE_HOLD_ATTR } from '../shellLayoutModel';
import type { SurfaceViewProps } from '../surfaceViews';
import { useWorkspaceRootPath } from '../useWorkspaceRootPath';
import { filterFileTree, parseFileFilter } from './fileTreeFilter';

/** Computed key so a rename of the constant cannot leave a dead attribute behind. */
const ESCAPE_HOLD_PROPS = { [SURFACE_ESCAPE_HOLD_ATTR]: '' };

type NewItemType = 'file' | 'directory' | null;

export function FilesSurfaceView({ active, onSearch }: SurfaceViewProps) {
  const { t } = useI18n();
  const rootPath = useWorkspaceRootPath();

  const surfaceActive = active;

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

  const { navigateToFile, closeFile } = useEditor();

  // Layout 5d: the filter box. A content query (`?…`) leaves the tree alone.
  const [filter, setFilter] = useState('');
  const parsedFilter = parseFileFilter(filter);
  const filtered = useMemo(
    () => filterFileTree(tree, parsedFilter.kind === 'name' ? parsedFilter.text : ''),
    [tree, parsedFilter.kind, parsedFilter.text]
  );
  const shownExpandedPaths = useMemo(
    () =>
      filtered.expand.size === 0 ? expandedPaths : new Set([...expandedPaths, ...filtered.expand]),
    [expandedPaths, filtered.expand]
  );

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

  // T103: delete confirmation moved off the native, synchronous
  // `window.confirm` and onto the app's own AlertDialog — hardcoded English
  // there could not go through `t()`, and a blocking native prompt cannot be
  // driven by the CDP-based point checks the rest of the shell uses.
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; isDirectory: boolean } | null>(
    null
  );

  const handleDeleteRequest = useCallback((path: string, isDirectory: boolean) => {
    setDeleteTarget({ path, isDirectory });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const { path } = deleteTarget;
    setDeleteTarget(null);
    await deleteItem(path);
    closeFile(path);
  }, [deleteTarget, deleteItem, closeFile]);

  // A08 (a08:1512): a tree click opens the CENTER editor. `navigateToFile`
  // already handles both branches (existing tab → activate + background
  // refresh, new path → open), so there is nothing to re-derive here.
  const handleFileClick = useCallback(
    (path: string) => {
      navigateToFile(path);
    },
    [navigateToFile]
  );

  if (!rootPath) {
    return (
      <Empty className="h-full gap-3 border-0 p-2 md:p-2">
        <EmptyMedia variant="icon">
          <FileCode className="h-4.5 w-4.5" />
        </EmptyMedia>
        <EmptyHeader>
          {/* D25 §3.3: cancel EmptyTitle's 18px-sized negative tracking when
              overriding to 14px, same as the other surfaces. */}
          <EmptyTitle className="text-ui tracking-normal">{t('Files')}</EmptyTitle>
          <EmptyDescription className="text-small">
            {t('Select a Workspace to browse files')}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    // M6 (T-13 adversarial review, still load-bearing): FileTree's rename input
    // lives in here, and an unheld Escape closed the whole panel (via
    // ContextPanel's onKeyDownCapture) before the rename's own handler ran,
    // silently dropping the in-progress rename.
    <div className="flex h-full min-h-0 min-w-0 flex-col" {...ESCAPE_HOLD_PROPS}>
      {/* Layout 5d: the card's header names the pane and carries the tree's
          toolbar; the filter box sits right under it (the reference's files
          pane). `?text` + Enter searches file contents instead. */}
      <div className="shrink-0 px-2 pb-1.5">
        <InputGroup className="h-7">
          <InputGroupAddon>
            <Search className="size-3.5 text-foreground-faint" />
          </InputGroupAddon>
          <InputGroupInput
            size="sm"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && parsedFilter.kind === 'content') {
                event.preventDefault();
                onSearch?.('content');
              } else if (event.key === 'Escape' && filter) {
                // Clear first; the next Escape reaches the pane.
                event.stopPropagation();
                setFilter('');
              }
            }}
            placeholder={t('Filter, or ? to search in files')}
            aria-label={t('Filter files')}
          />
        </InputGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <FileTree
          tree={filtered.nodes}
          expandedPaths={shownExpandedPaths}
          onToggleExpand={toggleExpand}
          onFileClick={handleFileClick}
          onCreateFile={handleCreateFile}
          onCreateDirectory={handleCreateDirectory}
          onRename={renameItem}
          onDelete={handleDeleteRequest}
          onRefresh={refresh}
          onOpenSearch={onSearch ? () => onSearch?.('files') : undefined}
          isLoading={isTreeLoading}
          rootPath={rootPath}
        />
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
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.isDirectory ? t('Delete folder?') : t('Delete file?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('This will delete “{{name}}” from disk. This action cannot be undone.', {
                name: deleteTarget ? getDisplayPathBasename(deleteTarget.path) : '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t('Cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void handleConfirmDelete()}>
              {t('Delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
