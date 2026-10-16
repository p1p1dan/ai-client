/**
 * Route B, S-2 (plan topic s2-permission-modes.md §4): what each of Claude's
 * five modes does on the Claude Agent SDK engine, as claude.exe 2.1.300 was
 * measured to behave. Dictionary keys. One source for the permission menu and
 * the plan review card, so the two cannot drift apart. Never a deny list
 * (ruling 13): this engine keeps none of PiLab's.
 */

import type { PermissionPreset } from '@shared/types/runtimePermission';

export const SDK_MODE_DESCRIPTIONS: Readonly<Record<PermissionPreset, string>> = {
  ask: 'Reads in the workspace run without asking; edits, commands that change something and anything outside the workspace ask first.',
  'accept-edits':
    'File edits in the workspace and simple file commands run without asking; other commands still ask.',
  // Ruling 20: the CLI's own plan mode; nothing refuses a change for it.
  plan: "Explores and plans, then presents the plan for your review. It is asked not to change anything meanwhile; a change it tries anyway goes to Auto's check or to you.",
  auto: 'Reads and workspace edits run without asking; other calls pass a safety check first. What it blocks, or cannot check, does not run; after several blocks in a row it asks you.',
  bypass:
    'Runs calls without asking; a few dangerous ones, such as deleting the workspace, still ask.',
};

/** The second confirmation of Auto (the scope sentence follows it). */
export const SDK_AUTO_CONFIRMATION =
  'Calls other than reads and workspace edits pass a safety check first: most go through without asking, risky ones are blocked, and if the check is unavailable they do not run. The check is extra model traffic through your model service. ';

/** The second confirmation of Bypass permissions. */
export const SDK_BYPASS_CONFIRMATION =
  'Calls run without asking; a few dangerous ones, such as deleting the workspace, still ask. This is never saved as the default for new chats.';
