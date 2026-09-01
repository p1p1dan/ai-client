/**
 * Persisted chat session index entry (Main-side, survives restart).
 *
 * `session-index.json` is a BARE JSON ARRAY of these and must stay one: the
 * loader is a plain `JSON.parse` + `for-of` with a warn-and-start-empty catch,
 * so wrapping the file in an envelope makes an older build throw, start empty,
 * and write `[]` back on its next flush — every session silently gone. Version
 * markers, if ever needed, can only be optional per-entry fields.
 */
import type { SessionPermissionPreference } from './runtimeEvents';
import type { PiLeafCheckpoint } from './sessionHistory';

export interface SessionIndexEntry {
  sessionId: string;
  /**
   * The agent's own resume handle once known (enables resume). Opaque: it is
   * a Claude Code session id, a Codex threadId, or whatever the next agent
   * uses, and it is only interpretable paired with `agent`. Never infer the
   * agent from this string's shape.
   */
  runtimeIdentity?: string;
  /** T33 active Pi branch checkpoint, validated against the current physical file tail. */
  piLeaf?: PiLeafCheckpoint;
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
  /**
   * D48 S3 §5.5-2 — the permission posture this session was STARTED under,
   * captured from the "Chat agent defaults" template at first send.
   *
   * Optional per-entry, like every other addition to this file: an older build
   * reads the row, ignores the key and rewrites it verbatim, and a row written
   * before this field existed simply has none (the runtime's own safe constant
   * then applies, i.e. today's behaviour).
   *
   * It exists so that resume does NOT re-read the template. Editing the global
   * default must not retroactively change the posture of a chat that started
   * months ago — that would be a silent security-posture change to a
   * conversation the user is not even looking at. Typed as the shared union for
   * the Main-side readers' benefit, but re-validated on every read: this is
   * disk content, which a user or a future build can have written.
   *
   * Written twice by design: once here at first send, and again by S4's
   * mid-session change (an explicit choice INSIDE this session, which is a
   * different thing from the template leaking in).
   */
  permissionPreference?: SessionPermissionPreference;
  /** Epoch ms of last meaningful activity (create/resume/turn end/rename/archive). */
  updatedAt: number;
  archived: boolean;
}
