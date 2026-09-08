import {
  isRuntimePermissionSettings,
  migratePermissionTier,
  type RuntimePermissionSettings,
} from '@shared/types/runtimePermission';
import {
  isSessionPermissionTier,
  type SessionPermissionTier,
} from '@shared/types/sessionPermissionTier';
import { isEffortSelection } from './efforts';

export const SESSION_MODEL_STORAGE_KEY = 'aiclient:chat:session-models';
export const SESSION_EFFORT_STORAGE_KEY = 'aiclient:chat:session-efforts';
export const SESSION_TIER_STORAGE_KEY = 'aiclient:chat:session-tiers';
/**
 * U29: the tier a chat starts on when it has never been given one.
 *
 * A separate key rather than a reserved id inside the per-session map: that map
 * is keyed by real session ids and swept by `removeSessionTier`, and a sentinel
 * living among them is one careless cleanup away from being deleted.
 *
 * Model and effort need no equivalent — `chatAgentDefaults` in the settings
 * store is already exactly this ("Pi-only defaults for new chat sessions"), and
 * `runSend` already reads it. Only the tier had no global home.
 */
export const DEFAULT_TIER_STORAGE_KEY = 'aiclient:chat:default-tier';

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
  removeEntry(SESSION_PERMISSIONS_STORAGE_KEY, sessionId);
  removeEntry(SESSION_TIER_STORAGE_KEY, sessionId);
}

/**
 * U29 — the tier new chats inherit, and the one the composer shows before a
 * chat exists.
 *
 * `null` (never set) is deliberately distinct from a stored value: it lets the
 * spawn path fall through to Main's own default instead of this renderer
 * pinning one, which is the behaviour every chat had before U29.
 */
export function readDefaultTier(): SessionPermissionTier | null {
  try {
    const raw = localStorage.getItem(DEFAULT_TIER_STORAGE_KEY);
    return raw && isSessionPermissionTier(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeDefaultTier(tier: SessionPermissionTier): void {
  if (!isSessionPermissionTier(tier)) return;
  try {
    localStorage.setItem(DEFAULT_TIER_STORAGE_KEY, tier);
  } catch {
    // Selection remains in the component when storage is unavailable.
  }
}

export const SESSION_PERMISSIONS_STORAGE_KEY = 'aiclient:chat:session-permissions';
export const DEFAULT_PERMISSIONS_STORAGE_KEY = 'aiclient:chat:default-permissions';

export function readSessionPermissions(sessionId: string): RuntimePermissionSettings | null {
  const value = loadMap(SESSION_PERMISSIONS_STORAGE_KEY)[sessionId];
  if (isRuntimePermissionSettings(value)) return value;
  const legacy = readSessionTier(sessionId);
  return legacy ? migratePermissionTier(legacy) : null;
}
export function writeSessionPermissions(
  sessionId: string,
  settings: RuntimePermissionSettings
): void {
  const map = loadMap(SESSION_PERMISSIONS_STORAGE_KEY);
  map[sessionId] = settings;
  saveMap(SESSION_PERMISSIONS_STORAGE_KEY, map);
}
export function readDefaultPermissions(): RuntimePermissionSettings | null {
  try {
    const raw = localStorage.getItem(DEFAULT_PERMISSIONS_STORAGE_KEY);
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (isRuntimePermissionSettings(value)) return value;
    }
  } catch {
    // Fall back to the old setting when the new storage is unavailable or invalid.
  }
  const legacy = readDefaultTier();
  return legacy ? migratePermissionTier(legacy) : null;
}
export function writeDefaultPermissions(settings: RuntimePermissionSettings): void {
  try {
    localStorage.setItem(DEFAULT_PERMISSIONS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The current selection remains usable when storage is unavailable.
  }
}
