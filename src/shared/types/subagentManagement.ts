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
