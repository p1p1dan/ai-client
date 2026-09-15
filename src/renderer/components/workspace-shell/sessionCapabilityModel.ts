/**
 * T026 — what the sidebar's capability entry shows for the active chat.
 *
 * ## It projects OUR runtime, not pi's extension list
 *
 * This panel used to list the pi extensions a worker had loaded, and to read
 * MCP readiness out of the status lines those extensions published through
 * `ui.setStatus`. Neither producer exists any more: P6-5 retired the engine
 * that loaded pi extensions, so the list was permanently empty and the badge
 * never appeared even with real MCP servers connected (cutover-03). The panel
 * now shows the session's own capabilities, reported by its bootstrap.
 *
 * ## "Not reported" is not "none"
 *
 * Three states, kept apart on purpose:
 *
 * - `reported: false` — nothing has answered for this session yet (no live
 *   worker, or a build that reports no inventory). The panel says so in words.
 * - a member that is `null` — this graph has no producer for it at all, e.g. a
 *   worker built without the MCP bridge. Also "not reported".
 * - `[]` or `0` — a producer ran and genuinely found nothing.
 *
 * Rendering the first two as `0` is what made someone reinstall a working
 * plugin, so the distinction is load-bearing rather than pedantic.
 *
 * Pure so vitest (node env, `.ts` only) can cover it.
 */

import type { WorkerCapabilityInventory, WorkerMcpServerInfo } from '@shared/types/workerRpc';

export interface McpReadiness {
  ready: number;
  total: number;
  /** `2/3` — what the summary row renders. */
  badge: string;
}

export interface SessionCapabilityView {
  /** False when nothing has reported for this session. */
  reported: boolean;
  /** `null` = no MCP producer; `[]` = a bridge that found no servers. */
  mcpServers: WorkerMcpServerInfo[] | null;
  /** `null` unless at least one server was declared — `0/0` is not a fact. */
  mcp: McpReadiness | null;
  skills: number | null;
  promptTemplates: number | null;
  subagents: number | null;
}

const NOTHING: SessionCapabilityView = {
  reported: false,
  mcpServers: null,
  mcp: null,
  skills: null,
  promptTemplates: null,
  subagents: null,
};

export function deriveSessionCapabilities(
  capabilities: WorkerCapabilityInventory | null
): SessionCapabilityView {
  if (!capabilities) return NOTHING;
  // Failed first — those are the rows needing attention — then by name, so the
  // order does not shuffle between two renders of the same session.
  const servers = capabilities.mcpServers
    ? [...capabilities.mcpServers].sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? 1 : -1;
        return a.name.localeCompare(b.name);
      })
    : null;
  const ready = servers?.filter((server) => server.ok).length ?? 0;
  return {
    reported: true,
    mcpServers: servers,
    mcp:
      servers && servers.length > 0
        ? { ready, total: servers.length, badge: `${ready}/${servers.length}` }
        : null,
    skills: capabilities.skills ?? null,
    promptTemplates: capabilities.promptTemplates ?? null,
    subagents: capabilities.subagents ?? null,
  };
}
