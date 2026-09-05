/**
 * U04 — what the sidebar's plugin entry shows.
 *
 * Two independent facts, deliberately kept apart:
 *
 * 1. **Which extensions pi loaded** — reported by the worker at bootstrap
 *    (`chat:listSessionExtensions`). `null` means no live worker has answered
 *    for this session yet, which is NOT the same as "no plugins" and must not
 *    render as `0`.
 * 2. **MCP readiness** — read out of the status lines extensions publish
 *    through `ui.setStatus`, exactly the way pix derives its own badge
 *    (`mcpStatusFromExtensionUi`). There is no MCP API to ask: an MCP
 *    extension writes something like `MCP 2/3 servers`, and the badge is that
 *    text parsed. No status line → no badge, never a fabricated `0/0`.
 *
 * Pure so vitest (node env, `.ts` only) can cover it.
 */

import type { WorkerExtensionInfo } from '@shared/types/workerRpc';
import type { ExtensionUiStatusEntry } from '@/components/chat/extensionUiDisplayModel';

export interface McpReadiness {
  ready: number;
  total: number;
  /** `2/3` — what the badge renders. */
  badge: string;
  /** The extension's own status text, shown as the tooltip. */
  detail: string;
}

export interface PluginInventoryView {
  /** Failed first (the ones needing attention), then by name. */
  plugins: WorkerExtensionInfo[];
  failedCount: number;
  /** False when no worker has reported — the panel says so instead of "none". */
  reported: boolean;
  mcp: McpReadiness | null;
  /** Sidebar badge: MCP readiness when known, else the plugin count, else null. */
  badge: string | null;
}

/**
 * Does this status line talk about MCP servers?
 *
 * Key OR text, because neither is standardized: an extension may key its
 * status `mcp` and write `2/3`, or key it `servers` and write `MCP: 2/3 ready`.
 * pix accepts both for the same reason.
 */
function looksLikeMcpStatus(key: string, text: string): boolean {
  if (/mcp/i.test(key)) return true;
  return /mcp/i.test(text) || /\bservers?\b/i.test(text);
}

export function mcpReadinessFromStatuses(
  statuses: Record<string, ExtensionUiStatusEntry>,
  sessionId: string | null
): McpReadiness | null {
  if (!sessionId) return null;
  // Sorted so two matching status lines always pick the same winner rather
  // than whichever the object happened to enumerate first this render.
  const entries = Object.entries(statuses)
    .filter(([, entry]) => entry.sessionId === sessionId)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const [, entry] of entries) {
    const text = entry.text.trim();
    if (!text || !looksLikeMcpStatus(entry.key, text)) continue;
    const match = /(\d+)\s*\/\s*(\d+)/.exec(text);
    if (!match) continue;
    const ready = Number.parseInt(match[1] as string, 10);
    const total = Number.parseInt(match[2] as string, 10);
    if (!Number.isFinite(ready) || !Number.isFinite(total) || total <= 0) continue;
    return { ready, total, badge: `${ready}/${total}`, detail: text };
  }
  return null;
}

export function derivePluginInventory(input: {
  /** `null` = this session has no live worker to have loaded anything. */
  extensions: WorkerExtensionInfo[] | null;
  statuses: Record<string, ExtensionUiStatusEntry>;
  sessionId: string | null;
}): PluginInventoryView {
  const mcp = mcpReadinessFromStatuses(input.statuses, input.sessionId);
  const reported = input.extensions !== null;
  const plugins = [...(input.extensions ?? [])].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  const failedCount = plugins.filter((plugin) => !plugin.ok).length;

  return {
    plugins,
    failedCount,
    reported,
    mcp,
    // MCP readiness wins the badge: `2/3` says something a plain count cannot,
    // and it is the number pix's entry shows too. With nothing reported there
    // is no badge at all — `0` would be a claim we cannot back.
    badge: mcp ? mcp.badge : reported && plugins.length > 0 ? String(plugins.length) : null,
  };
}
