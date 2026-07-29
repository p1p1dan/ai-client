import { useEffect, useRef, useState } from 'react';
import {
  hasFilePayload,
  isDragLeavingWindow,
  isPointInsideDropZone,
  normalizeDroppedRepositoryPath,
} from './fileDragDrop';

export function useFileDragDrop(
  enabled: boolean,
  setInitialLocalPath: (path: string | null) => void,
  openAddRepositoryDialog: () => void
) {
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  // Bound by whichever shell is mounted: legacy sidebar or the new shell root.
  const repositorySidebarRef = useRef<HTMLDivElement>(null);
  const isFileDragOverRef = useRef(false);

  // Keep ref in sync with state
  useEffect(() => {
    isFileDragOverRef.current = isFileDragOver;
  }, [isFileDragOver]);

  useEffect(() => {
    if (!enabled) {
      setIsFileDragOver(false);
      return;
    }

    const handleDragOver = (e: DragEvent) => {
      if (!hasFilePayload(e.dataTransfer?.types)) return;
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }

      const rect = repositorySidebarRef.current?.getBoundingClientRect() ?? null;
      setIsFileDragOver(isPointInsideDropZone(rect, { x: e.clientX, y: e.clientY }));
    };

    const handleDragLeave = (e: DragEvent) => {
      // Sole reset path for an OS folder drag that leaves without dropping: it
      // has no source node in this document, so no `dragend` is ever dispatched
      // here. Missing an edge leaves the highlight armed and the next unrelated
      // file drop would open the add dialog.
      if (
        isDragLeavingWindow(
          { x: e.clientX, y: e.clientY },
          { width: window.innerWidth, height: window.innerHeight }
        )
      ) {
        setIsFileDragOver(false);
      }
    };

    const handleDragEnd = () => {
      // Belt and braces for drags started inside the document (e.g. reordering
      // session tabs); those do end on a source node. OS file drags are covered
      // by the `dragleave` edge check above.
      setIsFileDragOver(false);
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      const wasOver = isFileDragOverRef.current;
      setIsFileDragOver(false);

      if (wasOver && e.dataTransfer?.files.length) {
        const file = e.dataTransfer.files[0];
        const path = normalizeDroppedRepositoryPath(window.electronAPI.utils.getPathForFile(file));
        if (path) {
          setInitialLocalPath(path);
          openAddRepositoryDialog();
        }
      }
    };

    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragend', handleDragEnd);
    document.addEventListener('drop', handleDrop);
    return () => {
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragend', handleDragEnd);
      document.removeEventListener('drop', handleDrop);
    };
  }, [enabled, openAddRepositoryDialog, setInitialLocalPath]);

  return {
    isFileDragOver,
    repositorySidebarRef,
  };
}
