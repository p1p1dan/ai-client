import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStorageDocument } from '@shared/types';
import { getAppStateRoot } from './appStatePaths';

const STORAGE_VERSION = 2;
const SETTINGS_FILENAME = 'settings.json';
const SESSION_FILENAME = 'session-state.json';
const SETTINGS_MIGRATION_MARKER = '.local-settings-migrated';
const LOCAL_STORAGE_MIGRATION_MARKER = '.local-localstorage-migrated';

let cachedSettings: Record<string, unknown> | null = null;
let cachedSessionState: SessionStorageDocument | null = null;

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function now(): number {
  return Date.now();
}

function getSharedRoot(): string {
  return getAppStateRoot();
}

function getSettingsPath(): string {
  return join(getSharedRoot(), SETTINGS_FILENAME);
}

function getSessionPath(): string {
  return join(getSharedRoot(), SESSION_FILENAME);
}

function getMigrationMarkerPath(marker: string): string {
  return join(getSharedRoot(), marker);
}

function atomicWriteJson(targetPath: string, data: unknown): void {
  ensureDir(getSharedRoot());
  const tempPath = `${targetPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tempPath, targetPath);
}

function defaultSessionStorageDocument(
  input?: Partial<Pick<SessionStorageDocument, 'updatedAt' | 'settingsData' | 'localStorage'>>
): SessionStorageDocument {
  return {
    version: STORAGE_VERSION,
    updatedAt: input?.updatedAt ?? now(),
    settingsData: input?.settingsData ?? {},
    localStorage: input?.localStorage ?? {},
  };
}

function normalizeSettings(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * What the disk read of settings.json found, as shape only — never content and
 * never the path. A file Main cannot parse is read as `{}`, i.e. "every setting
 * at its default", which is indistinguishable on screen from settings that were
 * never saved; this is what lets a field log tell the two apart.
 */
export interface SharedFileLoadInfo {
  outcome: 'ok' | 'missing' | 'read-error' | 'invalid-json' | 'not-object';
  bytes?: number;
  /** errno code of a failed read. */
  code?: string;
  /** What the file starts with: `{`, a UTF-8 BOM, the TSD driver's header, nothing, or else. */
  head?: 'brace' | 'bom' | 'tsd-header' | 'empty' | 'other';
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// Same magic as `utils/tsdSafeRead.ts`, spelled here so this module does not
// pull `child_process` into everything that reads settings.
const TSD_HEADER = Buffer.from('%TSD-Header-###%');

let settingsLoadInfo: SharedFileLoadInfo | null = null;

function classifyHead(raw: Buffer): NonNullable<SharedFileLoadInfo['head']> {
  if (raw.length === 0) return 'empty';
  if (raw.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) return 'bom';
  if (raw.subarray(0, TSD_HEADER.length).equals(TSD_HEADER)) return 'tsd-header';
  const first = raw.toString('utf-8', 0, Math.min(raw.length, 64)).trimStart();
  return first.startsWith('{') ? 'brace' : 'other';
}

function readJsonFileWithInfo<T>(targetPath: string): {
  value: T | null;
  info: SharedFileLoadInfo;
} {
  if (!existsSync(targetPath)) {
    return { value: null, info: { outcome: 'missing' } };
  }
  let raw: Buffer;
  try {
    raw = readFileSync(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { value: null, info: { outcome: 'read-error', code: code ?? 'unknown' } };
  }
  const head = classifyHead(raw);
  // A BOM is what an editor such as older Notepad adds on save; JSON.parse
  // rejects it, which used to turn one hand-edit into "every setting lost".
  const text = raw.toString('utf-8', head === 'bom' ? UTF8_BOM.length : 0);
  const value = safeJsonParse<T>(text);
  if (value === null) {
    return { value: null, info: { outcome: 'invalid-json', bytes: raw.length, head } };
  }
  const isObject = typeof value === 'object' && !Array.isArray(value);
  return { value, info: { outcome: isObject ? 'ok' : 'not-object', bytes: raw.length, head } };
}

function readJsonFile<T>(targetPath: string): T | null {
  return readJsonFileWithInfo<T>(targetPath).value;
}

export function readSharedSettings(): Record<string, unknown> {
  if (cachedSettings) {
    return cachedSettings;
  }
  const { value, info } = readJsonFileWithInfo<Record<string, unknown>>(getSettingsPath());
  settingsLoadInfo = info;
  const parsed = normalizeSettings(value);
  cachedSettings = parsed;
  return parsed;
}

/** The last disk read of settings.json, or `null` when it has not been read from disk yet. */
export function getSettingsLoadInfo(): SharedFileLoadInfo | null {
  return settingsLoadInfo ? { ...settingsLoadInfo } : null;
}

export function writeSharedSettings(data: Record<string, unknown>): void {
  cachedSettings = data;
  atomicWriteJson(getSettingsPath(), data);
}

export function readSharedSessionState(): SessionStorageDocument {
  if (cachedSessionState) {
    return cachedSessionState;
  }

  const parsed = readJsonFile<Partial<SessionStorageDocument>>(getSessionPath());
  cachedSessionState =
    parsed && parsed.version === STORAGE_VERSION
      ? defaultSessionStorageDocument({
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now(),
          settingsData: normalizeSettings(parsed.settingsData),
          localStorage:
            parsed.localStorage && typeof parsed.localStorage === 'object'
              ? (parsed.localStorage as Record<string, string>)
              : {},
        })
      : defaultSessionStorageDocument();

  return cachedSessionState;
}

export function writeSharedSessionState(data: SessionStorageDocument): void {
  cachedSessionState = {
    ...data,
    version: STORAGE_VERSION,
  };
  atomicWriteJson(getSessionPath(), cachedSessionState);
}

export function updateSharedSessionState(
  updater: (current: SessionStorageDocument) => SessionStorageDocument
): SessionStorageDocument {
  const next = updater(readSharedSessionState());
  writeSharedSessionState(next);
  return next;
}

export function getSharedLocalStorageSnapshot(): Record<string, string> {
  return { ...readSharedSessionState().localStorage };
}

export function writeSharedLocalStorageSnapshot(snapshot: Record<string, string>): void {
  updateSharedSessionState((current) => ({
    ...current,
    updatedAt: now(),
    localStorage: { ...snapshot },
  }));
}

export function writeSharedSettingsToSession(data: Record<string, unknown>): void {
  updateSharedSessionState((current) => ({
    ...current,
    updatedAt: now(),
    settingsData: data,
  }));
}

export function readSharedSettingsFromSession(): Record<string, unknown> {
  return { ...readSharedSessionState().settingsData };
}

export function getSharedStatePaths(): {
  root: string;
  settingsPath: string;
  sessionPath: string;
  settingsMarkerPath: string;
  localStorageMarkerPath: string;
} {
  return {
    root: getSharedRoot(),
    settingsPath: getSettingsPath(),
    sessionPath: getSessionPath(),
    settingsMarkerPath: getMigrationMarkerPath(SETTINGS_MIGRATION_MARKER),
    localStorageMarkerPath: getMigrationMarkerPath(LOCAL_STORAGE_MIGRATION_MARKER),
  };
}

export function isLegacySettingsMigrated(): boolean {
  return existsSync(getMigrationMarkerPath(SETTINGS_MIGRATION_MARKER));
}

export function markLegacySettingsMigrated(): void {
  ensureDir(getSharedRoot());
  writeFileSync(getMigrationMarkerPath(SETTINGS_MIGRATION_MARKER), String(now()), 'utf-8');
}

export function isLegacyLocalStorageMigrated(): boolean {
  return existsSync(getMigrationMarkerPath(LOCAL_STORAGE_MIGRATION_MARKER));
}

export function markLegacyLocalStorageMigrated(): void {
  ensureDir(getSharedRoot());
  writeFileSync(getMigrationMarkerPath(LOCAL_STORAGE_MIGRATION_MARKER), String(now()), 'utf-8');
}

export function clearSharedStateCache(): void {
  cachedSettings = null;
  cachedSessionState = null;
  settingsLoadInfo = null;
}
