import { CLAUDE_SEED_MODELS } from '@shared/models/seedCatalog';
import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import { describe, expect, it } from 'vitest';
import { composerModelLabelParts, composerModelMenuModel } from '../composerModel';
import { CHAT_EFFORTS } from '../efforts';
import { AUTOMATIC_MODEL_ID, modelOptionsFor, unverifiedModelLabel } from '../models';

/**
 * T-30b2 assertions for the merged model + reasoning-effort control's pure
 * layer. Ids map to the design spec's round-4 addendum §6 (F-A9 was widened
 * into F-A19 there; both readings are covered below).
 *
 * D48 S2 replaced the fixture: `options` used to be the hard-coded `CHAT_MODELS`
 * short-name table, which no longer exists. It is now what the Composer actually
 * builds — `Automatic` plus a family-filtered catalog — using the seed table as
 * a stand-in for a live proxy answer, because that table IS the filter's output
 * on the ids the gateway really served [实测 调查 04].
 */

/** `Automatic` + the three Claude ids the whitelist keeps. */
const CLAUDE_OPTIONS = modelOptionsFor(CLAUDE_SEED_MODELS);
const CATALOG_SIZE = CLAUDE_SEED_MODELS.length;

describe('composerModelLabelParts', () => {
  // F-A9 / F-A19: the `default` sentinel means "send no effort field at all",
  // so the model's own default applies. A trigger reading `Sonnet Default`
  // would claim a level is pinned when the wire carries none — dropping the
  // suffix is the visual form of that protocol semantics.
  it('F-A19: the default sentinel produces no suffix', () => {
    expect(composerModelLabelParts({ modelLabel: 'Sonnet', effort: 'default' })).toEqual({
      base: 'Sonnet',
      suffix: null,
    });
  });

  it('F-A19: a missing or null effort is treated as the default sentinel', () => {
    expect(composerModelLabelParts({ modelLabel: 'Sonnet' }).suffix).toBeNull();
    expect(composerModelLabelParts({ modelLabel: 'Sonnet', effort: null }).suffix).toBeNull();
    expect(composerModelLabelParts({ modelLabel: 'Sonnet', effort: '' }).suffix).toBeNull();
  });

  // The label table is not reimplemented here — the suffix comes from the same
  // `effortLabel` the settings surface uses, so the two can never disagree
  // about what `xhigh` is called.
  it('F-A19: a real level renders through the existing effort label table', () => {
    expect(composerModelLabelParts({ modelLabel: 'Sonnet', effort: 'high' })).toEqual({
      base: 'Sonnet',
      suffix: 'High',
    });
    expect(composerModelLabelParts({ modelLabel: 'Opus', effort: 'xhigh' })).toEqual({
      base: 'Opus',
      suffix: 'X-High',
    });
    for (const effort of CHAT_EFFORTS) {
      expect(composerModelLabelParts({ modelLabel: 'Sonnet', effort: effort.id }).suffix).toBe(
        effort.label
      );
    }
  });

  // A stored value from a newer build, or a level a newer Host introduces,
  // must not throw and must not be silently flattened to `Default` by
  // `effortLabel`'s own fallback — "show what is actually set" beats "show a
  // level that is not set".
  it('F-A19: an unknown level is echoed back verbatim rather than thrown on or flattened', () => {
    expect(() => composerModelLabelParts({ modelLabel: 'Sonnet', effort: 'ultra' })).not.toThrow();
    expect(composerModelLabelParts({ modelLabel: 'Sonnet', effort: 'ultra' })).toEqual({
      base: 'Sonnet',
      suffix: 'ultra',
    });
  });

  // A stored id outside the catalog has no friendly label to fall back on, so
  // the id itself is the honest thing to display.
  it('F-A19: an out-of-catalog model id passes through unmodified', () => {
    expect(
      composerModelLabelParts({ modelLabel: 'claude-4-2-experimental', effort: 'max' })
    ).toEqual({ base: 'claude-4-2-experimental', suffix: 'Max' });
  });
});

describe('composerModelMenuModel', () => {
  // F-A16: section order is fixed because the trigger reads "{model}
  // {effort}" — a menu listing effort first would put the two in opposite
  // orders on the same control. The effort section is always six rows: the
  // sentinel plus the five real levels.
  it('F-A16: two sections, model first, with the default sentinel leading the effort list', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: 'claude-sonnet-5',
      selectedEffort: 'default',
    });

    expect(menu.sections).toHaveLength(2);
    expect(menu.sections[0].id).toBe('model');
    expect(menu.sections[0].items).toHaveLength(CATALOG_SIZE + 1);
    expect(menu.sections[1].id).toBe('effort');
    expect(menu.sections[1].items).toHaveLength(6);
    expect(menu.sections[1].items[0].id).toBe('default');
  });

  // D48 S2 §4.1's fourth fallback rung, and 改判 #10: `Automatic` leads the model
  // section, so "pin nothing" is always one click away and is never expressed by
  // the absence of a row.
  it('D48 B11: `Automatic` is the first model row, and it is not a catalog entry', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: AUTOMATIC_MODEL_ID,
      selectedEffort: 'default',
    });
    expect(menu.sections[0].items[0].id).toBe(AUTOMATIC_MODEL_ID);
    expect(menu.sections[0].items[0].selected).toBe(true);
    expect(menu.sections[0].items[0].verified).toBeUndefined();
    expect(menu.sections[0].items.filter((item) => item.selected)).toHaveLength(1);
  });

  it('T25 filters effort rows and falls an illegal old selection back to Default', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: 'claude-sonnet-5',
      selectedEffort: 'max',
      efforts: CHAT_EFFORTS.filter((effort) => effort.id === 'low' || effort.id === 'high'),
    });
    expect(menu.sections[1].items.map((item) => item.id)).toEqual(['default', 'low', 'high']);
    expect(menu.sections[1].items.find((item) => item.selected)?.id).toBe('default');
  });

  it('F-A16: exactly one row is selected in each section', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: 'claude-sonnet-5',
      selectedEffort: 'default',
    });

    for (const section of menu.sections) {
      expect(section.items.filter((item) => item.selected)).toHaveLength(1);
    }
    expect(menu.sections[0].items.find((item) => item.selected)?.id).toBe('claude-sonnet-5');
    expect(menu.sections[1].items.find((item) => item.selected)?.id).toBe('default');
  });

  it('F-A16: a real effort level selects its own row, not the sentinel', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: 'claude-opus-5',
      selectedEffort: 'high',
    });
    expect(menu.sections[1].items.find((item) => item.selected)?.id).toBe('high');
    expect(menu.sections[1].items.filter((item) => item.selected)).toHaveLength(1);
  });

  // Neither a stale stored id nor an unknown effort may leave the menu with
  // nothing marked — "no model is set" is never true. But "exactly one row is
  // marked" was, on its own, the assertion that LOCKED IN the defect: the menu
  // used to satisfy it by moving the mark onto `options[0]` / `Default`, i.e.
  // by claiming a selection the session is not on. The trigger label and every
  // send/resume path read the raw stored value, so the menu was the only
  // surface disagreeing — and the user's next click would "confirm" a value
  // they never chose. WHICH row is marked is therefore asserted here, not just
  // how many.
  it('F-A16: an unrecognised stored selection is carried as its own row and marked, never redirected', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: 'a-model-that-was-removed',
      selectedEffort: 'a-level-that-does-not-exist',
    });

    for (const section of menu.sections) {
      expect(section.items.filter((item) => item.selected)).toHaveLength(1);
    }

    expect(menu.sections[0].items).toHaveLength(CLAUDE_OPTIONS.length + 1);
    expect(menu.sections[1].items).toHaveLength(CHAT_EFFORTS.length + 1 + 1);

    expect(menu.sections[0].items.find((item) => item.selected)?.id).toBe(
      'a-model-that-was-removed'
    );
    expect(menu.sections[1].items.find((item) => item.selected)?.id).toBe(
      'a-level-that-does-not-exist'
    );

    // The carried rows lead their sections and label themselves with the raw
    // stored value — the same string `composerModelLabelParts` puts in the
    // trigger, so the menu and the trigger can never read differently.
    expect(menu.sections[0].items[0]).toMatchObject({
      id: 'a-model-that-was-removed',
      label: 'a-model-that-was-removed',
      selected: true,
      verified: false,
    });
    expect(menu.sections[1].items[0]).toMatchObject({
      id: 'a-level-that-does-not-exist',
      label: 'a-level-that-does-not-exist',
      selected: true,
    });
    expect(
      composerModelLabelParts({
        modelLabel: 'a-model-that-was-removed',
        effort: 'a-level-that-does-not-exist',
      }).suffix
    ).toBe(menu.sections[1].items[0].label);

    // Nothing in the catalog gets a stray mark on the way past.
    expect(menu.sections[1].items.find((item) => item.id === 'default')?.selected).toBe(false);
  });

  // B5 — the pre-D48 short name. The gateway rejects it outright [实测 调查 04
  // 探测 B], and this build refuses to guess which full name it meant, so the
  // row says what it is and stays selected.
  it('D48 B5: a legacy Claude short name is prepended, marked, labelled as an alias, and unverified', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: 'sonnet',
      selectedEffort: 'default',
      unknownModelLabel: unverifiedModelLabel(CLAUDE_CODE_AGENT, 'sonnet'),
    });

    expect(menu.sections[0].items[0]).toMatchObject({
      id: 'sonnet',
      label: 'Sonnet (legacy alias)',
      selected: true,
      verified: false,
    });
    // NOT widened into the catalog: the other rows are still exactly the live
    // ones, so no other session can pick this id from a menu.
    expect(menu.sections[0].items.slice(1).map((item) => item.id)).toEqual(
      CLAUDE_OPTIONS.map((option) => option.id)
    );
    expect(menu.sections[0].items.filter((item) => item.selected)).toHaveLength(1);
  });

  // B16 — the OTHER kind of leftover: a full name the gateway may well still
  // serve, filtered out of the product surface by the family whitelist. Same
  // treatment, different sentence, and the id is untouched.
  it('D48 B16: a stored full name outside the whitelist is prepended, marked and labelled unverified', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: 'gpt-5.5',
      selectedEffort: 'default',
      unknownModelLabel: unverifiedModelLabel(CODEX_AGENT, 'gpt-5.5'),
    });

    expect(menu.sections[0].items[0]).toMatchObject({
      id: 'gpt-5.5',
      label: 'gpt-5.5 · unverified',
      selected: true,
      verified: false,
    });
    expect(menu.sections[0].items.some((item) => item.id === 'gpt-5.5' && item.verified)).toBe(
      false
    );
  });

  // Catalog rows carry the opposite flag, so "unverified" is a real distinction
  // in the view model rather than a label convention a renderer could ignore.
  it('D48 B16: live catalog rows are marked verified', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: 'claude-opus-5',
      selectedEffort: 'default',
    });
    for (const seed of CLAUDE_SEED_MODELS) {
      expect(menu.sections[0].items.find((item) => item.id === seed.id)?.verified).toBe(true);
    }
  });

  // A null selection is the one case with no id to carry: nothing is stored at
  // all, so the first row keeps the mark rather than the menu inventing a
  // phantom entry for a value that does not exist. Post-D48 the first row IS
  // `Automatic`, which makes that fallback the honest one.
  it('F-A16: a null model selection still falls back to the first row, which is Automatic', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: null,
      selectedEffort: null,
    });
    expect(menu.sections[0].items).toHaveLength(CLAUDE_OPTIONS.length);
    expect(menu.sections[0].items.find((item) => item.selected)?.id).toBe(AUTOMATIC_MODEL_ID);
    expect(menu.sections[1].items).toHaveLength(CHAT_EFFORTS.length + 1);
    expect(menu.sections[1].items.find((item) => item.selected)?.id).toBe('default');
  });

  it('passes each effort level its tooltip text through unchanged', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: 'claude-sonnet-5',
      selectedEffort: 'default',
    });
    for (const effort of CHAT_EFFORTS) {
      expect(menu.sections[1].items.find((item) => item.id === effort.id)?.hint).toBe(effort.hint);
    }
    // The sentinel is not a level and ships no hint of its own.
    expect(menu.sections[1].items[0].hint).toBeUndefined();
  });

  // F-A16c: the reference popup also carries a model search field, an `Auto`
  // routing toggle and a right-hand Options sub-panel. None are modelled here,
  // and each omission is a capability statement rather than a style choice:
  // the family-filtered catalog is a handful of entries, there is no automatic
  // routing, thinking is a Host capability gate rather than a user switch, and
  // there is no context-window field in the protocol. This asserts nobody
  // "completes" the view model later without the capability arriving first.
  it('F-A16c: the view model carries no search, auto-routing or sub-panel keys at any depth', () => {
    const menu = composerModelMenuModel({
      options: CLAUDE_OPTIONS,
      selectedModel: 'claude-sonnet-5',
      selectedEffort: 'high',
    });

    const forbidden = ['search', 'auto', 'subpanel', 'thinking', 'context'];
    const seen: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) {
          seen.push(key.toLowerCase());
          walk(child);
        }
      }
    };
    walk(menu);

    expect(seen.length).toBeGreaterThan(0);
    for (const key of seen) {
      expect(forbidden).not.toContain(key);
    }
  });
});
