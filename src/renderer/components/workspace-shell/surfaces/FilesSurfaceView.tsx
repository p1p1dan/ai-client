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

import { FileCode } from 'lucide-react';
import { useCallback, useState } from 'react';
import { FileTree } from '@/components/files/FileTree';
import { NewItemDialog } from '@/components/files/NewItemDialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { useEditor } from '@/hooks/useEditor';
import { useFileTree } from '@/hooks/useFileTree';
import { useI18n } from '@/i18n';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { SURFACE_ESCAPE_HOLD_ATTR } from '../shellLayoutModel';
import type { SurfaceViewProps } from '../surfaceViews';
import { useWorkspaceRootPath } from '../useWorkspaceRootPath';

/** Computed key so a rename of the constant cannot leave a dead attribute behind. */
const ESCAPE_HOLD_PROPS = { [SURFACE_ESCAPE_HOLD_ATTR]: '' };

type NewItemType = 'file' | 'directory' | null;

export function FilesSurfaceView({ surfaceId }: SurfaceViewProps) {
  const { t } = useI18n();
  const rootPath = useWorkspaceRootPath();

  const activeSurfaceId = useShellLayoutStore((state) => state.activeSurfaceId);
  const surfaceActive = activeSurfaceId === surfaceId;

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
          <EmptyDescription className="text-meta">
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
      <div className="min-h-0 flex-1 overflow-hidden">
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
