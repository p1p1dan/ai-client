import { describe, expect, it } from 'vitest';
import {
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL_ID,
  defaultModelId,
  ensureModelOptions,
  resolveResumeModel,
} from '../models';

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

describe('resolveResumeModel (F9/R11: shared resume + live-send model formula)', () => {
  it('prefers an explicit per-session choice over the host default', () => {
    const getSessionModel = (id: string) => (id === 's1' ? 'opus' : null);
    expect(resolveResumeModel(getSessionModel, 's1', 'haiku')).toBe('opus');
  });

  it('falls back to the host-reported default when no explicit choice was made', () => {
    const getSessionModel = () => null;
    expect(resolveResumeModel(getSessionModel, 's1', 'opus')).toBe('opus');
  });

  it('falls back to the catalog default when neither an explicit choice nor a host default exists', () => {
    const getSessionModel = () => null;
    expect(resolveResumeModel(getSessionModel, 's1', null)).toBe(DEFAULT_CHAT_MODEL_ID);
    expect(resolveResumeModel(getSessionModel, 's1', undefined)).toBe(DEFAULT_CHAT_MODEL_ID);
  });

  // R11 (round-2 iteration-2 review): the regression this pins — the live
  // send path (ChatComposer.tsx's `runSend`) and the resume paths
  // (LeftNav.tsx / MessageTimeline.tsx) used to resolve the model through
  // TWO DIFFERENT formulas (`getSessionModel(id) ?? defaultModelId(null)`
  // on send vs. this function on resume), so a resume onto a non-default
  // Host model got silently re-pinned back to the catalog default
  // ('sonnet') on the very next send. Both call sites now route through
  // this exact function — this pins that a resume-then-send sequence, with
  // no explicit user choice made in between, resolves to the SAME model
  // both times.
  it('a resume-then-send sequence keeps the resumed model when the user made no explicit choice', () => {
    const sessionModels = new Map<string, string>();
    const getSessionModel = (id: string) => sessionModels.get(id) ?? null;
    const hostDefaultModel = 'opus';

    // Resume path: no explicit selection yet, so it pins onto the
    // Host-reported default.
    const resumeModel = resolveResumeModel(getSessionModel, 's1', hostDefaultModel);
    expect(resumeModel).toBe('opus');

    // The live send path immediately after — still no explicit user
    // choice — must resolve to the SAME model, not silently fall back to
    // the catalog default.
    const sendModel = resolveResumeModel(getSessionModel, 's1', hostDefaultModel);
    expect(sendModel).toBe(resumeModel);
    expect(sendModel).toBe('opus');
  });

  it('an explicit user choice made between resume and send wins over the host default on the send', () => {
    const sessionModels = new Map<string, string>();
    const getSessionModel = (id: string) => sessionModels.get(id) ?? null;
    resolveResumeModel(getSessionModel, 's1', 'opus'); // resume pins the default

    // User then explicitly picks a different model via ModelSelect.
    sessionModels.set('s1', 'haiku');

    expect(resolveResumeModel(getSessionModel, 's1', 'opus')).toBe('haiku');
  });
});
