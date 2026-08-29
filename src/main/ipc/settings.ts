import { IPC_CHANNELS } from '@shared/types';
import { app, ipcMain } from 'electron';
import {
  readSharedSettings,
  writeSharedSettings,
  writeSharedSettingsToSession,
} from '../services/SharedSessionState';
import { toggleClaudeProviderWatcher } from './claudeProvider';

// Inlined to break circular chunk: shell -> settings -> shell.
// Canonical definition: src/shared/credentialMode.ts
const CREDENTIAL_MODE_SETTING_KEY = 'credentialMode';

/**
 * The renderer's not-yet-flushed settings object, or `null` when nothing is
 * waiting. NOT a cache of the file.
 *
 * It used to be one, and that was the defect: it was filled by the FIRST read
 * and never refreshed, while `services/auth/credentialMode.ts` writes
 * `credentialMode` straight through `SharedSessionState` — so any key Main
 * wrote after that first read was invisible here, and the renderer's
 * read-modify-write (`stores/settings/storage.ts` reads the whole object,
 * patches one key, writes it all back) put the stale value back on disk.
 *
 * Symptom on a real machine (2026-08-28): a user who picked `Use my own setup`
 * had `credentialMode: 'local'` erased by the next settings save, fell back to
 * the `managed` default, and was told `auth_required` by the spawn gate for
 * every action; a user who then signed in had it reverted to `local`, so the
 * company credential was never injected and Claude Code ran on their own
 * `~/.claude` config instead.
 */
let pendingRendererSettings: Record<string, unknown> | null = null;
let pendingWrite: NodeJS.Timeout | null = null;
let maxWaitTimer: NodeJS.Timeout | null = null;
let isDirty = false;

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 5000;

/**
 * Top-level keys Main owns and the renderer does not model.
 *
 * The renderer persists by writing the WHOLE object back, so every key on this
 * list has to be re-taken from the current file at write time — otherwise a
 * save that started before Main's write silently undoes it. Absence is
 * meaningful too (`credentialMode` missing = first run = must sign in), which
 * is why the overlay DELETES a key the file no longer has rather than leaving
 * whatever the renderer sent.
 */
const MAIN_OWNED_SETTING_KEYS: readonly string[] = [CREDENTIAL_MODE_SETTING_KEY, 'onboarding'];

/** Take the Main-owned keys from the file as it is NOW, over a renderer payload. */
function withMainOwnedKeys(data: Record<string, unknown>): Record<string, unknown> {
  const current = readSharedSettings();
  const merged = { ...data };
  for (const key of MAIN_OWNED_SETTING_KEYS) {
    if (key in current) {
      merged[key] = current[key];
    } else {
      delete merged[key];
    }
  }
  return merged;
}

/**
 * Settings as the app should see them: the file, with a pending renderer save
 * layered on top for the keys it owns.
 *
 * `readSharedSettings()` already memoises the parsed file and invalidates that
 * memo on write, so there is nothing to cache here — a second cache is exactly
 * what produced the bug documented on `pendingRendererSettings`.
 */
export function readSettings(): Record<string, unknown> | null {
  if (pendingRendererSettings === null) {
    return readSharedSettings();
  }
  return withMainOwnedKeys(pendingRendererSettings);
}

/**
 * 原子写入：先写临时文件，再重命名，避免崩溃导致文件损坏
 */
function atomicWriteSettings(data: Record<string, unknown>): boolean {
  try {
    writeSharedSettings(data);
    writeSharedSettingsToSession(data);
    return true;
  } catch {
    return false;
  }
}

function clearPendingTimers(): void {
  if (pendingWrite) {
    clearTimeout(pendingWrite);
    pendingWrite = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }
}

/**
 * Main-side write. NOT run through `withMainOwnedKeys` — this is the path
 * `mergeSettingsPatch` uses to SET those keys, and overlaying the previous
 * file on top of it would undo the patch it was called to apply.
 */
export function writeSettingsNow(data: Record<string, unknown>): boolean {
  clearPendingTimers();
  // Whatever the renderer had queued is included in `data` (via `readSettings`
  // below) and is now on disk, so there is nothing left pending.
  pendingRendererSettings = null;
  isDirty = false;
  return atomicWriteSettings(data);
}

export function mergeSettingsPatch(patch: Record<string, unknown>): boolean {
  return writeSettingsNow({
    ...(readSettings() ?? {}),
    ...patch,
  });
}

/** Flush the renderer's queued save, re-taking the Main-owned keys as they are now. */
function flushPendingRendererSettings(): boolean {
  if (pendingRendererSettings === null) return true;
  const data = withMainOwnedKeys(pendingRendererSettings);
  pendingRendererSettings = null;
  isDirty = false;
  return atomicWriteSettings(data);
}

/**
 * 强制落盘（在退出前调用）
 */
export function flushSettings(): boolean {
  clearPendingTimers();

  if (isDirty) {
    return flushPendingRendererSettings();
  }
  return true;
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_READ, async () => {
    return readSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_WRITE, async (_, data: unknown) => {
    try {
      const newData = data as Record<string, unknown>;

      // Detect enableProviderWatcher change and toggle watcher accordingly
      const oldEnabled = (readSettings()?.claudeCodeIntegration as Record<string, unknown>)
        ?.enableProviderWatcher;
      const newEnabled = (newData.claudeCodeIntegration as Record<string, unknown>)
        ?.enableProviderWatcher;
      if (oldEnabled !== newEnabled) {
        toggleClaudeProviderWatcher(newEnabled !== false);
      }

      // 排队等待落盘（Main 私有键在落盘那一刻才取，见 withMainOwnedKeys）
      pendingRendererSettings = newData;
      isDirty = true;

      // 防抖写入
      if (pendingWrite) {
        clearTimeout(pendingWrite);
      }

      // 如果没有 maxWait 计时器，启动一个
      if (!maxWaitTimer) {
        maxWaitTimer = setTimeout(() => {
          flushPendingRendererSettings();
          maxWaitTimer = null;
          pendingWrite = null;
        }, MAX_WAIT_MS);
      }

      pendingWrite = setTimeout(() => {
        if (maxWaitTimer) {
          clearTimeout(maxWaitTimer);
          maxWaitTimer = null;
        }
        flushPendingRendererSettings();
        pendingWrite = null;
      }, DEBOUNCE_MS);

      return true;
    } catch {
      return false;
    }
  });

  // 在退出前强制落盘
  app.on('before-quit', () => {
    flushSettings();
  });
}
