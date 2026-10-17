import type { AgentModelOption } from '@shared/types/agentCatalog';
import { describe, expect, it } from 'vitest';
import { composerModelMenuModel } from '../composerModel';
import {
  AUTOMATIC_MODEL_ID,
  AUTOMATIC_MODEL_LABEL,
  filterChatModels,
  groupChatModels,
  modelCatalogForEngine,
  modelOptionsFor,
  modelScopeHint,
  modelVerification,
  reconcileModelSelection,
  resolveModelSelection,
  resolveResumeModel,
  seedDefaultModel,
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

describe('T3 declared input kinds', () => {
  it('modelOptionsFor carries input verbatim and leaves it absent when undeclared', () => {
    const options = modelOptionsFor([
      { id: 'p/vision', label: 'Vision', input: ['text', 'image'] },
      { id: 'p/plain', label: 'Plain' },
    ]);
    expect(options.find((option) => option.id === 'p/vision')?.input).toEqual(['text', 'image']);
    expect(options.find((option) => option.id === 'p/plain')).not.toHaveProperty('input');

    // …and the merged menu's rows keep it too (the last renderer-side hop).
    const menu = composerModelMenuModel({
      options,
      selectedModel: 'p/vision',
      selectedEffort: null,
    });
    const rows = menu.sections.find((section) => section.id === 'model')?.items ?? [];
    expect(rows.find((row) => row.id === 'p/vision')?.input).toEqual(['text', 'image']);
    expect(rows.find((row) => row.id === 'p/plain')).not.toHaveProperty('input');
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

/**
 * Route B, S-1 (claude-sdk-engine topics/s1-engine-selection.md decision 5):
 * a chat on the Claude engine stays on the plan route it started on, so its
 * picker offers only that route's models. Every other chat is unchanged.
 */
describe('S-1 model list of a Claude-engine chat', () => {
  const SDK_CATALOG: AgentModelOption[] = [
    { id: 'company/claude-opus-5', label: 'Claude Opus 5', sdkRoute: 'claude' },
    { id: 'company/claude-sonnet-5', label: 'Claude Sonnet 5', sdkRoute: 'claude' },
    { id: 'byok/claude-opus-5', label: 'Claude Opus 5 (own key)', sdkRoute: 'claude~2' },
    // An Anthropic-compatible GLM, and an OpenAI-style one: never the SDK's.
    { id: 'company/glm-5', label: 'GLM 5' },
    { id: 'china/glm-5.2', label: 'GLM 5.2' },
  ];
  const ids = (catalog: readonly AgentModelOption[]) => catalog.map((option) => option.id);

  it('offers a Claude-engine chat only the models of its own route, plus Automatic', () => {
    const offered = modelCatalogForEngine(SDK_CATALOG, {
      engine: 'claude-sdk',
      engineRoute: 'claude',
    });
    expect(ids(offered)).toEqual(['company/claude-opus-5', 'company/claude-sonnet-5']);
    expect(modelOptionsFor(offered).map((option) => option.id)).toEqual([
      AUTOMATIC_MODEL_ID,
      'company/claude-opus-5',
      'company/claude-sonnet-5',
    ]);
    expect(
      ids(modelCatalogForEngine(SDK_CATALOG, { engine: 'claude-sdk', engineRoute: 'claude~2' }))
    ).toEqual(['byok/claude-opus-5']);
  });

  it('falls back to every model the SDK engine serves when the route is not known', () => {
    expect(ids(modelCatalogForEngine(SDK_CATALOG, { engine: 'claude-sdk' }))).toEqual([
      'company/claude-opus-5',
      'company/claude-sonnet-5',
      'byok/claude-opus-5',
    ]);
    expect(
      ids(modelCatalogForEngine(SDK_CATALOG, { engine: 'claude-sdk', engineRoute: '' }))
    ).toHaveLength(3);
  });

  it('leaves every other chat, and a draft with no chat yet, on the whole catalog', () => {
    for (const session of [null, undefined, {}, { engine: 'dsh' as const }]) {
      expect(modelCatalogForEngine(SDK_CATALOG, session)).toBe(SDK_CATALOG);
    }
    // A DSH chat that somehow carries a route still gets everything.
    expect(modelCatalogForEngine(SDK_CATALOG, { engine: 'dsh', engineRoute: 'claude' })).toBe(
      SDK_CATALOG
    );
  });

  it('shows a stored model outside the list as an unverified leftover, never resetting it', () => {
    const offered = modelCatalogForEngine(SDK_CATALOG, {
      engine: 'claude-sdk',
      engineRoute: 'claude',
    });
    // The verification reads the offered list, so a GLM stored on this chat
    // (or a Claude model of another route) earns the mark.
    for (const stored of ['china/glm-5.2', 'byok/claude-opus-5']) {
      expect(
        modelVerification({ model: stored, catalog: offered, catalogAuthoritative: true }),
        stored
      ).toBe('unverified');
      const menu = composerModelMenuModel({
        options: modelOptionsFor(offered),
        selectedModel: stored,
        selectedEffort: 'default',
        unknownModelLabel: unverifiedModelLabel(stored),
      });
      const rows = menu.sections[0]?.items ?? [];
      expect(rows[0], stored).toMatchObject({
        id: stored,
        label: `${stored} · unverified`,
        selected: true,
        verified: false,
      });
    }
    // The selection itself still resolves from storage, whatever the list.
    expect(resolveModelSelection({ storedModel: 'china/glm-5.2', catalog: offered })).toBe(
      'china/glm-5.2'
    );
    expect(
      modelVerification({
        model: 'company/claude-opus-5',
        catalog: offered,
        catalogAuthoritative: true,
      })
    ).toBe('verified');
  });
});

describe('seedDefaultModel (issue #18)', () => {
  const catalog: AgentModelOption[] = [
    { id: 'plan/first', label: 'First' },
    { id: 'plan/second', label: 'Second' },
  ];
  it('names the first catalog model when the template has none and the catalog answered', () => {
    expect(
      seedDefaultModel({ agentDefaultModel: undefined, catalog, catalogAuthoritative: true })
    ).toBe('plan/first');
  });
  it('leaves a template that already names a model alone', () => {
    expect(
      seedDefaultModel({ agentDefaultModel: 'plan/second', catalog, catalogAuthoritative: true })
    ).toBeNull();
  });
  it('waits for an authoritative catalog, and seeds nothing from an empty one', () => {
    expect(
      seedDefaultModel({ agentDefaultModel: undefined, catalog, catalogAuthoritative: false })
    ).toBeNull();
    expect(
      seedDefaultModel({ agentDefaultModel: undefined, catalog: [], catalogAuthoritative: true })
    ).toBeNull();
  });
});
