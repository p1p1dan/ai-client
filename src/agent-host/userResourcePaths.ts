/**
 * R01 — lend pi the user's own skill and prompt-template directories.
 *
 * ## The gap this closes
 *
 * In managed mode Main starts the worker with `PI_CODING_AGENT_DIR` pointing at
 * `~/.pilab/pi-agent` and project trust withheld. Everything a user installed
 * the documented way — under `~/.pi/agent/` — is then invisible here, with no
 * message saying so. Official docs and models both point at `~/.pi`, so the
 * people most likely to hit this are the ones following instructions.
 *
 * ## Why paths and not the directory
 *
 * The resource loader takes absolute paths per resource kind, so we can hand it
 * exactly two directories instead of adopting the user's agent dir. That keeps
 * three things out of reach that adopting it (or symlinking) would drag in:
 *
 *  - **`auth.json` / `models.json`** — managed mode exists to use our own
 *    credential set; merging two is not a posture.
 *  - **`settings.json`** — its `packages` field makes pi run `npm install` for
 *    real (measured: an unknown name there fails the bootstrap with a registry
 *    404). Borrowing settings would re-open half of project trust.
 *  - **Write access** — pi rewrites `settings.json` as it runs. Adopting the
 *    directory would make this app edit the user's own pi CLI config.
 *
 * See [D01](../../docs/plantree/plans/pi-resources-and-commands/decisions/001-borrow-user-pi-resources-not-symlink.md).
 *
 * ## One value carries both the switch and the target
 *
 * Main decides whether to borrow (it is the side that knows the credential mode
 * and the user setting) and passes the source directory only when the answer is
 * yes. An absent value means "do not borrow" — there is no second state where a
 * path is present but disabled, and an older Main build that sends nothing
 * lands on the not-borrowing side, which is the conservative one.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface BorrowedResourcePaths {
  /** Absolute dirs to add to `resourceLoaderOptions.additionalSkillPaths`. */
  skills: string[];
  /** Absolute dirs for `additionalPromptTemplatePaths`. */
  promptTemplates: string[];
}

const EMPTY: BorrowedResourcePaths = { skills: [], promptTemplates: [] };

/** pi's own layout under an agent dir: `<agentDir>/{skills,prompts}`. */
const SKILLS_DIR = 'skills';
const PROMPTS_DIR = 'prompts';

/**
 * Same directory, tolerant of separators and relative segments.
 *
 * Case is deliberately NOT normalised. On Windows this can miss that two spellings
 * are the same directory, and the cost of that miss is a duplicate resource entry
 * — while case-folding on Linux would wrongly merge two real directories. The
 * harmless failure is the one worth keeping.
 */
function sameDirectory(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/**
 * Which of the user's resource directories to hand the loader.
 *
 * @param borrowFrom  The user's own pi agent dir, or undefined to borrow nothing.
 * @param activeAgentDir  The agent dir this session already loads from.
 *
 * A directory that does not exist is dropped rather than passed on: the loader
 * would report a diagnostic for it, and "you have no skills installed" is not a
 * problem worth a warning.
 */
export function resolveBorrowedResourcePaths(
  borrowFrom: string | undefined,
  activeAgentDir: string
): BorrowedResourcePaths {
  const source = borrowFrom?.trim();
  if (!source) return EMPTY;
  // Non-managed mode already points at this directory. Borrowing it again would
  // load every skill twice, so the guard lives here rather than only in Main —
  // this module can then be trusted on its own.
  if (sameDirectory(source, activeAgentDir)) return EMPTY;

  const skills = join(source, SKILLS_DIR);
  const promptTemplates = join(source, PROMPTS_DIR);
  return {
    skills: existsSync(skills) ? [skills] : [],
    promptTemplates: existsSync(promptTemplates) ? [promptTemplates] : [],
  };
}

/** True when there is nothing to add, so the caller can omit the fields entirely. */
export function hasBorrowedPaths(paths: BorrowedResourcePaths): boolean {
  return paths.skills.length > 0 || paths.promptTemplates.length > 0;
}
