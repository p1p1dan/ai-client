/**
 * H/21 P1 — deciding whether to ask an existing `pi` user to bring their setup
 * over, and what to tick by default.
 *
 * The H/19 point-check found that users never walk to the settings pane on
 * their own: after U1 gave this app its own agent directory, every old session
 * failed to start and nobody found the migration that fixes it. P0 made the
 * failure point at the pane; this is the other half — offer it once, up front,
 * before the user hits the failure at all.
 *
 * Why the rules live here rather than in the dialog: vitest runs `node` in this
 * repo and only collects `.ts`, so anything decided inside a `.tsx` cannot be
 * asserted. "Do we ask at all" is exactly the kind of decision that has to be.
 */

import type { MigrationItem, MigrationItemKind, MigrationPlan } from '@shared/agentMigration';
import type { LegacyImportProject } from '@shared/types';

/**
 * One label per kind. Display text, not a domain fact — kept next to the
 * prompt rules so the dialog and the settings pane cannot name the same kind
 * two different ways.
 */
export function migrationKindLabel(kind: MigrationItemKind): string {
  switch (kind) {
    case 'skills':
      return 'Skills';
    case 'promptTemplates':
      return 'Prompt templates';
    case 'agentsFile':
      return 'AGENTS.md';
    case 'providers':
      return 'AI services';
    case 'sessions':
      return 'Conversation history';
  }
}

/** True when running the migration on this item would copy at least one thing. */
export function itemWouldCopy(item: MigrationItem): boolean {
  return item.total > item.conflicts + item.blocked;
}

/**
 * Everything that would actually copy something, pre-ticked.
 *
 * The decision was "five items default all checked, one Start button": the
 * checkboxes are there to take things OUT, not to make the user assemble the
 * obvious answer. An item that can only skip or fail is left unticked, because
 * ticking it would promise a copy that cannot happen.
 */
export function defaultMigrationSelection(plan: MigrationPlan): MigrationItemKind[] {
  return plan.items.filter(itemWouldCopy).map((item) => item.kind);
}

/**
 * Kinds whose copy moves a secret into this app's own store.
 *
 * This is the whole reason the migration is not silent (decision one, option A
 * rejected): copying an API key into this app's vault is a consent question,
 * not a technical one. The dialog has to say so wherever one of these is
 * ticked.
 */
export const MIGRATION_SECRET_KINDS: readonly MigrationItemKind[] = ['providers'];

export function selectionCarriesSecrets(kinds: readonly MigrationItemKind[]): boolean {
  return kinds.some((kind) => MIGRATION_SECRET_KINDS.includes(kind));
}

export interface MigrationPromptInput {
  /** `null` while the inspection is still running, or when it failed. */
  plan: MigrationPlan | null;
  /** The user has already been shown this dialog once, on any earlier launch. */
  asked: boolean;
}

/**
 * Whether to open the one-time migration dialog.
 *
 * Read "first launch" as "the first launch that had something to offer" — a
 * user who upgrades into this build is not on a first launch by any other
 * definition, and they are precisely the person the H/19 defect hits. So the
 * trigger is the offer being non-empty, remembered once it has been made.
 *
 * An all-conflicts plan is NOT offered. Every item would skip, so the Start
 * button would run a migration that copies nothing and reports success — worse
 * than not asking, because it also burns the one time we get to ask.
 */
export function shouldPromptMigration(input: MigrationPromptInput): boolean {
  if (input.asked) return false;
  const { plan } = input;
  if (!plan || !plan.sourceExists || plan.nothingToDo) return false;
  return defaultMigrationSelection(plan).length > 0;
}

/**
 * Whether the Claude Code / Codex history guide still has something to say.
 *
 * The guide is a pointer to the import pane, so it is done once the user has
 * used that pane: any project with a completed import (`importedSessionCount`,
 * counted by Main from the import manifest) settles it, the same way a
 * finished Pi copy settles the Pi offer. Before this the dialog opened on
 * "any project exists", so someone who had already imported was asked again on
 * every launch (1.0.4 field report, 2026-10-08).
 *
 * Not "every session imported": people import a few conversations on purpose,
 * and new sessions keep appearing while they still use Claude Code / Codex —
 * a rule built on that would never stop asking either. The pane itself shows
 * per-session import state; "Don't ask again" remains for people who never
 * want to import.
 */
export function legacyGuideWanted(projects: readonly LegacyImportProject[]): boolean {
  if (projects.length === 0) return false;
  return !projects.some((project) => (project.importedSessionCount ?? 0) > 0);
}
