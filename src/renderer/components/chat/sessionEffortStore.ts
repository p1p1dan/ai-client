/**
 * Per-session reasoning-effort persistence (T-20) — pure storage layer.
 *
 * Kept separate from the `useSessionEffort` hook so the behavior is unit
 * testable: the repo's vitest environment is `node` with no React renderer, so
 * anything wrapped in `useCallback` cannot be called from a test at all (this is
 * why T-08's `useSessionModel` has no coverage). The hook is now a thin
 * `useCallback` wrapper over these functions.
 *
 * Values may be a real level or the `EFFORT_DEFAULT_ID` sentinel; `toWireEffort`
 * (efforts.ts) decides what actually goes on the wire.
 */

export const SESSION_EFFORT_STORAGE_KEY = 'aiclient:chat:session-efforts';

type SessionEffortMap = Record<string, string>;

function loadMap(): SessionEffortMap {
  try {
    const raw = localStorage.getItem(SESSION_EFFORT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SessionEffortMap;
    }
    return {};
  } catch {
    // Corrupt blob or storage unavailable (private mode / quota) — treat as unset.
    return {};
  }
}

function saveMap(map: SessionEffortMap): void {
  try {
    localStorage.setItem(SESSION_EFFORT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage may be unavailable; selection stays in memory only.
  }
}

/** Stored selection for a session, or null when unset. */
export function readSessionEffort(sessionId: string): string | null {
  return loadMap()[sessionId] ?? null;
}

/** Bind a selection to a session and persist. Never throws. */
export function writeSessionEffort(sessionId: string, selection: string): void {
  const map = loadMap();
  map[sessionId] = selection;
  saveMap(map);
}

/** Drop the binding for a session (no-op when unset). Never throws. */
export function removeSessionEffort(sessionId: string): void {
  const map = loadMap();
  if (sessionId in map) {
    delete map[sessionId];
    saveMap(map);
  }
}
