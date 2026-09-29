/**
 * Persisted chat session index entry (Main-side, survives restart).
 *
 * `session-index.json` is a BARE JSON ARRAY of these and must stay one: the
 * loader is a plain `JSON.parse` + `for-of` with a warn-and-start-empty catch,
 * so wrapping the file in an envelope makes an older build throw, start empty,
 * and write `[]` back on its next flush — every session silently gone. Version
 * markers, if ever needed, can only be optional per-entry fields.
 */
import type { PiLeafCheckpoint } from './sessionHistory';

/**
 * Load-time health of `session-index.json`.
 *
 * The loader used to answer "file missing" and "file unreadable" with the same
 * empty table, and the next write turned the second one into the first: the
 * whole table is rewritten on every flush, so one unreadable row set became a
 * file holding only the session created after the failure. The three states
 * below are what the loader distinguishes now, and what a degraded-state
 * notice in the UI needs in order to say which one happened.
 */
export type SessionIndexHealth =
  | { status: 'ok' }
  | {
      /**
       * The file's CONTENT was unusable (not JSON, not an array, or rows
       * without a `sessionId`). It was preserved at `backupPath` and the table
       * rebuilt from whatever parsed, so writing again is safe.
       */
      status: 'repaired';
      backupPath: string;
      droppedRows: number;
      reason: string;
    }
  | {
      /**
       * The file could not be read at all (EACCES/EIO/EBUSY — on Windows an
       * antivirus or backup tool holding it is the common cause) or could not
       * be backed up. Its rows are presumed intact on disk, so this process
       * refuses to write and every mutation fails loudly instead.
       */
      status: 'unreadable';
      reason: string;
    };

export interface SessionIndexEntry {
  sessionId: string;
  /**
   * Pi's durable resume handle once known. Opaque outside the worker; never
   * infer validity or ownership from the string shape.
   */
  runtimeIdentity?: string;
  /** T33 active Pi branch checkpoint, validated against the current physical file tail. */
  piLeaf?: PiLeafCheckpoint;
  /** T34 immutable import ownership proof used by crash reconciliation. */
  legacyImport?: {
    sourceKind: 'claude-code' | 'codex';
    /**
     * The name is ABI. The pi session id of a 1.0.x import; since P1-9f (decision
     * 056) the id the DSH session of the import and its stub are named after,
     * `aiclient-<logical id>`.
     */
    targetPiSessionId: string;
    dedupeKey: string;
  };
  /**
   * S2 (b): which agent runs this session. Deliberately typed `string` and not
   * `AgentWireName` — this is the DISK side, where a value written by a newer
   * build must survive being read by an older one. Exactly one place turns it
   * into a binding (`resolveAgentWireName`, called from the renderer's
   * `mergeSessionIndex`); normalizing it on load instead would make the very
   * next flush rewrite `agent` into every legacy row on disk, i.e. turn a
   * compatible read into an irreversible write migration.
   */
  agent?: string;
  /**
   * U13 (D04): this row's `workspacePath` is an isolated scratch directory, not
   * a project folder the user picked — i.e. an "unbound" chat (U05).
   *
   * Written by Main from `ScratchWorkspaceService.isScratchPath`, never by the
   * renderer, matching U05-c's rule that the renderer cannot declare a session
   * unbound. Optional and absent-when-false on purpose: the file is a bare JSON
   * array (see the header), so the only compatible way to add a fact is an
   * optional per-entry field, and rows written before this field existed keep
   * meaning "unknown" rather than being backfilled on load (same reasoning as
   * `agent` above — normalizing on load turns a compatible read into an
   * irreversible write migration).
   *
   * Consumed by the renderer's `mergeSessionIndex`, which would otherwise drop
   * these rows as orphans: their path matches no `ChatWorkspace`, so the chat
   * became invisible after a restart even though its history was still on disk.
   */
  unbound?: boolean;
  workspacePath: string;
  title: string;
  model?: string;
  /** Epoch ms of last meaningful activity (create/resume/turn end/rename/archive). */
  updatedAt: number;
  archived: boolean;
  /**
   * dsh-rebase P1-9d (decision 051): this `dsh` row is a legacy pi chat
   * migrated on its first continue. The pi row it was is kept, field for
   * field, under `legacySessionId` (with `migratedTo` naming this row), so a
   * 1.0.x build rolled back to still shows and continues it.
   */
  migratedFrom?: SessionMigratedFrom;
  /**
   * dsh-rebase P1-9d (decision 051): on the kept legacy pi row, the logical id
   * its chat continues under as a DSH session. Written by the migration only.
   */
  migratedTo?: string;
}

/** Where a migrated chat came from (decision 051); the source as the host read it. */
export interface SessionMigratedFrom {
  /** Key of the kept legacy pi row (`legacyRowKeyFor`). */
  legacySessionId: string;
  /** The pi file the legacy row names, which was converted (or its 1.0.x copy was). */
  runtimeIdentity: string;
  sourceSha256: string;
  sourceBytes: number;
  sourceMtimeMs: number;
  /** Epoch ms of the index transaction. */
  migratedAt: number;
  /** `pi-dsh/<converter version>`. */
  converter: string;
}

/**
 * A row as `chat:listSessions` answers it (P1-9d, decision 051). Legacy pi
 * rows a migrated chat came from are left out while their file is as it was
 * migrated; one whose file changed since (continued in 1.0.x after a rollback)
 * is listed with `migrationDiverged`. Derived on every list, never written.
 */
export type SessionIndexListEntry = SessionIndexEntry & { migrationDiverged?: true };
