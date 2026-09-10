/**
 * H/19 U2 — bringing what the user has in `~/.pi/agent` over to this app's own
 * agent directory.
 *
 * ## Copy, never move
 *
 * The user's directory belongs to their `pi` CLI. Everything here reads it and
 * writes only into this app's directory, so the migration is safe to run twice
 * and leaves the user's own setup exactly as it was. That is also why there is
 * no "undo": nothing was taken away.
 *
 * ## Why an explicit plan, and not a copy on first launch
 *
 * The destination can already hold a file with the same name — one this app
 * wrote, or one an earlier run copied and the user then edited. Overwriting
 * that silently would destroy work that only exists here. So the inspection
 * step names every item and says which ones collide, the user picks what to
 * bring over, and a collision is SKIPPED unless they say otherwise.
 */

/** The five things worth carrying over. Everything else in `~/.pi/agent` stays put. */
export type MigrationItemKind =
  | 'skills'
  | 'promptTemplates'
  | 'agentsFile'
  | 'providers'
  | 'sessions';

export interface MigrationEntry {
  /** What the user sees: a skill directory name, a template file, a service name. */
  name: string;
  /** True when the destination already has this one. */
  conflict: boolean;
  /**
   * Present when this entry cannot be brought over at all, whatever the user
   * picks — a model service whose key is an unset environment variable, say.
   * Stated rather than hidden: a silently shorter list looks like a successful
   * migration.
   */
  blocked?: string;
}

export interface MigrationItem {
  kind: MigrationItemKind;
  /** Absolute path being read. Shown so the user can check it is the right one. */
  sourcePath: string;
  /** Absolute destination, or the words for one when there is no single path. */
  targetPath: string;
  /** Capped at {@link MIGRATION_ENTRY_DISPLAY_CAP}; `total` is the real count. */
  entries: MigrationEntry[];
  total: number;
  conflicts: number;
  /** Entries with a `blocked` reason. */
  blocked: number;
}

export interface MigrationPlan {
  sourceDir: string;
  targetDir: string;
  /** False for a brand-new user: `~/.pi/agent` is not there at all. */
  sourceExists: boolean;
  /** Only the kinds that have something in them; an empty kind is not listed. */
  items: MigrationItem[];
  /** True when there is nothing left to bring over. */
  nothingToDo: boolean;
}

/**
 * What to do about an entry the destination already has.
 *
 * `skip` is the default everywhere. `overwrite` is a deliberate answer to a
 * question the user was shown the names for.
 */
export type MigrationConflictPolicy = 'skip' | 'overwrite';

export interface MigrationRequest {
  kinds: MigrationItemKind[];
  onConflict: MigrationConflictPolicy;
}

export interface MigrationOutcome {
  kind: MigrationItemKind;
  copied: number;
  skipped: number;
  overwritten: number;
  failed: Array<{ name: string; error: string }>;
}

export interface MigrationResult {
  outcomes: MigrationOutcome[];
  /** The plan re-inspected after the run, so the page redraws from fact. */
  plan: MigrationPlan;
}

/** Enough names to recognise the set; the count is always exact. */
export const MIGRATION_ENTRY_DISPLAY_CAP = 200;

export function isMigrationItemKind(value: unknown): value is MigrationItemKind {
  return (
    value === 'skills' ||
    value === 'promptTemplates' ||
    value === 'agentsFile' ||
    value === 'providers' ||
    value === 'sessions'
  );
}
