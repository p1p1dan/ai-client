import { describe, expect, it } from 'vitest';
import { CHAT_MODELS, DEFAULT_CHAT_MODEL_ID, defaultModelId, ensureModelOptions } from '../models';

describe('chat models (T-08)', () => {
  it('exposes a non-empty catalog with stable short-name ids', () => {
    expect(CHAT_MODELS.length).toBeGreaterThan(0);
    for (const model of CHAT_MODELS) {
      expect(typeof model.id).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);
      expect(typeof model.label).toBe('string');
    }
  });

  it('falls back to the catalog default when no host default is reported', () => {
    expect(defaultModelId(null)).toBe(DEFAULT_CHAT_MODEL_ID);
    expect(defaultModelId(undefined)).toBe(DEFAULT_CHAT_MODEL_ID);
    expect(defaultModelId('')).toBe(DEFAULT_CHAT_MODEL_ID);
  });

  it('prefers a known host default over the catalog default', () => {
    expect(defaultModelId('haiku')).toBe('haiku');
    expect(defaultModelId('opus')).toBe('opus');
  });

  it('falls back to catalog default for an unknown host default (host still sets the id itself)', () => {
    expect(defaultModelId('grok-4.5')).toBe(DEFAULT_CHAT_MODEL_ID);
  });

  it('returns the catalog unchanged when host default is null or already known', () => {
    expect(ensureModelOptions(null)).toEqual(CHAT_MODELS);
    expect(ensureModelOptions(undefined)).toEqual(CHAT_MODELS);
    expect(ensureModelOptions('sonnet')).toEqual(CHAT_MODELS);
  });

  it('prepends an unknown host default as an extra option without dropping the catalog', () => {
    const options = ensureModelOptions('claude-sonnet-4-5');
    expect(options[0]).toEqual({ id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' });
    expect(options.length).toBe(CHAT_MODELS.length + 1);
    for (const model of CHAT_MODELS) {
      expect(options.some((option) => option.id === model.id)).toBe(true);
    }
  });
});
