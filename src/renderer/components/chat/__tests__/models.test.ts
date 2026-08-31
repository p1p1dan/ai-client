import { CLAUDE_SEED_MODELS, CODEX_SEED_MODELS } from '@shared/models/seedCatalog';
import { type AgentWireName, CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_MODEL_ID,
  AUTOMATIC_MODEL_LABEL,
  CLAUDE_MODEL_SCOPE_HINT,
  CODEX_MODEL_SCOPE_HINT,
  filterChatModels,
  groupChatModels,
  isLegacyClaudeShortName,
  modelOptionsFor,
  modelScopeHint,
  reconcileModelSelection,
  resolveModelSelection,
  resolveResumeModel,
  toWireModel,
  unverifiedModelLabel,
} from '../models';

/**
 * D48 S2 §4.3/§4.4 — the model SELECTION truth tables (B5 / B11 / B12 / B16 /
 * B17 pure halves).
 *
 * The pre-D48 suite for this file asserted the OPPOSITE of most of this: that a
 * missing selection resolves to `sonnet`, and that a Host default outside the
 * catalog is automatically a legal option. Both rules were deleted — by 改判 #10
 * and §4.3-3 respectively — so the assertions are replaced rather than extended.
 * Keeping them would pin the behaviour this slice exists to remove.
 */

const CLAUDE_CATALOG = CLAUDE_SEED_MODELS;
const CODEX_CATALOG = CODEX_SEED_MODELS;

/** A stored-selection reader backed by a plain map, keyed the way storage is. */
function storedModels(entries: Record<string, string>) {
  return (sessionId: string, agent: AgentWireName): string | null =>
    entries[`${sessionId}:${agent}`] ?? null;
}

describe('T25 model grouping', () => {
  it('uses only the first tag, keeps first-appearance group order and never duplicates a model', () => {
    const grouped = groupChatModels(
      modelOptionsFor([
        { id: 'p/a', label: 'A', tags: ['国产', 'reasoning'] },
        { id: 'p/b', label: 'B', tags: ['GPT'] },
        { id: 'p/c', label: 'C', tags: ['国产'] },
        { id: 'p/d', label: 'D' },
      ])
    );
    expect(grouped.direct.map((item) => item.id)).toEqual([AUTOMATIC_MODEL_ID]);
    expect(grouped.groups.map((group) => group.label)).toEqual(['国产', 'GPT', 'Other models']);
    expect(grouped.groups.map((group) => group.items.map((item) => item.id))).toEqual([
      ['p/a', 'p/c'],
      ['p/b'],
      ['p/d'],
    ]);
  });

  it('uses secondary tags for filtering without creating duplicate groups', () => {
    const models = [
      { id: 'p/a', label: 'Model A', tags: ['国产', 'reasoning'], verified: true },
      { id: 'p/b', label: 'Model B', tags: ['GPT'], verified: true },
    ];
    expect(filterChatModels(models, 'reasoning').map((model) => model.id)).toEqual(['p/a']);
    expect(filterChatModels(models, 'model b').map((model) => model.id)).toEqual(['p/b']);
    expect(groupChatModels(models).groups.map((group) => group.label)).toEqual(['国产', 'GPT']);
  });

  it('keeps a selected unverified leftover directly reachable', () => {
    const grouped = groupChatModels([
      { id: AUTOMATIC_MODEL_ID, label: 'Automatic' },
      { id: 'gone', label: 'gone · unverified', verified: false },
      { id: 'p/a', label: 'A', tags: ['GPT'], verified: true },
    ]);
    expect(grouped.direct.map((item) => item.id)).toEqual([AUTOMATIC_MODEL_ID, 'gone']);
  });
});

describe('modelOptionsFor / Automatic (改判 #10, B11)', () => {
  it('leads with Automatic and keeps the catalog verbatim and in order', () => {
    const options = modelOptionsFor(CLAUDE_CATALOG);
    expect(options[0]).toEqual({ id: AUTOMATIC_MODEL_ID, label: AUTOMATIC_MODEL_LABEL });
    expect(options.slice(1).map((option) => option.id)).toEqual(
      CLAUDE_CATALOG.map((model) => model.id)
    );
  });

  it('marks catalog rows verified and Automatic not', () => {
    const options = modelOptionsFor(CLAUDE_CATALOG);
    expect(options[0].verified).toBeUndefined();
    for (const option of options.slice(1)) expect(option.verified).toBe(true);
  });

  it('an empty catalog still offers Automatic — the fourth fallback rung', () => {
    expect(modelOptionsFor([])).toEqual([{ id: AUTOMATIC_MODEL_ID, label: AUTOMATIC_MODEL_LABEL }]);
  });
});

describe('toWireModel (B11: Automatic omits the key)', () => {
  it('drops Automatic, blanks and nothing-stored', () => {
    expect(toWireModel(AUTOMATIC_MODEL_ID)).toBeUndefined();
    expect(toWireModel(null)).toBeUndefined();
    expect(toWireModel(undefined)).toBeUndefined();
    expect(toWireModel('')).toBeUndefined();
    expect(toWireModel('   ')).toBeUndefined();
  });

  it('passes a real id through, trimmed', () => {
    expect(toWireModel('claude-opus-5')).toBe('claude-opus-5');
    expect(toWireModel(' gpt-5.6-sol ')).toBe('gpt-5.6-sol');
  });
});

describe('unverifiedModelLabel (B5 / B16: two leftovers, two sentences)', () => {
  it('B5: a Claude short name reads as a legacy alias', () => {
    expect(unverifiedModelLabel(CLAUDE_CODE_AGENT, 'sonnet')).toBe('Sonnet (legacy alias)');
    expect(unverifiedModelLabel(CLAUDE_CODE_AGENT, 'haiku')).toBe('Haiku (legacy alias)');
    expect(unverifiedModelLabel(CLAUDE_CODE_AGENT, 'opus')).toBe('Opus (legacy alias)');
  });

  it('B16: anything else reads as unverified, with the id untouched', () => {
    expect(unverifiedModelLabel(CODEX_AGENT, 'gpt-5.5')).toBe('gpt-5.5 · unverified');
    expect(unverifiedModelLabel(CLAUDE_CODE_AGENT, 'claude-opus-4-6')).toBe(
      'claude-opus-4-6 · unverified'
    );
  });

  // The alias spelling is Claude-axis-only: `sonnet` on the Codex axis is not an
  // alias for anything, and calling it one would claim a translation layer that
  // does not exist there.
  it('the alias spelling never crosses the axis', () => {
    expect(isLegacyClaudeShortName(CLAUDE_CODE_AGENT, 'sonnet')).toBe(true);
    expect(isLegacyClaudeShortName(CODEX_AGENT, 'sonnet')).toBe(false);
    expect(unverifiedModelLabel(CODEX_AGENT, 'sonnet')).toBe('sonnet · unverified');
  });
});

describe('resolveModelSelection (§4.3 priority chain)', () => {
  it('a new session with a catalog and no stored choice is Automatic, not the first row', () => {
    expect(
      resolveModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: null,
        catalog: CLAUDE_CATALOG,
      })
    ).toBe(AUTOMATIC_MODEL_ID);
  });

  it("the session's own stored choice outranks the agent template", () => {
    expect(
      resolveModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: 'claude-haiku-4-5',
        agentDefaultModel: 'claude-opus-5',
        catalog: CLAUDE_CATALOG,
      })
    ).toBe('claude-haiku-4-5');
  });

  it('the agent template applies when the session has chosen nothing', () => {
    expect(
      resolveModelSelection({
        agent: CODEX_AGENT,
        storedModel: null,
        agentDefaultModel: 'gpt-5.6-sol',
        catalog: CODEX_CATALOG,
      })
    ).toBe('gpt-5.6-sol');
  });

  // §4.4-6: a leftover the whitelist filtered out is still THIS session's
  // choice. Resetting it to Automatic is the silent model swap R11 forbids.
  it('B16: a stored id outside the catalog survives resolution unchanged', () => {
    expect(
      resolveModelSelection({
        agent: CODEX_AGENT,
        storedModel: 'gpt-5.5',
        catalog: CODEX_CATALOG,
      })
    ).toBe('gpt-5.5');
  });

  it('B5: a legacy short name survives resolution unchanged', () => {
    expect(
      resolveModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: 'sonnet',
        catalog: CLAUDE_CATALOG,
      })
    ).toBe('sonnet');
  });

  // §4.3-3: the demoted Host default. It is a last resort, not an initial value.
  it('the Host default is used only when there is no catalog at all', () => {
    expect(
      resolveModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: null,
        catalog: [],
        hostDefaultModel: 'claude-opus-4-6',
      })
    ).toBe('claude-opus-4-6');
    expect(
      resolveModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: null,
        catalog: CLAUDE_CATALOG,
        hostDefaultModel: 'claude-opus-4-6',
      })
    ).toBe(AUTOMATIC_MODEL_ID);
  });

  it('the Host default never outranks a stored choice or a template', () => {
    expect(
      resolveModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: 'sonnet',
        catalog: [],
        hostDefaultModel: 'claude-opus-4-6',
      })
    ).toBe('sonnet');
    expect(
      resolveModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: null,
        agentDefaultModel: 'claude-haiku-4-5',
        catalog: [],
        hostDefaultModel: 'claude-opus-4-6',
      })
    ).toBe('claude-haiku-4-5');
  });

  // B12 / B18 renderer half: the guard is the SAME three-valued ownership rule
  // Main's dispatch check uses, so a value that would be refused at send time is
  // never displayed as this session's model in the first place.
  it('B12: a candidate belonging to the other agent is refused at every rung', () => {
    expect(
      resolveModelSelection({
        agent: CODEX_AGENT,
        storedModel: 'sonnet',
        catalog: CODEX_CATALOG,
      })
    ).toBe(AUTOMATIC_MODEL_ID);
    expect(
      resolveModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: null,
        agentDefaultModel: 'gpt-5.6-sol',
        catalog: CLAUDE_CATALOG,
      })
    ).toBe(AUTOMATIC_MODEL_ID);
    expect(
      resolveModelSelection({
        agent: CODEX_AGENT,
        storedModel: null,
        catalog: [],
        hostDefaultModel: 'claude-opus-5',
      })
    ).toBe(AUTOMATIC_MODEL_ID);
  });

  it('blank and whitespace-only stored values are treated as unset', () => {
    expect(
      resolveModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: '  ',
        catalog: CLAUDE_CATALOG,
      })
    ).toBe(AUTOMATIC_MODEL_ID);
  });
});

/**
 * §4.6 防线 ① 连带口径 (P1's direct instruction to S2): the reach of a model pick
 * is not the same fact on the two axes, so the control must not describe it with
 * one sentence.
 *
 * Codex has NO per-message model semantics — a `turn/start` override is written
 * into the thread's standing settings and every later turn inherits it [实测
 * 06-probes P1] — while a Claude turn restates its options on every `query()`
 * [实测 06-probes P2]. A shared per-turn phrasing would therefore be a false
 * statement on one of the two axes, which is why this is asserted rather than
 * left to whoever edits the tooltip next.
 */
describe('modelScopeHint (§4.6 防线 ① 连带口径)', () => {
  it('says "next turn" on Claude and "this thread" on Codex', () => {
    expect(modelScopeHint(CLAUDE_CODE_AGENT)).toBe(CLAUDE_MODEL_SCOPE_HINT);
    expect(modelScopeHint(CODEX_AGENT)).toBe(CODEX_MODEL_SCOPE_HINT);
    expect(CLAUDE_MODEL_SCOPE_HINT).toMatch(/turn/);
    expect(CODEX_MODEL_SCOPE_HINT).toMatch(/thread/);
  });

  it('never lets the two axes share one sentence', () => {
    expect(modelScopeHint(CODEX_AGENT)).not.toBe(modelScopeHint(CLAUDE_CODE_AGENT));
    // The Codex copy must not describe a per-turn scope in ANY wording: that is
    // the specific claim P1 disproved.
    expect(CODEX_MODEL_SCOPE_HINT).not.toMatch(/turn/);
  });
});

describe('reconcileModelSelection (B17: what a late catalog may overwrite)', () => {
  // The catalog-arrival trigger. §4.3-6's OTHER trigger (the pair moved) is a
  // separate describe below, because the two arms answer different questions and
  // an implementation that collapsed them into "be conservative" is exactly the
  // defect this split now pins.
  const base = {
    agent: CLAUDE_CODE_AGENT,
    storedModel: null,
    catalog: CLAUDE_CATALOG,
    pairChanged: false,
  } as const;

  // The load-bearing arm: while the answer is in flight, the trigger keeps
  // showing whatever it showed. No spinner, no blank, no premature rewrite.
  it('keeps the current value while the catalog has not loaded', () => {
    expect(
      reconcileModelSelection({
        ...base,
        catalog: [],
        catalogLoaded: false,
        current: 'claude-opus-5',
      })
    ).toBe('claude-opus-5');
    // A leftover the whitelist filters out is kept too — "in flight" is not
    // evidence about anything. `base.agent` is Claude, so this id must be a
    // CLAUDE one: an id belonging to the other runtime is rewritten before any
    // keep-arm is consulted, which is the B12 case asserted separately below.
    expect(
      reconcileModelSelection({
        ...base,
        catalog: [],
        catalogLoaded: false,
        current: 'claude-opus-4-6',
      })
    ).toBe('claude-opus-4-6');
  });

  it('keeps a selection the arrived catalog does list', () => {
    expect(
      reconcileModelSelection({ ...base, catalogLoaded: true, current: 'claude-sonnet-5' })
    ).toBe('claude-sonnet-5');
  });

  it('keeps Automatic, which no catalog can contradict', () => {
    expect(
      reconcileModelSelection({ ...base, catalogLoaded: true, current: AUTOMATIC_MODEL_ID })
    ).toBe(AUTOMATIC_MODEL_ID);
  });

  // §4.4-6 again, now at the moment the catalog lands: this is exactly when a
  // membership test would wipe the user's leftover.
  it("keeps this session's own stored leftover even though the catalog omits it", () => {
    expect(
      reconcileModelSelection({
        ...base,
        storedModel: 'sonnet',
        catalogLoaded: true,
        current: 'sonnet',
      })
    ).toBe('sonnet');
  });

  // The one rewrite arm: a value adopted from the Host default before the
  // catalog existed. Nobody chose it, so replacing it is not a silent swap.
  it('rewrites a value nobody chose once the catalog contradicts it', () => {
    expect(
      reconcileModelSelection({
        ...base,
        catalogLoaded: true,
        hostDefaultModel: 'claude-opus-4-6',
        current: 'claude-opus-4-6',
      })
    ).toBe(AUTOMATIC_MODEL_ID);
  });

  it('re-resolves against the agent template when it rewrites', () => {
    expect(
      reconcileModelSelection({
        ...base,
        agentDefaultModel: 'claude-haiku-4-5',
        catalogLoaded: true,
        current: 'claude-opus-4-6',
      })
    ).toBe('claude-haiku-4-5');
  });

  // B12: switching the draft to the other agent re-reads that agent's own
  // stored choice — the effect hands the new pair's storage in, and the value
  // from the axis just left has no way to survive.
  it('B12: switching agent resolves from the new pair, never from the old selection', () => {
    expect(
      reconcileModelSelection({
        agent: CODEX_AGENT,
        storedModel: 'gpt-5.6-terra',
        catalog: CODEX_CATALOG,
        catalogLoaded: true,
        pairChanged: true,
        current: 'claude-opus-5',
      })
    ).toBe('gpt-5.6-terra');
    expect(
      reconcileModelSelection({
        agent: CODEX_AGENT,
        storedModel: null,
        catalog: CODEX_CATALOG,
        catalogLoaded: true,
        pairChanged: true,
        current: 'claude-opus-5',
      })
    ).toBe(AUTOMATIC_MODEL_ID);
  });

  // B12 at the OTHER moment: the catalog for the axis just switched to has not
  // answered yet, and on a Host that never becomes ready it never will. The
  // not-yet-loaded keep-arm must not carry the previous axis's id through that
  // window — a `claude-opus-5 · unverified` row on a Codex draft is the UI
  // reading of 「不存在跨 agent selection」 being breached.
  it('B12: a value belonging to the other runtime dies even before the catalog loads', () => {
    expect(
      reconcileModelSelection({
        agent: CODEX_AGENT,
        storedModel: null,
        catalog: [],
        catalogLoaded: false,
        pairChanged: false,
        current: 'claude-opus-5',
      })
    ).toBe(AUTOMATIC_MODEL_ID);
    // …and it re-resolves rather than merely blanking: this pair's own stored
    // choice is what replaces it.
    expect(
      reconcileModelSelection({
        agent: CODEX_AGENT,
        storedModel: 'gpt-5.5',
        catalog: [],
        catalogLoaded: false,
        pairChanged: false,
        current: 'sonnet',
      })
    ).toBe('gpt-5.5');
  });
});

/**
 * B17 second trigger (§4.3-6 「`sessionId` 或 `agent` 变 → 读该 (session, agent)
 * 的既有选择」).
 *
 * These are the cases a single conservative function got wrong: the trigger is
 * never remounted per session (`ChatWorkspace` renders one `ChatComposer` with
 * no `key`), so if a pair change is allowed to take a keep-arm, the composer
 * shows session A's model while `resolveResumeModel` sends session B's — the
 * display≠send split R11/A11 exist to forbid, made worse by the effort effect
 * next to it, which always re-reads and therefore disagrees with the model.
 */
describe('reconcileModelSelection (B17: the pair moved)', () => {
  it('a session switch on the same agent adopts the new session stored choice', () => {
    expect(
      reconcileModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: 'claude-haiku-4-5',
        catalog: CLAUDE_CATALOG,
        catalogLoaded: true,
        pairChanged: true,
        // What the previous session had pinned — and it is IN the catalog, so
        // every keep-arm would have kept it.
        current: 'claude-opus-5',
      })
    ).toBe('claude-haiku-4-5');
  });

  it('a session switch to a session that chose nothing falls back, it does not inherit', () => {
    expect(
      reconcileModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: null,
        catalog: CLAUDE_CATALOG,
        catalogLoaded: true,
        pairChanged: true,
        current: 'claude-opus-5',
      })
    ).toBe(AUTOMATIC_MODEL_ID);
    // The template rung still applies — "does not inherit" means from the other
    // SESSION, not from this agent's own default.
    expect(
      reconcileModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: null,
        agentDefaultModel: 'claude-sonnet-5',
        catalog: CLAUDE_CATALOG,
        catalogLoaded: true,
        pairChanged: true,
        current: 'claude-opus-5',
      })
    ).toBe('claude-sonnet-5');
  });

  // The pair change is resolved on its own evidence, not on the catalog's: the
  // catalog gates only the REWRITE arm of the other trigger, and waiting for it
  // here would leave the previous session's model on screen for as long as the
  // fetch takes (forever, while the Host is not ready).
  it('resolves the new pair even while its catalog is still in flight', () => {
    expect(
      reconcileModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: 'sonnet',
        catalog: [],
        catalogLoaded: false,
        pairChanged: true,
        current: 'claude-opus-5',
      })
    ).toBe('sonnet');
  });

  it("keeps the new pair's own value when it happens to equal what was displayed", () => {
    expect(
      reconcileModelSelection({
        agent: CLAUDE_CODE_AGENT,
        storedModel: 'claude-opus-5',
        catalog: CLAUDE_CATALOG,
        catalogLoaded: true,
        pairChanged: true,
        current: 'claude-opus-5',
      })
    ).toBe('claude-opus-5');
  });
});

describe('resolveResumeModel (F9/R11: shared resume + live-send model formula)', () => {
  it('prefers an explicit per-(session, agent) selection', () => {
    const get = storedModels({ 's1:claude-code': 'claude-opus-5' });
    expect(resolveResumeModel(get, 's1', CLAUDE_CODE_AGENT)).toBe('claude-opus-5');
  });

  // B11 at the wire: no selection means no key, not a repo-chosen default. This
  // is the assertion that replaces the pre-D48 `?? DEFAULT_CHAT_MODEL_ID` pin.
  it('B11: an untouched session resolves to undefined so the key is omitted', () => {
    const get = storedModels({});
    expect(resolveResumeModel(get, 's1', CLAUDE_CODE_AGENT)).toBeUndefined();
    expect(resolveResumeModel(get, 's1', CODEX_AGENT)).toBeUndefined();
  });

  it("falls back to the agent's template before giving up", () => {
    const get = storedModels({});
    expect(resolveResumeModel(get, 's1', CODEX_AGENT, 'gpt-5.6-luna')).toBe('gpt-5.6-luna');
  });

  it('B12: the two axes of one session resolve independently', () => {
    const get = storedModels({
      's1:claude-code': 'claude-haiku-4-5',
      's1:codex': 'gpt-5.6-sol',
    });
    expect(resolveResumeModel(get, 's1', CLAUDE_CODE_AGENT)).toBe('claude-haiku-4-5');
    expect(resolveResumeModel(get, 's1', CODEX_AGENT)).toBe('gpt-5.6-sol');
  });

  // R11's original point, restated: the resume path and the live send path call
  // the SAME function, so a session cannot resume onto one model and then send
  // with another.
  it('R11: resume and the live send path read one formula, not two', () => {
    const entries: Record<string, string> = {};
    const get = storedModels(entries);
    expect(resolveResumeModel(get, 's1', CLAUDE_CODE_AGENT)).toBeUndefined();

    entries['s1:claude-code'] = 'claude-haiku-4-5';
    expect(resolveResumeModel(get, 's1', CLAUDE_CODE_AGENT)).toBe('claude-haiku-4-5');
  });

  it('B18 renderer half: a cross-agent stored value never reaches the wire', () => {
    const get = storedModels({ 's1:codex': 'sonnet' });
    expect(resolveResumeModel(get, 's1', CODEX_AGENT)).toBeUndefined();
  });
});
