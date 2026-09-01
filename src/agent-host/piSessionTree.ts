import {
  PI_SESSION_TREE_BACKEND_LIMIT,
  type PiLeafCheckpoint,
  type SessionTreeNode,
  type SessionTreeSnapshot,
} from '../shared/types/sessionHistory.ts';
import { PiWorkerSessionError } from './piWorkerErrors.ts';

interface PiTreeEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: unknown;
  summary?: unknown;
  customType?: unknown;
  content?: unknown;
  label?: unknown;
  name?: unknown;
  modelId?: unknown;
  provider?: unknown;
  thinkingLevel?: unknown;
}

export interface PiTreeSessionManager {
  getEntries?: () => unknown[];
  getBranch?: (fromId?: string) => unknown[];
  getLeafId?: () => string | null;
  getLabel?: (id: string) => string | undefined;
}

const PREVIEW_MAX = 96;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      const item = record(part);
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function compactPreview(value: string): string | undefined {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length <= PREVIEW_MAX ? compact : `${compact.slice(0, PREVIEW_MAX - 1)}…`;
}

function entryPreview(entry: PiTreeEntry): { preview?: string; role?: string } {
  const type = typeof entry.type === 'string' ? entry.type : 'unknown';
  if (type === 'message') {
    const message = record(entry.message);
    const role = typeof message?.role === 'string' ? message.role : undefined;
    const preview = compactPreview(textContent(message?.content));
    return { ...(preview ? { preview } : {}), ...(role ? { role } : {}) };
  }
  if (type === 'custom_message') {
    const preview = compactPreview(textContent(entry.content));
    return {
      ...(preview ? { preview } : {}),
      ...(typeof entry.customType === 'string' ? { role: entry.customType } : {}),
    };
  }
  const summary = typeof entry.summary === 'string' ? compactPreview(entry.summary) : undefined;
  if (summary) return { preview: summary };
  if (type === 'model_change') {
    return {
      preview: [entry.provider, entry.modelId]
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .join('/'),
    };
  }
  if (type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string') {
    return { preview: entry.thinkingLevel };
  }
  if (type === 'session_info' && typeof entry.name === 'string') {
    return { preview: compactPreview(entry.name) };
  }
  if (type === 'label' && typeof entry.label === 'string') {
    return { preview: compactPreview(entry.label) };
  }
  return {};
}

function normalizeEntry(
  value: unknown
): (PiTreeEntry & { id: string; parentId: string | null }) | null {
  const entry = record(value) as PiTreeEntry | null;
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return null;
  return {
    ...entry,
    id: entry.id,
    parentId:
      typeof entry.parentId === 'string' && entry.parentId.length > 0 ? entry.parentId : null,
  };
}

export function readPiLeafCheckpoint(manager: PiTreeSessionManager): PiLeafCheckpoint {
  const entries = manager.getEntries?.() ?? [];
  let fileTailEntryId: string | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = normalizeEntry(entries[index]);
    if (entry) {
      fileTailEntryId = entry.id;
      break;
    }
  }
  return {
    activeEntryId: manager.getLeafId?.() ?? null,
    fileTailEntryId,
  };
}

export function buildPiSessionTreeSnapshot(input: {
  manager: PiTreeSessionManager;
  logicalSessionId: string;
  sessionFile: string;
  workspacePath: string;
  limit?: number;
}): SessionTreeSnapshot {
  const rawEntries = input.manager.getEntries?.();
  if (!rawEntries) {
    throw new PiWorkerSessionError(
      'WORKER_TREE_UNAVAILABLE',
      'Pi session does not expose iterable session entries'
    );
  }
  const entries = rawEntries
    .map(normalizeEntry)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.parentId || entry.parentId === entry.id || !byId.has(entry.parentId)) {
      roots.push(entry.id);
      continue;
    }
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry.id);
    children.set(entry.parentId, siblings);
  }

  const activeIds = new Set(
    (input.manager.getBranch?.() ?? [])
      .map(normalizeEntry)
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .map((entry) => entry.id)
  );
  const leafId = input.manager.getLeafId?.() ?? null;
  const limit = Math.max(
    1,
    Math.min(input.limit ?? PI_SESSION_TREE_BACKEND_LIMIT, PI_SESSION_TREE_BACKEND_LIMIT)
  );
  const projected: SessionTreeNode[] = [];
  const visited = new Set<string>();
  const projectNode = (
    entry: PiTreeEntry & { id: string; parentId: string | null },
    depth: number,
    forkable: boolean
  ): SessionTreeNode => {
    const timestamp =
      typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    const label = input.manager.getLabel?.(entry.id);
    return {
      id: entry.id,
      parentId: entry.parentId,
      depth,
      entryType: typeof entry.type === 'string' ? entry.type : 'unknown',
      ...entryPreview(entry),
      ...(label ? { label } : {}),
      ...(Number.isFinite(timestamp) ? { timestamp } : {}),
      childCount: (children.get(entry.id) ?? []).length,
      forkable,
      active: activeIds.has(entry.id),
      leaf: leafId === entry.id,
    };
  };
  const stack = roots
    .slice()
    .reverse()
    .map((id) => ({ id, depth: 0, forkable: false }));

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || visited.has(next.id)) continue;
    const entry = byId.get(next.id);
    if (!entry) continue;
    visited.add(next.id);
    const childIds = children.get(entry.id) ?? [];
    const message = record(entry.message);
    const forkable = next.forkable || (entry.type === 'message' && message?.role === 'assistant');
    projected.push(projectNode(entry, next.depth, forkable));
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId) stack.push({ id: childId, depth: next.depth + 1, forkable });
    }
  }

  // Defensive cycle/orphan fallback: every valid entry remains discoverable.
  if (visited.size < entries.length) {
    for (const entry of entries) {
      if (visited.has(entry.id)) continue;
      projected.push(
        projectNode(
          entry,
          0,
          entry.type === 'message' && record(entry.message)?.role === 'assistant'
        )
      );
      visited.add(entry.id);
    }
  }

  const leafIndex = projected.findIndex((node) => node.leaf);
  const windowEnd = leafIndex >= 0 ? Math.max(limit, leafIndex + 1) : projected.length;
  const windowStart = Math.max(0, Math.min(projected.length - limit, windowEnd - limit));
  const nodes = projected.slice(windowStart, windowStart + limit);

  return {
    logicalSessionId: input.logicalSessionId,
    sessionFile: input.sessionFile,
    workspacePath: input.workspacePath,
    leaf: readPiLeafCheckpoint(input.manager),
    nodes,
    totalNodes: entries.length,
    returnedNodes: nodes.length,
    truncated: nodes.length < entries.length,
  };
}
