import { describe, expect, it } from 'vitest';
import { sanitizeLegacyAiSettings } from '../migration';
import type { SettingsState } from '../types';

describe('Pi-only AI settings migration', () => {
  it('removes legacy provider controls and drops bare model ids', () => {
    const persisted = {
      commitMessageGenerator: {
        enabled: true,
        provider: 'claude-code',
        model: 'claude-sonnet-4-5',
        reasoningEffort: 'high',
        claudeEffort: 'medium',
        bare: { command: 'custom-ai' },
        prompt: 'commit',
      },
      codeReview: {
        enabled: true,
        provider: 'codex',
        model: 'pilab/company-model',
        reasoningEffort: 'xhigh',
        prompt: 'review',
      },
    } as unknown as Partial<SettingsState>;

    const migrated = sanitizeLegacyAiSettings(persisted) as Record<string, unknown>;
    expect(migrated.commitMessageGenerator).toEqual({
      enabled: true,
      prompt: 'commit',
    });
    expect(migrated.codeReview).toEqual({
      enabled: true,
      model: 'pilab/company-model',
      prompt: 'review',
    });
  });
});
