/**
 * decision 008 — which layers of on-disk configuration this runtime may read.
 *
 * Claude Code's CLI and Agent SDK both expose a `settingSources` list with the
 * same three values, and omitting it means "all of them". This module is the
 * one place that rule is written down, so the four consumers (project
 * instructions, permission policy, MCP config, skills/prompts discovery) cannot
 * drift apart on what `user` means or on what an absent list does.
 *
 * Two things that are NOT in the list, on purpose:
 *
 * - Managed files that ship with the app — `<agentDir>/AGENTS.md` and the
 *   bundled fail-closed permission policy — are not a "source" a caller can
 *   switch off. They are the product's own floor, and a run that could drop
 *   them would be a run with no floor at all (decision 008 clause 3).
 * - Programmatic options (`permissions.scopes`, an explicitly supplied server
 *   list) are not files and never pass through here.
 */

export type SettingSource = 'user' | 'project' | 'local';

/** Every value, which is also what an omitted `settingSources` means. */
export const ALL_SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

/** The answer each consumer actually needs: three booleans, trust folded in. */
export interface SettingSourceGate {
  user: boolean;
  project: boolean;
  local: boolean;
}

export interface SettingSourceOptions {
  /**
   * Absent means all three, matching the official default. An empty array is
   * NOT the same thing — it means the caller asked for none of them, which is
   * what a fixed probe suite wants.
   */
  settingSources?: readonly SettingSource[];
  /**
   * decision 008 clause 5 — an untrusted checkout has `project` and `local`
   * closed no matter what the list says. Folded in here rather than repeated at
   * four call sites, because "trusted" and "asked for" have to be ANDed
   * everywhere and an `||` typo in one of them is invisible.
   */
  projectTrusted?: boolean;
}

export function resolveSettingSources(options: SettingSourceOptions = {}): SettingSourceGate {
  const asked = options.settingSources;
  const enabled = (source: SettingSource) => asked === undefined || asked.includes(source);
  const trusted = options.projectTrusted === true;
  return {
    user: enabled('user'),
    project: trusted && enabled('project'),
    local: trusted && enabled('local'),
  };
}
