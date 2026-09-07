import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANNOUNCEMENTS_CACHE_FILE_NAME,
  ANNOUNCEMENTS_MAX_BYTES,
  ANNOUNCEMENTS_READ_STATE_FILE_NAME,
  ANNOUNCEMENTS_TIMEOUT_MS,
  type Announcement,
  type AnnouncementsResult,
  mergeReadAnnouncementIds,
  parseAnnouncements,
} from '@shared/announcements';

export interface AnnouncementFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type AnnouncementFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<AnnouncementFetchResponse>;

export interface AnnouncementServiceOptions {
  /** Directory the cache and read-state files live in. */
  stateDir: string;
  endpointUrl: string;
  fetchFn: AnnouncementFetch;
  now?: () => number;
  timeoutMs?: number;
  log?: (...args: unknown[]) => void;
}

interface CacheFile {
  announcements: Announcement[];
  fetchedAt: number | null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, path);
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 240);
  return String(error).slice(0, 240);
}

/**
 * F09 — fetch, cache and read-state for startup announcements.
 *
 * ## The one rule this service exists to keep
 *
 * **It cannot fail loudly.** Announcements are the least important thing
 * happening at startup, and every method here returns a value rather than
 * throwing: an unreachable service, a malformed response, an unreadable cache
 * file and a read-only disk all degrade to "no announcements" or "the cached
 * ones". `refresh()` is `await`ed by nobody on the critical path — the renderer
 * asks for the result when it is ready, and Main answers with whatever it has.
 *
 * ## Cache semantics, and how they differ from the model catalog's
 *
 * `PiModelConfigService` caches because a stale model list is still useful and
 * a fabricated one is dangerous. This caches for a narrower reason: so that an
 * offline launch still shows the message the user has not read yet. There is no
 * TTL and no freshness rung — every launch asks, and the cache is only ever the
 * fallback for that ask failing. A cache that could be served INSTEAD of asking
 * would let a retracted announcement outlive its retraction.
 */
export class AnnouncementService {
  private readonly stateDir: string;
  private readonly endpointUrl: string;
  private readonly fetchFn: AnnouncementFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: (...args: unknown[]) => void;
  /** Single-flight: two windows opening at once must not double-fetch. */
  private inFlight: Promise<AnnouncementsResult> | null = null;

  constructor(options: AnnouncementServiceOptions) {
    this.stateDir = options.stateDir;
    this.endpointUrl = options.endpointUrl;
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? ANNOUNCEMENTS_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
  }

  get cachePath(): string {
    return join(this.stateDir, ANNOUNCEMENTS_CACHE_FILE_NAME);
  }

  get readStatePath(): string {
    return join(this.stateDir, ANNOUNCEMENTS_READ_STATE_FILE_NAME);
  }

  /** Ask the service; fall back to the cache; never throw. */
  async refresh(): Promise<AnnouncementsResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchOnce(): Promise<AnnouncementsResult> {
    const readIds = this.readReadIds();
    try {
      const response = await this.fetchFn(this.endpointUrl, {
        method: 'GET',
        // No `Authorization`: this endpoint is public by ruling, so that an
        // expired login still receives the message explaining why.
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`announcement endpoint returned HTTP ${response.status}`);
      if (Buffer.byteLength(body, 'utf8') > ANNOUNCEMENTS_MAX_BYTES) {
        throw new Error('announcement response is too large');
      }
      const announcements = parseAnnouncements(JSON.parse(body) as unknown);
      const fetchedAt = this.now();
      this.writeCache({ announcements, fetchedAt });
      // Prune read ids the service no longer serves, so the set stays bounded
      // and a retired-then-reused id can never arrive pre-read.
      const prunedReadIds = mergeReadAnnouncementIds({ readIds, seenIds: [], announcements });
      if (prunedReadIds.length !== readIds.length) this.writeReadIds(prunedReadIds);
      return { announcements, source: 'remote', fetchedAt, readIds: prunedReadIds };
    } catch (error) {
      const message = safeError(error);
      this.log('[announcements] fetch failed', { error: message });
      const cached = this.readCache();
      if (cached) {
        return {
          announcements: cached.announcements,
          source: 'cache',
          fetchedAt: cached.fetchedAt,
          readIds,
          error: message,
        };
      }
      return {
        announcements: [],
        source: 'unavailable',
        fetchedAt: null,
        readIds,
        error: message,
      };
    }
  }

  /** The last known answer, with no network call. Used before a refresh lands. */
  snapshot(): AnnouncementsResult {
    const cached = this.readCache();
    const readIds = this.readReadIds();
    if (!cached) {
      return { announcements: [], source: 'unavailable', fetchedAt: null, readIds };
    }
    return {
      announcements: cached.announcements,
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      readIds,
    };
  }

  /** Record that these ids have been seen. Returns the pruned stored set. */
  markRead(ids: readonly string[]): string[] {
    const cached = this.readCache();
    const merged = mergeReadAnnouncementIds({
      readIds: this.readReadIds(),
      seenIds: ids,
      announcements: cached?.announcements ?? [],
    });
    this.writeReadIds(merged);
    return merged;
  }

  /** Logout clears read state: the next account starts from its own zero. */
  clearReadState(): void {
    this.writeReadIds([]);
  }

  private readCache(): CacheFile | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      const value = readJson(this.cachePath);
      if (!value || typeof value !== 'object') return null;
      const record = value as { announcements?: unknown; fetchedAt?: unknown };
      return {
        // Re-parsed rather than trusted: the file on disk is a copy of a remote
        // answer, and a hand-edited or half-written one must degrade the same
        // way a bad response does.
        announcements: parseAnnouncements(record.announcements),
        fetchedAt: typeof record.fetchedAt === 'number' ? record.fetchedAt : null,
      };
    } catch {
      return null;
    }
  }

  private writeCache(value: CacheFile): void {
    try {
      atomicWriteJson(this.cachePath, value);
    } catch (error) {
      this.log('[announcements] failed to write cache', { error: safeError(error) });
    }
  }

  private readReadIds(): string[] {
    if (!existsSync(this.readStatePath)) return [];
    try {
      const value = readJson(this.readStatePath);
      if (!Array.isArray(value)) return [];
      return value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    } catch {
      return [];
    }
  }

  private writeReadIds(ids: readonly string[]): void {
    try {
      atomicWriteJson(this.readStatePath, [...ids]);
    } catch (error) {
      this.log('[announcements] failed to write read state', { error: safeError(error) });
    }
  }
}
