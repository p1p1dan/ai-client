import { describe, expect, it } from 'vitest';
import { deriveSessionCapabilities } from '../sessionCapabilityModel';

/**
 * The sidebar capability panel's model.
 *
 * cutover-03 made it project the session's own inventory instead of a pi
 * extension list; dsh-rebase P1-16e (decision 104 rule 4) narrowed it to the
 * skill count, the only member the DSH engine reports (decisions 099 rule 12
 * and 113). Replaces `pluginInventoryModel.test.ts`.
 *
 * The property that keeps the panel honest is the three-way split — nobody
 * reported / an inventory without a skill count / a count of zero — so that is
 * what is pinned here.
 */
describe('deriveSessionCapabilities', () => {
  it('says "nobody reported" when there is no inventory at all', () => {
    expect(deriveSessionCapabilities(null)).toEqual({ reported: false, skills: null });
  });

  it('reads the DSH engine’s inventory: the skill count', () => {
    expect(deriveSessionCapabilities({ skills: 2 })).toEqual({ reported: true, skills: 2 });
  });

  it('keeps a reported zero apart from an absent count', () => {
    expect(deriveSessionCapabilities({ skills: 0 })).toEqual({ reported: true, skills: 0 });
    // `{}` is what the bridge answers when the skill service is missing or
    // could not be read: reported, but no count — rendered "not reported".
    expect(deriveSessionCapabilities({})).toEqual({ reported: true, skills: null });
  });

  it('projects nothing but the skill count, whatever else an inventory carries', () => {
    // The 1.0.x engine also reported MCP servers, templates and sub-agent
    // definitions. The panel no longer has rows for them, and since P1-12 the
    // inventory type no longer has the members, so they must not leak into the
    // view either. Built outside the call: the type would refuse them inline.
    const legacy = {
      skills: 1,
      promptTemplates: 3,
      subagents: 4,
      mcpServers: [{ name: 'alpha', ok: true, toolCount: 2 }],
    };
    const view = deriveSessionCapabilities(legacy);
    expect(view).toEqual({ reported: true, skills: 1 });
  });
});
