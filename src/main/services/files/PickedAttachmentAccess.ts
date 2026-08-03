/**
 * D4 (round-5): the one-shot allowlist that keeps `file:readAttachment` from
 * becoming a general "read any file's raw bytes" primitive for the renderer.
 *
 * `file:read` already hands the renderer the TEXT of an arbitrary path, so the
 * new channel is not a brand-new class of access — but raw bytes of a binary
 * file are strictly more valuable than a decoded text buffer, and there is no
 * reason for that power to be general. The main process therefore issues the
 * permission itself: only paths the user JUST picked in a native dialog can be
 * read, each of them once.
 *
 * Shape is copied from `LocalFileAccess`: keyed by owner (the requesting
 * `WebContents` id) so a destroyed window takes its grants with it, and using
 * that module's own path normalisation so the two cannot disagree about what
 * "the same file" means on Windows/macOS.
 *
 * A grant is NOT just a path (round-5 S1). It carries the identity and the
 * contents fingerprint the file had at pick time — `{dev, ino, size, mtimeMs}`
 * — because a path is a name, not a file: between the pick and the read the
 * renderer can `file:copy` other bytes over that name (no attachment
 * authorisation guards the copy/rename/move channels), or the target of a
 * picked symlink can be re-pointed. The read verifies the snapshot against the
 * fd it actually opened, so "the path is allowed" can never be stretched into
 * "whatever now lives at that path is allowed".
 *
 * Lifecycle, stated exactly:
 *  - a successful `dialog:openFiles` ADDS its paths for that owner. It does
 *    not replace the previous set — replacing it would kill reads still in
 *    flight from an earlier pick, and the entries it would evict were all
 *    genuinely picked by the user anyway.
 *  - a cancelled dialog changes nothing at all (the ⊕ honesty rule: cancel has
 *    no effects, main-side included).
 *  - serving a path CONSUMES it, so a replayed/duplicated read attempt is
 *    refused like any other path. Consumption alone is NOT a lifetime bound
 *    though: a path the renderer never reads (an unsupported kind, a batch
 *    abandoned mid-flight) would otherwise sit here for as long as the window
 *    lives. Two things bound it instead — the TTL below, swept lazily on every
 *    register/take, and the navigation/destroy hooks in `dialog.ts`.
 *  - `clearPickedAttachmentPaths(owner)` on `webContents` destruction AND on
 *    `did-start-navigation`: a reload keeps the WebContents id but discards
 *    the renderer state that was going to consume these grants.
 */
import { normalizePathForComparison } from './LocalFileAccess';

/**
 * How long an unread grant survives, in ms.
 *
 * Sized for a human gesture, not for a session: the renderer starts reading
 * the moment the dialog closes, so 30 s is orders of magnitude more than the
 * legitimate flow needs while keeping the window in which a swapped file could
 * even be attempted short.
 */
export const PICKED_ATTACHMENT_GRANT_TTL_MS = 30_000;

/** What the file WAS when the user picked it — verified again at read time. */
export interface AttachmentGrantSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface PickedAttachmentGrant {
  /**
   * The path exactly as the native dialog reported it.
   *
   * The read opens THIS string, never the one the renderer passed: the
   * renderer's argument is only ever a lookup key, so a normalisation quirk
   * (case folding on macOS/Windows) can never widen what is opened.
   */
  path: string;
  snapshot: AttachmentGrantSnapshot;
}

interface GrantEntry extends PickedAttachmentGrant {
  expiresAt: number;
}

/** Owner id -> normalised path -> the grant that may still be spent on it. */
const grantsByOwner = new Map<number, Map<string, GrantEntry>>();

/**
 * Drop everything past its TTL, everywhere.
 *
 * Swept lazily on every register/take rather than on a timer: this map is tiny
 * (one gesture's worth of paths), and a timer would keep the main process
 * awake to expire a permission that is already unusable.
 */
function sweepExpiredGrants(now: number): void {
  for (const [owner, entries] of grantsByOwner) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    if (entries.size === 0) grantsByOwner.delete(owner);
  }
}

/** Record a native-dialog result as readable-once for this owner. */
export function registerPickedAttachmentPaths(
  grants: readonly PickedAttachmentGrant[],
  owner: number
): void {
  const now = Date.now();
  sweepExpiredGrants(now);
  if (grants.length === 0) return;

  const entries = grantsByOwner.get(owner) ?? new Map<string, GrantEntry>();
  for (const grant of grants) {
    // Re-picking the same path refreshes its snapshot and its clock, which is
    // right: it is a fresh act of consent about the file as it is now.
    entries.set(normalizePathForComparison(grant.path), {
      path: grant.path,
      snapshot: grant.snapshot,
      expiresAt: now + PICKED_ATTACHMENT_GRANT_TTL_MS,
    });
  }
  grantsByOwner.set(owner, entries);
}

/**
 * Consume the grant for `filePath`, returning it or `null`.
 *
 * "Take", not "check": the read that follows is the single use this grant was
 * issued for, and leaving it behind would turn a one-shot permission into a
 * standing one for as long as the window lives.
 */
export function takePickedAttachmentPath(
  filePath: string,
  owner: number
): PickedAttachmentGrant | null {
  sweepExpiredGrants(Date.now());

  const entries = grantsByOwner.get(owner);
  if (!entries) return null;

  const key = normalizePathForComparison(filePath);
  const entry = entries.get(key);
  if (!entry) return null;

  entries.delete(key);
  if (entries.size === 0) grantsByOwner.delete(owner);
  return { path: entry.path, snapshot: entry.snapshot };
}

/** Drop every outstanding grant for an owner (navigation, or `webContents` gone). */
export function clearPickedAttachmentPaths(owner: number): void {
  grantsByOwner.delete(owner);
}

/** Test/diagnostic helper: how many live grants an owner still holds. */
export function pendingPickedAttachmentCount(owner: number): number {
  sweepExpiredGrants(Date.now());
  return grantsByOwner.get(owner)?.size ?? 0;
}
