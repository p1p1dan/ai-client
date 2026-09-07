/**
 * F09 — startup announcements: the contract, and every decision that can be
 * made without touching disk or the network.
 *
 * ## Where the endpoint lives, and why it is unauthenticated
 *
 * The announcement endpoint is the onboarding service's, the same service the
 * model catalog derives its default address from (plan D05) — one deployment to
 * point at, not two. Unlike the catalog it carries NO `Authorization` header
 * (user ruling, 2026-09-07): announcements have to reach the people most likely
 * to need them, including someone whose login has just expired and who is
 * staring at a sign-in screen wondering why. The trade is stated rather than
 * hidden — the endpoint's contents are public to anyone who can reach the
 * service, so nothing user-specific or confidential may ever be served here.
 *
 * ## Why the parsing lives in `shared` and not in the service
 *
 * The repo's vitest is node-env and collects only `*.test.ts`; a validator
 * written inline in an Electron service is reachable only through mocks of
 * `net.fetch` and `fs`. Everything that DECIDES something — what is a valid
 * announcement, which ones are new, whether to open the dialog — is a pure
 * function here, and the Main service is left with I/O.
 */

/** Path appended to the onboarding service address. */
export const ANNOUNCEMENTS_PATH = '/api/v1/announcements';

/** How long Main waits before giving up. Startup must never block on this. */
export const ANNOUNCEMENTS_TIMEOUT_MS = 5000;

/** Cap on how many announcements one response may contribute. */
export const ANNOUNCEMENTS_MAX_ITEMS = 20;

/** Cap on a single announcement's body, in characters. */
export const ANNOUNCEMENT_MAX_BODY_CHARS = 4000;

/** Cap on the whole response, in bytes. */
export const ANNOUNCEMENTS_MAX_BYTES = 256 * 1024;

/** File names under the managed app-state root. */
export const ANNOUNCEMENTS_CACHE_FILE_NAME = 'announcements.json';
export const ANNOUNCEMENTS_READ_STATE_FILE_NAME = 'announcements-read.json';

/**
 * How loudly an announcement presents itself.
 *
 * Three levels rather than a boolean because "the service is degraded" and
 * "there is a new release" are not the same message, and a build that models
 * them identically has no way to grow the distinction later without changing
 * the wire format. An unrecognised value degrades to `info` rather than being
 * rejected: a newer service inventing a fourth level must not cost the user the
 * announcement itself.
 */
export type AnnouncementSeverity = 'info' | 'warning' | 'critical';

export interface Announcement {
  /** Stable across re-publishes; this is what "already seen" is keyed by. */
  id: string;
  title: string;
  /** Plain text. Deliberately NOT markdown or HTML — see `parseAnnouncements`. */
  body: string;
  /** ISO-8601, when the service states one. */
  publishedAt?: string;
  severity: AnnouncementSeverity;
}

/** Where the list on screen came from. Mirrors `AgentModelCatalog`'s `source`. */
export type AnnouncementSource = 'remote' | 'cache' | 'unavailable';

export interface AnnouncementsResult {
  announcements: Announcement[];
  source: AnnouncementSource;
  /** When the underlying answer was fetched; `null` when there never was one. */
  fetchedAt: number | null;
  /** Ids the user has already seen. Drives the bell's unread mark. */
  readIds: string[];
  /** Short, safe-to-log reason the fetch did not succeed. */
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSeverity(value: unknown): AnnouncementSeverity {
  return value === 'warning' || value === 'critical' ? value : 'info';
}

function readTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turn whatever the endpoint answered into announcements this app will show.
 *
 * Lenient about SHAPE, strict about CONTENT. An entry missing an id or a title
 * is dropped rather than rendered as an empty card — a blank dialog on startup
 * is worse than no dialog — while an unknown severity, an extra field, or a
 * missing `publishedAt` all pass through, because none of them stop the message
 * from being readable.
 *
 * `body` is carried as PLAIN TEXT and the renderer prints it as such. Accepting
 * markup here would mean rendering remote HTML inside the app's own chrome, and
 * an announcement channel is exactly the surface where that is least
 * acceptable — the caps below exist for the same reason: a response cannot make
 * the app unusable by being enormous.
 *
 * Duplicate ids collapse to the FIRST occurrence, so a service that repeats an
 * entry cannot make one message appear twice in the list.
 */
export function parseAnnouncements(payload: unknown): Announcement[] {
  const raw = isRecord(payload) ? payload.announcements : payload;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Announcement[] = [];
  for (const entry of raw) {
    if (out.length >= ANNOUNCEMENTS_MAX_ITEMS) break;
    if (!isRecord(entry)) continue;
    const id = readTrimmed(entry.id);
    const title = readTrimmed(entry.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const publishedAt = readTrimmed(entry.publishedAt);
    out.push({
      id,
      title,
      body: readTrimmed(entry.body).slice(0, ANNOUNCEMENT_MAX_BODY_CHARS),
      ...(publishedAt ? { publishedAt } : {}),
      severity: readSeverity(entry.severity),
    });
  }
  return out;
}

/** Ids in `announcements` the user has not seen yet, in list order. */
export function unreadAnnouncementIds(
  announcements: readonly Announcement[],
  readIds: readonly string[]
): string[] {
  const read = new Set(readIds);
  return announcements.filter((entry) => !read.has(entry.id)).map((entry) => entry.id);
}

/**
 * Whether the startup dialog opens.
 *
 * The confirmed product ruling is "**every** launch, automatically" — so this
 * is deliberately NOT gated on unread state. A user who read an announcement
 * yesterday sees it again today, and that is the intent: these are the messages
 * the operator wants in front of everyone, and an app that quietly stopped
 * showing them after the first dismissal would be a different product decision
 * than the one that was made.
 *
 * What IS gated: an empty list opens nothing (a modal saying "no news" on every
 * launch would be the fastest way to teach people to dismiss it unread), and a
 * failed fetch with nothing cached opens nothing either — startup must not
 * announce its own plumbing.
 *
 * Read state still exists, and this function is why it is not load-bearing
 * here: it drives the bell's unread mark, which is the surface where "have I
 * seen this" is a useful question.
 */
export function shouldOpenAnnouncementsOnStartup(result: {
  announcements: readonly Announcement[];
  source: AnnouncementSource;
}): boolean {
  if (result.source === 'unavailable') return false;
  return result.announcements.length > 0;
}

/**
 * Merge newly-seen ids into the stored set, keeping only ids that still exist.
 *
 * The pruning matters more than the merging: without it the read set grows
 * without bound and, worse, an id the service RETIRES and later reuses would
 * arrive already marked read. Bounded by what the service currently serves,
 * the set can only ever describe announcements that exist.
 */
export function mergeReadAnnouncementIds(input: {
  readIds: readonly string[];
  seenIds: readonly string[];
  announcements: readonly Announcement[];
}): string[] {
  const live = new Set(input.announcements.map((entry) => entry.id));
  const merged = new Set<string>();
  for (const id of [...input.readIds, ...input.seenIds]) {
    if (live.has(id)) merged.add(id);
  }
  return [...merged];
}
