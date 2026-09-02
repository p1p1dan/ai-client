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
    sourceKind: 'claude-code';
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
  workspacePath: string;
  title: string;
  model?: string;
  /** Epoch ms of last meaningful activity (create/resume/turn end/rename/archive). */
  updatedAt: number;
  archived: boolean;
}
