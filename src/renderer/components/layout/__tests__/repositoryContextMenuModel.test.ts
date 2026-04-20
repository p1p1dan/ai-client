import type { CustomAgent } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { buildRepositoryContextMenuModel } from '../repositoryContextMenuModel';

const t = (value: string) => value;

describe('buildRepositoryContextMenuModel', () => {
  it('includes the shared repository actions used by the columns layout', () => {
    const model = buildRepositoryContextMenuModel({
      t,
      agentSettings: {},
      customAgents: [],
      agentDetectionStatus: {},
      hapiEnabled: false,
    });

    expect(model.primaryActions.map((action) => action.key)).toEqual([
      'open-folder',
      'copy-path',
      'open-terminal',
    ]);
    expect(model.secondaryActions.map((action) => action.key)).toEqual(['repository-settings']);
    expect(model.destructiveAction.key).toBe('remove-repository');
  });

  it('sorts and labels enabled agents the same way as the repository sidebar', () => {
    const model = buildRepositoryContextMenuModel({
      t,
      agentSettings: {
        claude: { enabled: true, isDefault: true },
        codex: { enabled: true, isDefault: false },
        'codex-hapi': { enabled: true, isDefault: false },
        'codex-happy': { enabled: true, isDefault: false },
        custom: { enabled: true, isDefault: false },
        gemini: { enabled: true, isDefault: false },
      },
      customAgents: [{ id: 'custom', name: 'My Agent', command: 'custom-agent' } satisfies CustomAgent],
      agentDetectionStatus: {
        codex: { installed: true, detectedAt: 1 },
        custom: { installed: true, detectedAt: 1 },
        gemini: { installed: false, detectedAt: 1 },
      },
      hapiEnabled: true,
    });

    expect(model.agentActions).toEqual([
      { agentId: 'claude', label: 'Claude' },
      { agentId: 'codex', label: 'Codex' },
      { agentId: 'codex-hapi', label: 'Codex (Hapi)' },
      { agentId: 'codex-happy', label: 'Codex (Happy)' },
      { agentId: 'custom', label: 'My Agent' },
    ]);
  });
});
