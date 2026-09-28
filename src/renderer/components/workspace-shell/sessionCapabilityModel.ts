/**
 * T026 — what the sidebar's capability entry shows for the active chat.
 *
 * ## It projects the session's own inventory
 *
 * This panel used to list the pi extensions a worker had loaded, then (after
 * cutover-03) MCP servers, skills, prompt templates and sub-agent definitions.
 * dsh-rebase P1-16e (decision 104 rule 4) narrowed it to the skill count: the
 * DSH engine reports `skills` alone (decisions 099 rule 12 and 113), because
 * this build has no MCP bridge, no prompt templates and no custom sub-agent
 * definitions. Rows for those would only ever say "not reported".
 *
 * ## "Not reported" is not "none"
 *
 * - `reported: false` — nothing has answered for this session yet (no live
 *   worker). The panel says so in words.
 * - `skills: null` — an inventory arrived without a skill count (no skill
 *   service, or it could not be read). Also "not reported".
 * - `0` — the skill service ran and genuinely found nothing.
 *
 * Rendering the first two as `0` is what made someone reinstall a working
 * plugin, so the distinction is load-bearing rather than pedantic.
 *
 * Pure so vitest (node env, `.ts` only) can cover it.
 */

import type { WorkerCapabilityInventory } from '@shared/types/workerRpc';

export interface SessionCapabilityView {
  /** False when nothing has reported for this session. */
  reported: boolean;
  skills: number | null;
}

const NOTHING: SessionCapabilityView = { reported: false, skills: null };

export function deriveSessionCapabilities(
  capabilities: WorkerCapabilityInventory | null
): SessionCapabilityView {
  if (!capabilities) return NOTHING;
  return { reported: true, skills: capabilities.skills ?? null };
}
