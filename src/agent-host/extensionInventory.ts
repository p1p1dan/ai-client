/**
 * U04 — project pi's loaded-extension list into something the UI can show.
 *
 * The list comes from `services.resourceLoader.getExtensions()`, which the
 * bootstrap already calls to verify the permission extension. Reading it here
 * rather than re-deriving the inventory in Main is deliberate: pi owns
 * extension resolution (settings, package manager, scopes, enable flags), and a
 * second implementation would sooner or later tell the user about a plugin the
 * agent never loaded.
 *
 * Everything is read defensively. This is an SDK shape that crosses a version
 * boundary, and a plugin list is decoration — a surprise here must never be
 * able to fail a bootstrap, so unreadable entries are dropped, not thrown on.
 */

import type { WorkerExtensionInfo } from '../shared/types/workerRpc.ts';
import type { PiLoadedExtensions } from './piAgentSessionBootstrap.ts';

/** Cap so a pathological settings file cannot push an unbounded list over RPC. */
export const EXTENSION_INVENTORY_MAX = 64;

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A readable name for a path like `/home/u/.pi/extensions/pi-mcp/index.js`.
 *
 * pi's `Extension` carries no name field, so the directory is the closest thing
 * to one: extensions are published as a directory with an entry file, and that
 * directory name is what the user configured. A bare file falls back to its own
 * stem rather than to a generic label — `extension` on five rows would be worse
 * than a slightly odd but distinct name.
 */
export function extensionDisplayName(path: string): string {
  const segments = path.split(/[/\\]/).filter((part) => part.length > 0);
  const last = segments[segments.length - 1] ?? path;
  const isEntryFile = /^(index|extension|main)\.[cm]?[jt]s$/i.test(last);
  const candidate = isEntryFile ? (segments[segments.length - 2] ?? last) : last;
  return candidate.replace(/\.[cm]?[jt]s$/i, '');
}

/**
 * Loaded + failed extensions, hidden internals removed.
 *
 * Hidden ones are ours: the permission-activity observer and the session-tier
 * authorizer are registered as inline factories with `hidden: true`, and they
 * are implementation detail of features the user already sees elsewhere (the
 * approval prompts and the tier chip). Listing them as "installed plugins"
 * would invite someone to look for a way to remove them.
 */
export function readLoadedExtensionInventory(
  loaded: PiLoadedExtensions | undefined
): WorkerExtensionInfo[] {
  if (!loaded) return [];
  const result: WorkerExtensionInfo[] = [];

  for (const entry of Array.isArray(loaded.extensions) ? loaded.extensions : []) {
    const record = readRecord(entry);
    if (!record) continue;
    if (record.hidden === true) continue;
    const path = readString(record.resolvedPath) ?? readString(record.path);
    if (!path) continue;
    const sourceInfo = readRecord(record.sourceInfo);
    const source = readString(sourceInfo?.source);
    const scope = readString(sourceInfo?.scope);
    result.push({
      name: extensionDisplayName(path),
      path,
      ...(source ? { source } : {}),
      ...(scope ? { scope } : {}),
      ok: true,
    });
  }

  for (const entry of Array.isArray(loaded.errors) ? loaded.errors : []) {
    const record = readRecord(entry);
    if (!record) continue;
    const path = readString(record.path);
    if (!path) continue;
    // A failed extension is the one the user most needs to see: it was
    // configured, it is not running, and nothing else in the app says so.
    result.push({
      name: extensionDisplayName(path),
      path,
      ok: false,
      error: readString(record.error) ?? 'unknown error',
    });
  }

  return result.slice(0, EXTENSION_INVENTORY_MAX);
}
