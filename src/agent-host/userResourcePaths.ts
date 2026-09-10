/**
 * The one instruction every session appends about where skills get installed.
 *
 * ## What used to be here
 *
 * R01's "borrow" mechanism: managed mode moved `PI_CODING_AGENT_DIR` to the
 * app's own directory, so anything the user had installed under `~/.pi/agent/`
 * stopped being visible, and this module handed the resource loader that
 * directory's `skills/`, `prompts/` and `AGENTS.md` as extra paths to read.
 *
 * H/19 removed it. Both modes now run out of the app's agent directory, and the
 * user's own resources are brought over ONCE, by explicit copy, through
 * `main/services/agentMigration`. A permanent read-through was the wrong shape
 * for two reasons: it only ever covered text resources (never settings,
 * credentials or plugins), so the directory was half-loaded in a way nobody
 * could see; and edits made through this app had nowhere to go, because the
 * source directory is the user's and this app must not write it.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultSkillInstallInstructions(
  home = process.env.HOME || process.env.USERPROFILE || homedir()
): string {
  return `When asked to install a skill, use ${join(home, '.agents', 'skills')} as the default installation directory, with one <skill-name>/SKILL.md per skill. This shared location is loaded by managed GUI, local GUI, and Pi TUI sessions. Use another destination only when the user explicitly requests it.`;
}
