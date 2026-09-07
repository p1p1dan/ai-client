import type { AgentModelOption } from '@shared/types/agentCatalog';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_MODEL_ID,
  AUTOMATIC_MODEL_LABEL,
  filterChatModels,
  groupChatModels,
  modelOptionsFor,
  modelScopeHint,
  modelVerification,
  reconcileModelSelection,
  resolveModelSelection,
  resolveResumeModel,
  toWireModel,
  unverifiedModelLabel,
} from '../models';

const CATALOG: AgentModelOption[] = [
  { id: 'glm/glm-5', label: 'GLM 5', tags: ['国产', 'reasoning'] },
  { id: 'dan/model', label: 'Dan Model', tags: ['Hosted'] },
];

describe('T25 Pi model grouping', () => {
  it('groups by first tag, preserves order, and searches secondary tags', () => {
    const grouped = groupChatModels(
      modelOptionsFor([
        ...CATALOG,
        { id: 'local/plain', label: 'Plain' },
        { id: 'glm/other', label: 'Other', tags: ['国产'] },
      ])
    );
    expect(grouped.direct.map((item) => item.id)).toEqual([AUTOMATIC_MODEL_ID]);
    expect(grouped.groups.map((group) => group.label)).toEqual(['国产', 'Hosted', 'Other models']);
    expect(filterChatModels(grouped.groups[0]?.items ?? [], 'reasoning')).toHaveLength(1);
  });

  it('keeps an unverified current selection directly reachable', () => {
    expect(
      groupChatModels([
        { id: AUTOMATIC_MODEL_ID, label: AUTOMATIC_MODEL_LABEL },
        {
          id: 'missing/model',
          label: unverifiedModelLabel('missing/model'),
          verified: false,
        },
      ]).direct.map((item) => item.id)
    ).toEqual([AUTOMATIC_MODEL_ID, 'missing/model']);
  });
});

describe('Pi model selection', () => {
  it('uses Automatic when nothing is selected and omits it on the wire', () => {
    expect(resolveModelSelection({ storedModel: null, catalog: CATALOG })).toBe(AUTOMATIC_MODEL_ID);
    expect(toWireModel(AUTOMATIC_MODEL_ID)).toBeUndefined();
    expect(toWireModel(' glm/glm-5 ')).toBe('glm/glm-5');
  });

  it('keeps stored Pi ids even when the refreshed catalog omits them', () => {
    expect(resolveModelSelection({ storedModel: 'missing/model', catalog: CATALOG })).toBe(
      'missing/model'
    );
    expect(
      reconcileModelSelection({
        storedModel: 'missing/model',
        catalog: CATALOG,
        catalogLoaded: true,
        pairChanged: false,
        current: 'missing/model',
      })
    ).toBe('missing/model');
  });

  it('re-resolves when the session changes and keeps current while catalog is loading', () => {
    expect(
      reconcileModelSelection({
        storedModel: 'dan/model',
        catalog: CATALOG,
        catalogLoaded: true,
        pairChanged: true,
        current: 'glm/glm-5',
      })
    ).toBe('dan/model');
    expect(
      reconcileModelSelection({
        storedModel: null,
        catalog: [],
        catalogLoaded: false,
        pairChanged: false,
        current: 'glm/glm-5',
      })
    ).toBe('glm/glm-5');
  });

  it('resolves the same stored/default value for send and resume', () => {
    const getStored = () => 'glm/glm-5';
    const getEmpty = () => null;
    expect(resolveResumeModel(getStored, 's1', 'dan/model')).toBe('glm/glm-5');
    expect(resolveResumeModel(getEmpty, 's1', 'dan/model')).toBe('dan/model');
    expect(modelScopeHint()).toMatch(/next turn/);
  });
});

describe('F07 model verification state', () => {
  const verify = (model: string, catalogAuthoritative: boolean, list = CATALOG) =>
    modelVerification({ model, catalog: list, catalogAuthoritative });

  it('says nothing while no catalog has answered', () => {
    // The reported defect: startup, empty catalog, a stored model. The old
    // membership-only test made this `unverified`.
    expect(verify('grok/grok-4.6', false, [])).toBe('pending');
    expect(verify('grok/grok-4.6', false)).toBe('pending');
  });

  it('confirms a model the answered catalog lists', () => {
    expect(verify('glm/glm-5', true)).toBe('verified');
  });

  it('marks a model only once an answered catalog omits it', () => {
    expect(verify('missing/model', true)).toBe('unverified');
    expect(verify('missing/model', true, [])).toBe('unverified');
  });

  it('never marks the Automatic sentinel — there is no id to corroborate', () => {
    expect(verify(AUTOMATIC_MODEL_ID, true, [])).toBe('verified');
    expect(verify(AUTOMATIC_MODEL_ID, false, [])).toBe('verified');
  });

  it('keeps the displayed selection independent of the verdict', () => {
    // F07 changes what is CLAIMED, never what is shown or sent: a pre-catalog
    // reconcile still keeps the same value it always kept.
    expect(
      reconcileModelSelection({
        current: 'grok/grok-4.6',
        storedModel: 'grok/grok-4.6',
        catalog: [],
        catalogLoaded: false,
        pairChanged: false,
      })
    ).toBe('grok/grok-4.6');
  });

  it('does not carry a verdict across a session switch', () => {
    // The pair moved, so the value is re-resolved from the NEW pair's storage;
    // a verdict computed for the previous model can have no bearing on it.
    const next = reconcileModelSelection({
      current: 'missing/model',
      storedModel: 'glm/glm-5',
      catalog: CATALOG,
      catalogLoaded: true,
      pairChanged: true,
    });
    expect(next).toBe('glm/glm-5');
    expect(verify(next, true)).toBe('verified');
  });
});
