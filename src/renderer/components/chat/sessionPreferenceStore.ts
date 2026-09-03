import {
  isSessionPermissionTier,
  type SessionPermissionTier,
} from '@shared/types/sessionPermissionTier';
import { isEffortSelection } from './efforts';

export const SESSION_MODEL_STORAGE_KEY = 'aiclient:chat:session-models';
export const SESSION_EFFORT_STORAGE_KEY = 'aiclient:chat:session-efforts';
export const SESSION_TIER_STORAGE_KEY = 'aiclient:chat:session-tiers';

type PreferenceMap = Record<string, unknown>;

function loadMap(storageKey: string): PreferenceMap {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PreferenceMap)
      : {};
  } catch {
    return {};
  }
}

function saveMap(storageKey: string, map: PreferenceMap): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    // Selection remains in the component when storage is unavailable.
  }
}

/** Read Pi-only scalar or one legacy per-agent row. */
function readEntry(storageKey: string, sessionId: string): string | null {
  const entry = loadMap(storageKey)[sessionId];
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const legacy = entry as Record<string, unknown>;
  const value = legacy.pi ?? legacy['claude-code'] ?? legacy.codex;
  return typeof value === 'string' ? value : null;
}

function writeEntry(storageKey: string, sessionId: string, value: string): void {
  const map = loadMap(storageKey);
  map[sessionId] = value;
  saveMap(storageKey, map);
}

function removeEntry(storageKey: string, sessionId: string): void {
  const map = loadMap(storageKey);
  if (!(sessionId in map)) return;
  delete map[sessionId];
  saveMap(storageKey, map);
}

export function readSessionModel(sessionId: string): string | null {
  return readEntry(SESSION_MODEL_STORAGE_KEY, sessionId);
}

export function writeSessionModel(sessionId: string, modelId: string): void {
  if (!modelId.trim()) return;
  writeEntry(SESSION_MODEL_STORAGE_KEY, sessionId, modelId.trim());
}

export function removeSessionModel(sessionId: string): void {
  removeEntry(SESSION_MODEL_STORAGE_KEY, sessionId);
}

export function readSessionEffort(sessionId: string): string | null {
  return readEntry(SESSION_EFFORT_STORAGE_KEY, sessionId);
}

export function writeSessionEffort(sessionId: string, selection: string): void {
  if (!isEffortSelection(selection)) return;
  writeEntry(SESSION_EFFORT_STORAGE_KEY, sessionId, selection);
}

export function removeSessionEffort(sessionId: string): void {
  removeEntry(SESSION_EFFORT_STORAGE_KEY, sessionId);
}

export function readSessionTier(sessionId: string): SessionPermissionTier | null {
  const raw = readEntry(SESSION_TIER_STORAGE_KEY, sessionId);
  return raw && isSessionPermissionTier(raw) ? raw : null;
}

export function writeSessionTier(sessionId: string, tier: SessionPermissionTier): void {
  if (!isSessionPermissionTier(tier)) return;
  writeEntry(SESSION_TIER_STORAGE_KEY, sessionId, tier);
}

export function removeSessionTier(sessionId: string): void {
  removeEntry(SESSION_TIER_STORAGE_KEY, sessionId);
}
