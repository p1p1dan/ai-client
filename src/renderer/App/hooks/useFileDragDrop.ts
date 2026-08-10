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
  // Field-test self-diagnosis (2026-08-10): "drag a folder in, nothing
  // happens" reports gave no signal on WHICH step it died at. `dragover`
  // fires continuously while the pointer moves, so this dedups the
  // invalid-payload warning to one line per drag session instead of
  // spamming the console; reset at the session boundaries (`dragend`/`drop`).
  const invalidPayloadWarnedRef = useRef(false);

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
      if (!hasFilePayload(e.dataTransfer)) {
        if (!invalidPayloadWarnedRef.current) {
          invalidPayloadWarnedRef.current = true;
          console.warn('[file-drag] dragover ignored: no file payload', {
            types: e.dataTransfer ? Array.from(e.dataTransfer.types) : [],
            itemKinds: e.dataTransfer
              ? Array.from(e.dataTransfer.items).map((item) => item.kind)
              : [],
          });
        }
        return;
      }
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
      invalidPayloadWarnedRef.current = false;
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      // Session boundary: next drag's dragover gets a fresh warning slot.
      invalidPayloadWarnedRef.current = false;
      const wasOver = isFileDragOverRef.current;
      setIsFileDragOver(false);

      if (wasOver && e.dataTransfer?.files.length) {
        const file = e.dataTransfer.files[0];
        const path = normalizeDroppedRepositoryPath(window.electronAPI.utils.getPathForFile(file));
        if (path) {
          console.warn(
            `[file-drag] drop accepted: resolved 1 path from ${e.dataTransfer.files.length} file(s)`
          );
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
