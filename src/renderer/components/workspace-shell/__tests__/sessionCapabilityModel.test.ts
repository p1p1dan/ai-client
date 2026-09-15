import type { WorkerCapabilityInventory } from '@shared/types/workerRpc';
import { describe, expect, it } from 'vitest';
import { deriveSessionCapabilities } from '../sessionCapabilityModel';

/**
 * cutover-03 — the sidebar panel's model, after it stopped projecting pi.
 *
 * It used to list the extensions a worker had loaded and read MCP readiness out
 * of `ui.setStatus` status lines. P6-5 left both producers with nobody to
 * produce: the list was permanently `[]`, which the old model rendered as a
 * definite "0 plugins", and the badge never appeared even with MCP servers
 * connected. Replaces `pluginInventoryModel.test.ts`.
 *
 * The property that makes the panel honest is the three-way split — nobody
 * reported / no producer for this member / a producer that found nothing — so
 * most of what is pinned here is that split.
 */
describe('deriveSessionCapabilities', () => {
  it('says "nobody reported" when there is no inventory at all', () => {
    const view = deriveSessionCapabilities(null);
    expect(view.reported).toBe(false);
    expect(view.mcp).toBeNull();
    expect(view.mcpServers).toBeNull();
    expect(view.skills).toBeNull();
    expect(view.promptTemplates).toBeNull();
    expect(view.subagents).toBeNull();
  });

  it('keeps "this build has no MCP bridge" apart from "the bridge found none"', () => {
    // The distinction cutover-03 is about: rendering the first as `0` is what
    // made someone reinstall a plugin that was working.
    const noBridge = deriveSessionCapabilities({ skills: 3 });
    expect(noBridge.reported).toBe(true);
    expect(noBridge.mcpServers).toBeNull();
    expect(noBridge.mcp).toBeNull();

    const emptyBridge = deriveSessionCapabilities({ mcpServers: [] });
    expect(emptyBridge.reported).toBe(true);
    expect(emptyBridge.mcpServers).toEqual([]);
    // Still no badge: `0/0` is not a readiness fact.
    expect(emptyBridge.mcp).toBeNull();
  });

  it('keeps a reported zero apart from an absent count', () => {
    const view = deriveSessionCapabilities({ skills: 0, subagents: 0 });
    expect(view.skills).toBe(0);
    expect(view.subagents).toBe(0);
    expect(view.promptTemplates).toBeNull();
  });

  it('counts readiness from the servers themselves, not from a status line', () => {
    const inventory: WorkerCapabilityInventory = {
      mcpServers: [
        { name: 'alpha', ok: true, toolCount: 4 },
        { name: 'beta', ok: false, toolCount: 0, error: 'ECONNREFUSED' },
        { name: 'gamma', ok: true, toolCount: 1 },
      ],
    };
    expect(deriveSessionCapabilities(inventory).mcp).toEqual({
      ready: 2,
      total: 3,
      badge: '2/3',
    });
  });

  it('sorts failures first, then by name, so two renders agree', () => {
    const inventory: WorkerCapabilityInventory = {
      mcpServers: [
        { name: 'zeta', ok: true, toolCount: 1 },
        { name: 'alpha', ok: true, toolCount: 2 },
        { name: 'broken', ok: false, toolCount: 0 },
      ],
    };
    const names = () => deriveSessionCapabilities(inventory).mcpServers?.map((s) => s.name);
    expect(names()).toEqual(['broken', 'alpha', 'zeta']);
    expect(names()).toEqual(['broken', 'alpha', 'zeta']);
  });

  it('does not reorder the caller’s array in place', () => {
    const mcpServers = [
      { name: 'zeta', ok: true, toolCount: 1 },
      { name: 'broken', ok: false, toolCount: 0 },
    ];
    deriveSessionCapabilities({ mcpServers });
    expect(mcpServers.map((s) => s.name)).toEqual(['zeta', 'broken']);
  });
});
