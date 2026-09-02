import type { AgentModelOption } from '@shared/types/agentCatalog';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_MODEL_ID,
  AUTOMATIC_MODEL_LABEL,
  filterChatModels,
  groupChatModels,
  modelOptionsFor,
  modelScopeHint,
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
