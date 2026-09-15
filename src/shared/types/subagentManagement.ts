/**
 * P5-2-5 — what the subagent management UI sends and receives.
 *
 * One row per definition, carrying EVERY executable field rather than the ones
 * the current UI happens to render. That is the contract's round-trip rule in
 * the type system: a save request is built from the row it came from, so a
 * field with no control yet (`permission` today) travels out and back instead
 * of being dropped by the shape of the DTO.
 *
 * The prompt body is carried too. It is the largest field by far, and a list
 * endpoint that omitted it would need a second round trip to open an editor —
 * but definitions are capped at 32 KiB each and 64 per install, so the whole
 * catalog is bounded at 2 MiB in the worst case and a few KiB in practice.
 */

import type {
  SubagentDefinitionSource,
  SubagentModelPin,
  SubagentPermission,
  SubagentThinkingLevel,
} from '../subagentDefinition';
import type { MigrationNote } from '../subagentMigration';

export interface SubagentRow {
  name: string;
  description: string;
  /** Canonical (capitalised) tool names, as the document spells them. */
  tools: string[];
  model?: SubagentModelPin;
  thinkingLevel?: SubagentThinkingLevel;
  permission?: SubagentPermission;
  /** Absent means unlimited turns. */
  maxTurns?: number;
  prompt: string;
  source: SubagentDefinitionSource;
  /** Absent for a builtin, which has no file to reveal. */
  filePath?: string;
  /** This install's switch. Never written into the document. */
  enabled: boolean;
  /** Non-fatal parse notes — a clamped cap, an unknown tool that was ignored. */
  warnings?: string[];
}

export interface SubagentCatalogView {
  rows: SubagentRow[];
  /** Documents that do not load, with the reason. Kept visible, never dropped. */
  broken: { filePath: string; name: string; errors: string[] }[];
  /** Where a new definition is written. Shown so the user can find it. */
  directory: string;
  /** Disabled names that match no definition any more. */
  staleDisabled: string[];
}

/**
 * One save.
 *
 * `previousName` is what separates a rename from a copy: absent means "save
 * under this name", present and different means "this document used to be
 * called that, and should stop being".
 */
export interface SubagentSaveRequest {
  name: string;
  previousName?: string;
  description: string;
  tools: string[];
  model?: SubagentModelPin;
  thinkingLevel?: SubagentThinkingLevel;
  permission?: SubagentPermission;
  maxTurns?: number;
  prompt: string;
}

/**
 * P5-2-5 / subagent-data-01 — one legacy `<agentDir>/agents/*.md` document, as
 * the import preview describes it.
 *
 * Deliberately WITHOUT the document body that would be written. The preview is
 * for deciding, and the renderer deciding for the user is the failure this
 * whole flow exists to avoid: the import re-reads and re-previews from disk, so
 * what gets written is what Main computed, never what the page sent back.
 */
export interface SubagentImportRow {
  /** Absolute path of the legacy document. Shown so the source is nameable. */
  filePath: string;
  /** Native definition name it would land under. */
  name: string;
  /** Where it would be written. Absent when nothing can be written. */
  targetPath?: string;
  /** A definition of this name is already in the catalog (builtin included). */
  collides: boolean;
  /** Something needs a decision first; nothing will be written for this one. */
  blocked: boolean;
  /** Per-field account: kept / adapted / dropped / conflict. */
  notes: MigrationNote[];
}

export interface SubagentImportPreview {
  /** The directory scanned, so "nothing found" says where it looked. */
  sourceDirectory: string;
  rows: SubagentImportRow[];
}

export interface SubagentImportResult {
  /** Names actually written, in the order they were written. */
  imported: string[];
  /** Names asked for and not written, each with the reason it was not. */
  skipped: { name: string; reason: string }[];
  /** The catalog after the import, same rule as every other mutation here. */
  catalog: SubagentCatalogView;
}
