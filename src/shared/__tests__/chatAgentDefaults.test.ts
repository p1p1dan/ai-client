import {
  agentDefaultEffort,
  agentDefaultModel,
  sanitizeChatAgentDefaults,
  withAgentPreference,
} from '@shared/models/chatAgentDefaults';
import { PI_AGENT } from '@shared/types/agentWire';
import { describe, expect, it } from 'vitest';

describe('Pi-only chat defaults', () => {
  it('reads the scalar Pi shape', () => {
    expect(sanitizeChatAgentDefaults({ model: 'glm/glm-5', effort: 'high' })).toEqual({
      model: 'glm/glm-5',
      effort: 'high',
    });
  });

  it('migrates a legacy per-agent Pi row and drops runtime selection', () => {
    expect(
      sanitizeChatAgentDefaults({
        lastAgent: 'codex',
        byAgent: {
          pi: { model: 'dan/model', effort: 'xhigh' },
          codex: { model: 'legacy/codex' },
        },
      })
    ).toEqual({ model: 'dan/model', effort: 'xhigh' });
  });

  it('updates and clears model/effort without a per-agent map', () => {
    const first = withAgentPreference({}, PI_AGENT, { model: 'glm/glm-5', effort: 'high' });
    expect(first).toEqual({ model: 'glm/glm-5', effort: 'high' });
    const cleared = withAgentPreference(first, PI_AGENT, { model: undefined });
    expect(cleared).toEqual({ effort: 'high' });
    expect(agentDefaultModel(cleared, PI_AGENT)).toBeUndefined();
    expect(agentDefaultEffort(cleared, PI_AGENT)).toBe('high');
  });
});
