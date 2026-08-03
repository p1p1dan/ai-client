import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPickedAttachmentPaths,
  PICKED_ATTACHMENT_GRANT_TTL_MS,
  type PickedAttachmentGrant,
  pendingPickedAttachmentCount,
  registerPickedAttachmentPaths,
  takePickedAttachmentPath,
} from '../PickedAttachmentAccess';

/**
 * D4 / round-5 S3: the security nails of `file:readAttachment`'s allowlist.
 *
 * This module is the ONLY thing standing between the renderer and "read the
 * raw bytes of any path you like", so what is asserted here is not behaviour
 * but the shape of a permission: issued by main, scoped to one window, spent
 * once, and expiring on its own if nobody spends it.
 *
 * The module keeps process-global state, so every test starts by clearing the
 * owners it uses — a leaked grant between cases would make the next one pass
 * for the wrong reason.
 */

const OWNER = 4001;
const OTHER_OWNER = 4002;

/** Distinct fingerprints, so "wrong grant returned" cannot pass as "right". */
function grantFor(path: string, ino: number): PickedAttachmentGrant {
  return { path, snapshot: { dev: 66, ino, size: 1024 + ino, mtimeMs: 1_700_000_000_000 + ino } };
}

beforeEach(() => {
  clearPickedAttachmentPaths(OWNER);
  clearPickedAttachmentPaths(OTHER_OWNER);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PickedAttachmentAccess grants (D4)', () => {
  // The whole point of "take": a grant is spent by the read it was issued for.
  // If it survived, an attacker-controlled renderer could replay one picked
  // path forever, and a swap-then-reread would only have to win a race once.
  it('serves a grant exactly once and refuses the replay', () => {
    registerPickedAttachmentPaths([grantFor('/home/dan/shot.png', 11)], OWNER);

    const first = takePickedAttachmentPath('/home/dan/shot.png', OWNER);
    expect(first?.snapshot.ino).toBe(11);
    expect(takePickedAttachmentPath('/home/dan/shot.png', OWNER)).toBeNull();
    expect(pendingPickedAttachmentCount(OWNER)).toBe(0);
  });

  it('refuses a path the user never picked', () => {
    registerPickedAttachmentPaths([grantFor('/home/dan/shot.png', 11)], OWNER);

    expect(takePickedAttachmentPath('/etc/shadow', OWNER)).toBeNull();
    expect(takePickedAttachmentPath('/home/dan/.ssh/id_ed25519', OWNER)).toBeNull();
    // ...and the real grant is untouched by the attempts.
    expect(pendingPickedAttachmentCount(OWNER)).toBe(1);
  });

  // Grants are per-WebContents: one window's pick must never authorise
  // another window's read, or a background renderer could piggyback on a
  // dialog the user answered somewhere else entirely.
  it('isolates owners from each other', () => {
    registerPickedAttachmentPaths([grantFor('/home/dan/shot.png', 11)], OWNER);

    expect(takePickedAttachmentPath('/home/dan/shot.png', OTHER_OWNER)).toBeNull();
    expect(pendingPickedAttachmentCount(OTHER_OWNER)).toBe(0);
    expect(takePickedAttachmentPath('/home/dan/shot.png', OWNER)?.path).toBe('/home/dan/shot.png');
  });

  // The teardown hook (`destroyed` / `did-start-navigation` in dialog.ts):
  // a page that is gone cannot have reads in flight.
  it('drops everything an owner holds on clear', () => {
    registerPickedAttachmentPaths([grantFor('/a/one.png', 21), grantFor('/a/two.png', 22)], OWNER);
    expect(pendingPickedAttachmentCount(OWNER)).toBe(2);

    clearPickedAttachmentPaths(OWNER);

    expect(pendingPickedAttachmentCount(OWNER)).toBe(0);
    expect(takePickedAttachmentPath('/a/one.png', OWNER)).toBeNull();
  });

  // A second pick ADDS. Replacing would kill reads still in flight from the
  // first one, and every entry it evicted was genuinely picked by the user.
  it('appends a second pick instead of replacing the first', () => {
    registerPickedAttachmentPaths([grantFor('/a/one.png', 21)], OWNER);
    registerPickedAttachmentPaths([grantFor('/a/two.png', 22)], OWNER);

    expect(pendingPickedAttachmentCount(OWNER)).toBe(2);
    expect(takePickedAttachmentPath('/a/one.png', OWNER)?.snapshot.ino).toBe(21);
    expect(takePickedAttachmentPath('/a/two.png', OWNER)?.snapshot.ino).toBe(22);
  });

  // Lookup goes through `LocalFileAccess`'s normalisation, so the renderer
  // cannot be locked out by a cosmetically different spelling of the path it
  // was just handed — and cannot smuggle a DIFFERENT file in by spelling it
  // creatively either, since `..` resolves before the comparison.
  it('matches an equivalent spelling of the same path', () => {
    registerPickedAttachmentPaths([grantFor('/a/b.png', 31)], OWNER);

    expect(takePickedAttachmentPath('/a/./b.png', OWNER)?.snapshot.ino).toBe(31);
  });

  // The returned path is the one MAIN recorded, never the renderer's string:
  // the argument's only job is to find the grant.
  it('hands back the path the dialog produced, not the one asked for', () => {
    registerPickedAttachmentPaths([grantFor('/a/b.png', 31)], OWNER);

    expect(takePickedAttachmentPath('/a/../a/b.png', OWNER)?.path).toBe('/a/b.png');
  });

  // A grant nobody spends must not outlive the gesture that created it: an
  // unsupported-kind path is never read, and without a TTL its entry would sit
  // here as a standing permission for the lifetime of the window.
  it('expires an unspent grant after the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00Z'));
    registerPickedAttachmentPaths([grantFor('/a/stale.png', 41)], OWNER);

    vi.advanceTimersByTime(PICKED_ATTACHMENT_GRANT_TTL_MS - 1);
    expect(pendingPickedAttachmentCount(OWNER)).toBe(1);

    vi.advanceTimersByTime(1);
    expect(pendingPickedAttachmentCount(OWNER)).toBe(0);
    expect(takePickedAttachmentPath('/a/stale.png', OWNER)).toBeNull();
  });

  // The sweep is lazy and global, so it has to be surgical: expiring one
  // gesture's leftovers must not cancel a pick the user made ten seconds ago
  // and is still reading.
  it('sweeps only what is actually expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00Z'));
    registerPickedAttachmentPaths([grantFor('/a/old.png', 51)], OWNER);

    vi.advanceTimersByTime(PICKED_ATTACHMENT_GRANT_TTL_MS - 5_000);
    registerPickedAttachmentPaths([grantFor('/a/fresh.png', 52)], OWNER);
    expect(pendingPickedAttachmentCount(OWNER)).toBe(2);

    vi.advanceTimersByTime(5_000);
    expect(pendingPickedAttachmentCount(OWNER)).toBe(1);
    expect(takePickedAttachmentPath('/a/old.png', OWNER)).toBeNull();
    expect(takePickedAttachmentPath('/a/fresh.png', OWNER)?.snapshot.ino).toBe(52);
  });

  // Re-picking the same file is a fresh act of consent about the file as it is
  // NOW, so the snapshot (and the clock) has to move with it — otherwise a
  // legitimately edited file would be refused by its own stale fingerprint.
  it('refreshes the snapshot when the same path is picked again', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00Z'));
    registerPickedAttachmentPaths([grantFor('/a/b.png', 61)], OWNER);

    vi.advanceTimersByTime(PICKED_ATTACHMENT_GRANT_TTL_MS - 1_000);
    registerPickedAttachmentPaths([grantFor('/a/b.png', 62)], OWNER);

    vi.advanceTimersByTime(2_000);
    expect(pendingPickedAttachmentCount(OWNER)).toBe(1);
    expect(takePickedAttachmentPath('/a/b.png', OWNER)?.snapshot.ino).toBe(62);
  });
});
