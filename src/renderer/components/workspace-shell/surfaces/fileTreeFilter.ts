/**
 * Layout 5d: the files pane's filter box (the reference's 「Filter, or ? to
 * search in files」). Matches names in the tree as far as it is loaded — a
 * folder never opened has no children to search, which is what `?` (content
 * search across the workspace) is for. Pure so vitest covers it.
 */

export interface FilterableNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FilterableNode[];
}

export interface FileTreeFilterResult<T extends FilterableNode> {
  nodes: T[];
  /** Folders to show open so every match is visible. */
  expand: Set<string>;
  matches: number;
}

/** `?foo` asks for a content search; anything else filters by name. */
export function parseFileFilter(raw: string): { kind: 'name' | 'content'; text: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('?')) return { kind: 'content', text: trimmed.slice(1).trim() };
  return { kind: 'name', text: trimmed };
}

/**
 * Keeps a node when its name contains the query (case-insensitive) or any
 * loaded descendant does; a matching folder keeps all its children. An empty
 * query returns the tree untouched.
 */
export function filterFileTree<T extends FilterableNode>(
  nodes: readonly T[],
  query: string
): FileTreeFilterResult<T> {
  const needle = query.trim().toLowerCase();
  if (!needle) return { nodes: [...nodes], expand: new Set(), matches: 0 };
  const expand = new Set<string>();
  let matches = 0;
  const walk = (list: readonly T[]): T[] => {
    const kept: T[] = [];
    for (const node of list) {
      const hit = node.name.toLowerCase().includes(needle);
      if (hit) matches += 1;
      const before = matches;
      const children = node.children ? walk(node.children as T[]) : undefined;
      if (hit) {
        // A match deeper inside a matching folder still needs it open.
        if (matches > before) expand.add(node.path);
        kept.push(node);
      } else if (children && children.length > 0) {
        expand.add(node.path);
        kept.push({ ...node, children });
      }
    }
    return kept;
  };
  return { nodes: walk(nodes), expand, matches };
}
