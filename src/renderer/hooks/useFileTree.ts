import type { FileEntry } from '@shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadFileTreeExpandedPaths, saveFileTreeExpandedPaths } from '@/App/storage';

interface UseFileTreeOptions {
  rootPath: string | undefined;
  enabled?: boolean;
  isActive?: boolean;
}

interface FileTreeNode extends FileEntry {
  children?: FileTreeNode[];
  isLoading?: boolean;
}

/**
 * Split a path into its parent directory and the separator that produced it.
 *
 * The main process hands back native paths (backslashes on Windows) while the
 * rest of this hook slices on '/', so both separators have to be understood.
 * Node's `path` module is unavailable here — this runs in the renderer.
 */
function splitParentPath(targetPath: string): { parent: string; separator: string } {
  const index = Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\'));
  if (index < 0) return { parent: '', separator: '/' };
  const separator = targetPath[index];
  return { parent: targetPath.slice(0, index) || separator, separator };
}

function getParentPath(targetPath: string): string {
  return splitParentPath(targetPath).parent;
}

function isAbsolutePath(candidate: string): boolean {
  return (
    candidate.startsWith('/') || candidate.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(candidate)
  );
}

/**
 * T095: the tree's inline rename input produces a BARE name, not a path. Sent
 * as-is the main process resolves it against its own cwd, which either moves
 * the file to an unrelated directory or trips the workspace guard with a path
 * nobody recognises. The source path is the only place the destination
 * directory is known, so the join happens here.
 */
export function resolveRenameTarget(fromPath: string, newNameOrPath: string): string {
  if (isAbsolutePath(newNameOrPath)) return newNameOrPath;
  const { parent, separator } = splitParentPath(fromPath);
  if (!parent) return newNameOrPath;
  return parent.endsWith(separator)
    ? `${parent}${newNameOrPath}`
    : `${parent}${separator}${newNameOrPath}`;
}

/** True when `candidate` is `ancestor` itself or sits underneath it. */
function isSelfOrDescendant(candidate: string, ancestor: string): boolean {
  return (
    candidate === ancestor ||
    candidate.startsWith(`${ancestor}/`) ||
    candidate.startsWith(`${ancestor}\\`)
  );
}

export function useFileTree({ rootPath, enabled = true, isActive = true }: UseFileTreeOptions) {
  const queryClient = useQueryClient();
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    rootPath ? loadFileTreeExpandedPaths(rootPath) : new Set()
  );

  // Fetch root directory
  const { data: rootFiles, isLoading: isRootLoading } = useQuery({
    queryKey: ['file', 'list', rootPath],
    queryFn: async () => {
      if (!rootPath) return [];
      return window.electronAPI.file.list(rootPath, rootPath);
    },
    enabled: enabled && !!rootPath,
  });

  // Build tree structure with expanded directories
  const [tree, setTree] = useState<FileTreeNode[]>([]);

  // Use refs to access state in callbacks without stale closure issues
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;

  // Track the current rootPath in a ref for use inside callbacks
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;
  // Track whether children have been restored for the current rootPath
  const childrenRestoredRef = useRef(false);

  // Helper: update expanded state and persist to localStorage atomically
  const setAndPersistExpandedPaths = useCallback((paths: Set<string>) => {
    setExpandedPaths(paths);
    if (rootPathRef.current) saveFileTreeExpandedPaths(rootPathRef.current, paths);
  }, []);

  // Drop a vanished directory and its descendants from the expanded set. Without
  // this a deleted/renamed directory keeps a persisted "expanded" entry that
  // comes back as an arrow with no content after the next repo switch.
  const pruneExpandedPaths = useCallback(
    (removedPath: string) => {
      const current = expandedPathsRef.current;
      const next = new Set<string>();
      for (const p of current) {
        if (!isSelfOrDescendant(p, removedPath)) next.add(p);
      }
      if (next.size === current.size) return;
      expandedPathsRef.current = next; // Sync ref immediately
      setAndPersistExpandedPaths(next);
    },
    [setAndPersistExpandedPaths]
  );

  // When rootPath changes: restore saved expanded state and trigger a fresh tree fetch
  useEffect(() => {
    if (!rootPath) return;

    childrenRestoredRef.current = false;
    setExpandedPaths(loadFileTreeExpandedPaths(rootPath));
    setTree([]);

    // Invalidate root query so rootFiles effect always re-fires even on cache hit
    queryClient.invalidateQueries({ queryKey: ['file', 'list', rootPath] });
  }, [rootPath, queryClient]);

  // Load children for a directory.
  //
  // `staleTime: 0` on purpose: subdirectory listings have no observer, so
  // nothing in react-query ever refetches them. Serving the cached entry — as
  // this used to — replayed a pre-CRUD (or pre-unmount) snapshot of the
  // directory, which is how a deleted file survived a surface switch. The disk
  // read is cheap next to the wrong answer; `fetchQuery` still dedupes
  // concurrent callers and keeps the cache populated for the tree merge.
  const loadChildren = useCallback(
    async (path: string): Promise<FileEntry[]> =>
      queryClient.fetchQuery({
        queryKey: ['file', 'list', path],
        queryFn: () => window.electronAPI.file.list(path, rootPath),
        staleTime: 0,
      }),
    [queryClient, rootPath]
  );

  // 递归更新树，设置整个子目录链的 children
  const updateTreeWithChain = useCallback(
    (nodes: FileTreeNode[], targetPath: string, chainChildren: FileTreeNode[]): FileTreeNode[] => {
      return nodes.map((node) => {
        if (node.path === targetPath) {
          return { ...node, children: chainChildren, isLoading: false };
        }
        if (node.children) {
          return {
            ...node,
            children: updateTreeWithChain(node.children, targetPath, chainChildren),
          };
        }
        return node;
      });
    },
    []
  );

  // Update tree when root files change, then restore children for all expanded paths
  useEffect(() => {
    if (!rootFiles || !rootPath) return;

    // Merge root-level nodes, preserving already-loaded children
    const mergeNodes = (newNodes: FileEntry[], oldNodes: FileTreeNode[]): FileTreeNode[] => {
      return newNodes.map((newNode) => {
        const oldNode = oldNodes.find((o) => o.path === newNode.path);
        if (oldNode?.children) {
          return { ...newNode, children: oldNode.children };
        }
        return { ...newNode };
      });
    };

    const merged = mergeNodes(rootFiles, treeRef.current);
    setTree(merged);
    treeRef.current = merged;

    // Only restore once per rootPath switch (childrenRestoredRef resets on rootPath change)
    if (childrenRestoredRef.current) return;

    // Read directly from localStorage to avoid stale ref when this effect fires
    // in the same flush as the rootPath effect (expandedPathsRef may still hold
    // the previous rootPath's paths before setExpandedPaths state update is applied)
    const restored = loadFileTreeExpandedPaths(rootPath);
    if (restored.size === 0) {
      childrenRestoredRef.current = true;
      return;
    }

    // Sort shallow-first so parent nodes are populated before their children
    const sortedPaths = [...restored].sort((a, b) => a.split('/').length - b.split('/').length);

    let cancelled = false;

    const restoreChildren = async () => {
      for (const expandedPath of sortedPaths) {
        if (cancelled) return;
        try {
          const children = await loadChildren(expandedPath);
          if (cancelled) return;
          const childNodes = children.map((c) => ({ ...c })) as FileTreeNode[];
          const updated = updateTreeWithChain(treeRef.current, expandedPath, childNodes);
          treeRef.current = updated;
          setTree(updated);
        } catch {
          // Silently skip paths that fail to load (e.g. deleted directories)
        }
      }
      // Only mark as restored after all children loaded successfully without cancellation
      if (!cancelled) {
        childrenRestoredRef.current = true;
      }
    };

    restoreChildren();
    return () => {
      cancelled = true;
    };
  }, [rootFiles, rootPath, loadChildren, updateTreeWithChain]);

  // Toggle directory expansion
  const toggleExpand = useCallback(
    async (path: string) => {
      // Special case: collapse all
      if (path === '__COLLAPSE_ALL__') {
        setAndPersistExpandedPaths(new Set());
        return;
      }

      const newExpanded = new Set(expandedPathsRef.current);

      if (newExpanded.has(path)) {
        // Collapse: remove this path and all its expanded descendants so that
        // no orphaned child paths remain in localStorage. This prevents the
        // inconsistency where a child appears "expanded" (arrow icon) but has
        // no content after the parent is re-opened following a repo switch.
        for (const p of [...newExpanded]) {
          if (p === path || p.startsWith(`${path}/`)) {
            newExpanded.delete(p);
          }
        }
        setAndPersistExpandedPaths(newExpanded);
      } else {
        // 展开时，自动加载单子目录链
        const markLoading = (nodes: FileTreeNode[]): FileTreeNode[] => {
          return nodes.map((node) => {
            if (node.path === path && node.isDirectory && !node.children) {
              return { ...node, isLoading: true };
            }
            if (node.children) {
              return { ...node, children: markLoading(node.children) };
            }
            return node;
          });
        };

        const clearLoading = (nodes: FileTreeNode[]): FileTreeNode[] => {
          return nodes.map((node) => {
            if (node.path === path && node.isLoading) {
              return { ...node, isLoading: false };
            }
            if (node.children) {
              return { ...node, children: clearLoading(node.children) };
            }
            return node;
          });
        };

        // 检查是否需要加载
        const needsLoad = (nodes: FileTreeNode[]): boolean => {
          for (const node of nodes) {
            if (node.path === path && node.isDirectory && !node.children) return true;
            if (node.children && needsLoad(node.children)) return true;
          }
          return false;
        };

        newExpanded.add(path);
        expandedPathsRef.current = newExpanded; // Sync ref immediately
        setAndPersistExpandedPaths(newExpanded);

        if (needsLoad(treeRef.current)) {
          setTree((current) => markLoading(current));

          try {
            // 加载整个单子目录链
            const children = await loadChildren(path);
            const allPaths = [path];
            const finalChildren = children.map((c) => ({ ...c })) as FileTreeNode[];

            // 如果只有一个子目录，继续加载链
            if (children.length === 1 && children[0].isDirectory) {
              const loadChain = async (
                dirPath: string,
                _nodes: FileTreeNode[]
              ): Promise<FileTreeNode[]> => {
                const dirChildren = await loadChildren(dirPath);
                allPaths.push(dirPath);

                const childNodes = dirChildren.map((c) => ({ ...c })) as FileTreeNode[];

                if (dirChildren.length === 1 && dirChildren[0].isDirectory) {
                  childNodes[0].children = await loadChain(dirChildren[0].path, childNodes);
                }

                return childNodes;
              };

              finalChildren[0].children = await loadChain(children[0].path, finalChildren);
            }

            // 更新展开状态
            const nextExpanded = new Set(expandedPathsRef.current);
            for (const p of allPaths) nextExpanded.add(p);
            expandedPathsRef.current = nextExpanded; // Sync ref immediately
            setAndPersistExpandedPaths(nextExpanded);

            // 更新树
            const newTree = updateTreeWithChain(treeRef.current, path, finalChildren);
            treeRef.current = newTree; // Sync ref immediately
            setTree(newTree);
          } catch (error) {
            // Roll back expanded state on load failure
            const rolled = new Set(expandedPathsRef.current);
            rolled.delete(path);
            setAndPersistExpandedPaths(rolled);
            setTree((current) => clearLoading(current));
            console.error('Failed to load directory children:', error);
          }
        }
      }
    },
    [loadChildren, updateTreeWithChain, setAndPersistExpandedPaths]
  );

  // 递归更新树中某个目录的 children
  const refreshNodeChildren = useCallback(
    async (targetPath: string) => {
      try {
        const newChildren = await window.electronAPI.file.list(targetPath, rootPath);
        queryClient.setQueryData(['file', 'list', targetPath], newChildren);

        setTree((current) => {
          const updateNode = (nodes: FileTreeNode[]): FileTreeNode[] => {
            return nodes.map((node) => {
              if (node.path === targetPath && node.children) {
                // 合并新数据，保留子目录已加载的 children
                const mergedChildren = newChildren.map((newChild) => {
                  const oldChild = node.children?.find((o) => o.path === newChild.path);
                  if (oldChild?.children) {
                    return { ...newChild, children: oldChild.children };
                  }
                  return { ...newChild };
                });
                return { ...node, children: mergedChildren as FileTreeNode[] };
              }
              if (node.children) {
                return { ...node, children: updateNode(node.children) };
              }
              return node;
            });
          };
          return updateNode(current);
        });
      } catch (error) {
        // Directory is gone - drop its cache entry and its expanded paths.
        // The error crossed IPC, which strips `code` off the Error object, so
        // the previous `error.code === 'ENOENT'` test could never be true and
        // the branch never ran. Match on the message text instead.
        const message = error instanceof Error ? error.message : String(error);
        if (/ENOENT|ENOTDIR/.test(message)) {
          queryClient.removeQueries({ queryKey: ['file', 'list', targetPath] });
          pruneExpandedPaths(targetPath);
        }
      }
    },
    [queryClient, rootPath, pruneExpandedPaths]
  );

  /**
   * T094: make a write visible without waiting for the file watcher.
   *
   * `invalidateQueries` alone did nothing here. Only the ROOT listing has an
   * observer; every subdirectory listing is written by hand via `loadChildren`,
   * so marking it stale neither refetches it nor removes it, and the tree state
   * (`tree`) is not derived from the cache at all. The result was a panel that
   * did not move after a create/delete/rename inside an expanded directory.
   */
  const refreshAfterMutation = useCallback(
    async (targetPath: string) => {
      // The path itself may have had a cached listing (a directory that was
      // deleted or renamed); it must not be served again under the old name.
      queryClient.removeQueries({ queryKey: ['file', 'list', targetPath] });

      const parentPath = getParentPath(targetPath);
      if (!parentPath) return;

      if (parentPath === rootPathRef.current) {
        await queryClient.refetchQueries({ queryKey: ['file', 'list', parentPath] });
        return;
      }
      await refreshNodeChildren(parentPath);
    },
    [queryClient, refreshNodeChildren]
  );

  // Track if we need to refresh when becoming active
  const needsRefreshOnActiveRef = useRef(false);

  // Use ref for isActive to avoid effect re-runs on tab switch
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // File watch effect - always watch, but only update UI when active
  useEffect(() => {
    if (!rootPath || !enabled) return;

    // Start watching. The promise was previously dropped on the floor, so a
    // refused or crashed subscription left the panel silently un-watched with
    // nothing in the log to say so.
    void window.electronAPI.file.watchStart(rootPath).catch((error) => {
      console.error('[useFileTree] Failed to start file watcher:', rootPath, error);
    });

    // Listen for changes
    const unsubscribe = window.electronAPI.file.onChange(async (event) => {
      const parentPath = event.path.substring(0, event.path.lastIndexOf('/')) || rootPath;

      // Always invalidate cache regardless of isActive
      if (parentPath !== rootPath) {
        queryClient.removeQueries({ queryKey: ['file', 'list', parentPath] });
      }

      // If not active, mark for refresh when becoming active
      if (!isActiveRef.current) {
        needsRefreshOnActiveRef.current = true;
        return;
      }

      if (parentPath === rootPath) {
        // Root directory change - refetch immediately
        await queryClient.refetchQueries({ queryKey: ['file', 'list', rootPath] });
      } else if (expandedPathsRef.current.has(parentPath)) {
        // Expanded subdirectory change - refresh its children
        await refreshNodeChildren(parentPath);
      }

      // If the changed path itself is an expanded directory, refresh its children
      if (expandedPathsRef.current.has(event.path)) {
        await refreshNodeChildren(event.path);
      }
    });

    return () => {
      unsubscribe();
      void window.electronAPI.file.watchStop(rootPath).catch((error) => {
        console.error('[useFileTree] Failed to stop file watcher:', rootPath, error);
      });
    };
  }, [rootPath, enabled, queryClient, refreshNodeChildren]);

  // File operations
  const createFile = useCallback(
    async (path: string, content = '') => {
      await window.electronAPI.file.createFile(path, content);
      await refreshAfterMutation(path);
    },
    [refreshAfterMutation]
  );

  const createDirectory = useCallback(
    async (path: string) => {
      await window.electronAPI.file.createDirectory(path);
      await refreshAfterMutation(path);
    },
    [refreshAfterMutation]
  );

  /**
   * `newNameOrPath` is what the tree's inline editor produced: usually a bare
   * file name. `resolveRenameTarget` turns it into an absolute destination
   * before it crosses IPC (T095) — the main process would otherwise resolve a
   * relative target against its own cwd.
   */
  const renameItem = useCallback(
    async (fromPath: string, newNameOrPath: string) => {
      const toPath = resolveRenameTarget(fromPath, newNameOrPath);
      await window.electronAPI.file.rename(fromPath, toPath);
      // A renamed directory no longer exists under its old path, so its
      // expanded entries would otherwise linger in localStorage forever.
      pruneExpandedPaths(fromPath);
      await refreshAfterMutation(fromPath);
    },
    [refreshAfterMutation, pruneExpandedPaths]
  );

  const deleteItem = useCallback(
    async (path: string) => {
      await window.electronAPI.file.delete(path);
      pruneExpandedPaths(path);
      await refreshAfterMutation(path);
    },
    [refreshAfterMutation, pruneExpandedPaths]
  );

  const refresh = useCallback(async () => {
    console.log('[useFileTree] Refresh started');
    // Force invalidate all cached queries first
    queryClient.invalidateQueries({ queryKey: ['file', 'list'] });

    // Refetch root directory first
    await queryClient.refetchQueries({ queryKey: ['file', 'list', rootPath] });
    console.log('[useFileTree] Root refetched');

    // Refetch all expanded directories in parallel
    const currentExpanded = Array.from(expandedPathsRef.current);
    console.log('[useFileTree] Refetching expanded paths:', currentExpanded);
    await Promise.all(
      currentExpanded.filter((path) => path !== rootPath).map((path) => refreshNodeChildren(path))
    );
    console.log('[useFileTree] Refresh completed');
  }, [queryClient, rootPath, refreshNodeChildren]);

  // Handle external file drop
  const handleExternalDrop = useCallback(
    async (
      files: FileList,
      targetDir: string,
      operation: 'copy' | 'move'
    ): Promise<{
      success: string[];
      failed: Array<{ path: string; error: string }>;
      conflicts?: Array<{
        path: string;
        name: string;
        sourceSize: number;
        targetSize: number;
        sourceModified: number;
        targetModified: number;
      }>;
    }> => {
      console.log('[useFileTree] handleExternalDrop', {
        filesCount: files.length,
        targetDir,
        operation,
        rootPath,
      });

      if (!rootPath) {
        console.warn('[useFileTree] No rootPath');
        return { success: [], failed: [] };
      }

      // Convert FileList to array of paths
      const sourcePaths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        console.log('[useFileTree] Processing file:', {
          name: file.name,
          type: file.type,
          size: file.size,
        });
        // Get the full path from the file using Electron's webUtils
        try {
          const filePath = window.electronAPI.utils.getPathForFile(file);
          console.log('[useFileTree] File path:', filePath);
          if (filePath) {
            sourcePaths.push(filePath);
          }
        } catch (error) {
          console.error('[useFileTree] Failed to get file path:', error);
        }
      }

      console.log('[useFileTree] Source paths:', sourcePaths);

      if (sourcePaths.length === 0) {
        console.warn('[useFileTree] No valid source paths');
        return { success: [], failed: [] };
      }

      // Check for conflicts
      console.log('[useFileTree] Checking conflicts...');
      const conflicts = await window.electronAPI.file.checkConflicts(sourcePaths, targetDir);
      console.log('[useFileTree] Conflicts:', conflicts);

      if (conflicts.length > 0) {
        // Return conflicts to be handled by the UI
        return { success: [], failed: [], conflicts };
      }

      // No conflicts, proceed with operation
      try {
        console.log('[useFileTree] Executing operation:', operation);
        if (operation === 'copy') {
          const result = await window.electronAPI.file.batchCopy(sourcePaths, targetDir, []);
          console.log('[useFileTree] Copy result:', result);
          await refresh();
          return result;
        }
        const result = await window.electronAPI.file.batchMove(sourcePaths, targetDir, []);
        console.log('[useFileTree] Move result:', result);
        await refresh();
        return result;
      } catch (error) {
        console.error('[useFileTree] Operation failed:', error);
        return {
          success: [],
          failed: sourcePaths.map((path) => ({
            path,
            error: error instanceof Error ? error.message : 'Unknown error',
          })),
        };
      }
    },
    [rootPath, refresh]
  );

  // Resolve conflicts and complete file operation
  const resolveConflictsAndContinue = useCallback(
    async (
      sourcePaths: string[],
      targetDir: string,
      operation: 'copy' | 'move',
      resolutions: Array<{ path: string; action: 'replace' | 'skip' | 'rename'; newName?: string }>
    ): Promise<{ success: string[]; failed: Array<{ path: string; error: string }> }> => {
      try {
        if (operation === 'copy') {
          const result = await window.electronAPI.file.batchCopy(
            sourcePaths,
            targetDir,
            resolutions
          );
          await refresh();
          return result;
        }
        const result = await window.electronAPI.file.batchMove(sourcePaths, targetDir, resolutions);
        await refresh();
        return result;
      } catch (error) {
        console.error('Failed to resolve conflicts:', error);
        return {
          success: [],
          failed: sourcePaths.map((path) => ({
            path,
            error: error instanceof Error ? error.message : 'Unknown error',
          })),
        };
      }
    },
    [refresh]
  );

  // Refresh when becoming active if changes occurred while inactive
  useEffect(() => {
    if (isActive && needsRefreshOnActiveRef.current) {
      needsRefreshOnActiveRef.current = false;
      refresh();
    }
  }, [isActive, refresh]);

  // Reveal a file in the tree by expanding all parent directories
  const revealFile = useCallback(
    async (filePath: string) => {
      if (!rootPath || !filePath.startsWith(rootPath)) return;

      // Get relative path and split into parts
      const relativePath = filePath.slice(rootPath.length).replace(/^\//, '');
      if (!relativePath) return;

      const parts = relativePath.split('/');
      // Remove the file name, keep only directories
      parts.pop();

      if (parts.length === 0) return;

      // Build paths for each parent directory
      let currentPath = rootPath;
      const pathsToExpand: string[] = [];

      for (const part of parts) {
        currentPath = `${currentPath}/${part}`;
        // Use ref to get current expanded state (avoids stale closure)
        if (!expandedPathsRef.current.has(currentPath)) {
          pathsToExpand.push(currentPath);
        }
      }

      // Expand each path sequentially (toggleExpand handles loading)
      for (const path of pathsToExpand) {
        await toggleExpand(path);
      }
    },
    [rootPath, toggleExpand]
  );

  return {
    tree,
    isLoading: isRootLoading,
    expandedPaths,
    toggleExpand,
    createFile,
    createDirectory,
    renameItem,
    deleteItem,
    refresh,
    handleExternalDrop,
    resolveConflictsAndContinue,
    revealFile,
  };
}

export type { FileTreeNode };
