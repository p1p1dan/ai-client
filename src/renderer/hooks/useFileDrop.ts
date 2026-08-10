import { fileUriToPath } from '@shared/utils/fileUrl';
import { normalizePath } from '@shared/utils/path';
import { useEffect, useRef } from 'react';

interface UseFileDropOptions {
  /** Project working directory, used to convert absolute paths to relative */
  cwd?: string;
  /** Callback when file paths are resolved from a drop event */
  onDrop: (paths: string[]) => void;
  /** Whether the hook is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook to handle external file drops (from OS file manager, VS Code, etc.)
 * onto a target element. Uses capture-phase listeners to intercept before
 * child elements (e.g., xterm.js) can swallow the events.
 *
 * Supports:
 * - Native file drops (Finder, Explorer) via `dataTransfer.files` + Electron `webUtils`
 * - VS Code / IDE drops via `text/uri-list` (file:// URIs)
 */
export function useFileDrop<T extends HTMLElement>({
  cwd,
  onDrop,
  enabled = true,
}: UseFileDropOptions) {
  const ref = useRef<T>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    const hasDroppableData = (dt: DataTransfer | null): boolean => {
      if (!dt) return false;
      return dt.types.includes('Files') || dt.types.includes('text/uri-list');
    };

    const handleDragOver = (e: DragEvent) => {
      if (hasDroppableData(e.dataTransfer)) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
        // No stopPropagation (fix, 2026-08-10): this is a capture-phase
        // listener, so stopping it here killed the event before it could ever
        // reach the document-level "add repository" drop zone
        // (App/hooks/useFileDragDrop.ts) — dragging a folder over a mounted
        // terminal made the whole app ignore the drag. preventDefault alone is
        // enough to keep this element droppable.
      }
    };

    const handleDrop = (e: DragEvent) => {
      if (!hasDroppableData(e.dataTransfer)) return;

      // A dropped directory belongs to the document-level "add repository"
      // flow, not this element's "insert @path" shortcut — do not consume it.
      // Must not preventDefault/stopPropagation either, or the drop never
      // reaches document's own `drop` listener.
      if (isDirectoryDrop(e.dataTransfer?.items)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const resolved = resolveDroppedPaths(e.dataTransfer!, cwd);
      if (resolved.length > 0) {
        onDropRef.current(resolved);
      }
    };

    el.addEventListener('dragover', handleDragOver, true);
    el.addEventListener('drop', handleDrop, true);
    return () => {
      el.removeEventListener('dragover', handleDragOver, true);
      el.removeEventListener('drop', handleDrop, true);
    };
  }, [cwd, enabled]);

  return ref;
}

/**
 * Minimal shape of `DataTransfer.items` this check needs, so it can be unit
 * tested without a real (jsdom-free) DataTransferItemList.
 */
export interface DirectoryCheckItem {
  webkitGetAsEntry(): { isDirectory: boolean } | null;
}

/**
 * True when the first dragged item is a directory (folder). Extracted as a
 * pure predicate — a full `DragEvent`/`DataTransfer` is not vitest-friendly,
 * but `webkitGetAsEntry().isDirectory` alone is.
 */
export function isDirectoryDrop(items: ArrayLike<DirectoryCheckItem> | null | undefined): boolean {
  const first = items?.[0];
  const entry = first?.webkitGetAsEntry() ?? null;
  return entry?.isDirectory ?? false;
}

/**
 * Extract file paths from a DataTransfer, supporting:
 * 1. Native file drops (dataTransfer.files + Electron webUtils)
 * 2. URI list drops (text/uri-list from VS Code, etc.)
 */
function resolveDroppedPaths(dt: DataTransfer, cwd?: string): string[] {
  const paths: string[] = [];

  // 1. Try native files first (Finder / Explorer)
  if (dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i++) {
      try {
        const filePath = window.electronAPI.utils.getPathForFile(dt.files[i]);
        if (filePath) {
          paths.push(filePath);
        }
      } catch {
        // getPathForFile may fail for non-native files
      }
    }
  }

  // 2. Fallback: parse text/uri-list (VS Code, other IDEs)
  if (paths.length === 0) {
    const uriList = dt.getData('text/uri-list');
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        const trimmed = line.trim();
        // Skip comments and empty lines per RFC 2483
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('file://')) {
          const decoded = fileUriToPath(trimmed, window.electronAPI.env.platform);
          if (decoded) {
            paths.push(decoded);
          }
        }
      }
    }
  }

  // Convert to relative path if inside cwd, otherwise keep absolute path
  // Normalize separators for cross-platform compatibility
  const normalizedCwd = cwd ? normalizePath(cwd) : '';
  return paths.map((p) => {
    const normalizedPath = normalizePath(p);
    if (normalizedCwd && normalizedPath.startsWith(`${normalizedCwd}/`)) {
      // File is inside current repo, use relative path
      return normalizedPath.substring(normalizedCwd.length + 1);
    }

    // File is outside current repo, use absolute path
    return normalizedPath;
  });
}
