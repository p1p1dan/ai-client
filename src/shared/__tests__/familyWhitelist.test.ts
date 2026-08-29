import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MODEL_FAMILIES,
  filterAgentModelCatalog,
  isModelAllowedForAgent,
  parseClaudeModelId,
  resolveModelAgentOwner,
} from '../models/familyWhitelist';
import { CLAUDE_SEED_MODELS, CODEX_SEED_MODELS, seedModelsFor } from '../models/seedCatalog';

/**
 * D48 S2 §4.8 — B9 (family whitelist), the pure half of B10 (out-of-catalog ids)
 * and the pure half of B18 (cross-agent ownership).
 *
 * The load-bearing input is the RECORDED gateway answer, not a hand-written sample: the
 * whole rule exists because the real list carries rows nobody would think to
 * invent (an unknown `claude-fable-5` family, an auto-review bot, two image
 * models, five superseded Opus generations). A test fed a tidy fixture would pass
 * against a filter that does almost nothing.
 */

/** [实测 04-cch-live-probe.md §1] — the Claude axis, 15 ids, in the order the gateway listed them. */
const CLAUDE_LIVE_IDS = [
  'claude-fable-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-1-20250805',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
];

/** [实测 04-cch-live-probe.md §1] — the Codex axis, 10 ids. */
const CODEX_LIVE_IDS = [
  'codex-auto-review',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-image-1.5',
  'gpt-image-2',
];

function idsOf(agent: 'claude-code' | 'codex' | 'pi', raw: readonly string[]): string[] {
  return filterAgentModelCatalog(agent, raw).map((option) => option.id);
}

describe('B9 — the recorded gateway lists filter down to exactly the seed six', () => {
  it('Claude: 15 live ids → one per shipped family, newest first', () => {
    // Sequence, not set: an unordered menu reshuffles between refreshes.
    expect(idsOf('claude-code', CLAUDE_LIVE_IDS)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
  });

  it('Codex: 10 live ids → the three variants of the newest generation, by variant name', () => {
    expect(idsOf('codex', CODEX_LIVE_IDS)).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ]);
  });

  it('the two filtered lists ARE the seed table (the seed cannot drift from the rules)', () => {
    expect(filterAgentModelCatalog('claude-code', CLAUDE_LIVE_IDS)).toEqual(CLAUDE_SEED_MODELS);
    expect(filterAgentModelCatalog('codex', CODEX_LIVE_IDS)).toEqual(CODEX_SEED_MODELS);
  });

  it('re-filtering the seed table is a no-op (idempotent floor)', () => {
    for (const agent of ['claude-code', 'codex'] as const) {
      const seeded = seedModelsFor(agent);
      expect(
        filterAgentModelCatalog(
          agent,
          seeded.map((option) => option.id)
        )
      ).toEqual(seeded);
    }
  });
});

describe('Phase 5 — Pi bypasses Claude/Codex family filtering', () => {
  it('keeps arbitrary provider/model ids and their deterministic input order', () => {
    expect(idsOf('pi', ['glm/glm-5', 'dan/deepseek-v4', 'glm/glm-5'])).toEqual([
      'glm/glm-5',
      'dan/deepseek-v4',
    ]);
  });

  it('owns composite ids so they cannot cross into Claude or Codex sessions', () => {
    expect(resolveModelAgentOwner('glm/glm-5')).toBe('pi');
    expect(isModelAllowedForAgent('pi', 'glm/glm-5')).toBe(true);
    expect(isModelAllowedForAgent('claude-code', 'glm/glm-5')).toBe(false);
    expect(isModelAllowedForAgent('codex', 'glm/glm-5')).toBe(false);
  });
});

describe('B9 — a newer version inside a known family ships itself', () => {
  it('Claude: a new opus supersedes the incumbent, and the old one leaves the menu', () => {
    const withNext = [...CLAUDE_LIVE_IDS, 'claude-opus-6'];
    const ids = idsOf('claude-code', withNext);
    expect(ids).toContain('claude-opus-6');
    expect(ids).not.toContain('claude-opus-5');
    expect(ids).toHaveLength(3);
  });

  it('Codex: a new generation takes the whole menu, the previous one leaves entirely', () => {
    const withNext = [...CODEX_LIVE_IDS, 'gpt-5.7-alpha', 'gpt-5.7-beta'];
    expect(idsOf('codex', withNext)).toEqual(['gpt-5.7-alpha', 'gpt-5.7-beta']);
  });

  it('a two-segment bump outranks a longer older version (5 > 4.8, not "shorter loses")', () => {
    expect(idsOf('claude-code', ['claude-opus-4-8', 'claude-opus-5'])).toEqual(['claude-opus-5']);
  });
});

describe('B9 — a NEW FAMILY never ships itself', () => {
  it('claude-fable-5 is live on the gateway today and is deliberately absent', () => {
    // The rule's whole cost/benefit: family adoption is a reviewed one-liner.
    expect(idsOf('claude-code', CLAUDE_LIVE_IDS)).not.toContain('claude-fable-5');
    expect(CLAUDE_MODEL_FAMILIES).not.toContain('fable');
  });

  it('a future unknown family is dropped even when it is the newest thing on offer', () => {
    expect(idsOf('claude-code', ['claude-fable-9'])).toEqual([]);
  });

  it('the family gate refuses at the PARSE layer, not only at the output loop', () => {
    // Pinned separately because the two gates mask each other: with the output
    // loop iterating the shipped families, deleting the parse-time family check
    // changes nothing observable — until someone rewrites the loop, at which
    // point every unknown family the gateway lists appears in the menu at once.
    expect(parseClaudeModelId('claude-fable-5')).toBeNull();
    expect(parseClaudeModelId('claude-opus-5')).not.toBeNull();
  });

  it('a Codex product line that is not gpt-<gen> is dropped whole', () => {
    expect(idsOf('codex', ['o9-reasoner', 'codex-auto-review'])).toEqual([]);
  });
});

describe('B9 — the deny lists, and the undated-alias preference', () => {
  it('never lists an image model, the auto-review bot, or a -mini tier', () => {
    const ids = idsOf('codex', CODEX_LIVE_IDS);
    for (const denied of ['gpt-image-1.5', 'gpt-image-2', 'codex-auto-review', 'gpt-5.4-mini']) {
      expect(ids).not.toContain(denied);
    }
  });

  it('still drops -mini when it is the newest generation on offer', () => {
    // Falsifies "the deny list only works because -mini happened to be old".
    expect(idsOf('codex', ['gpt-5.9-mini', 'gpt-5.8-sol'])).toEqual(['gpt-5.8-sol']);
  });

  it('prefers the undated alias at equal version, in either input order', () => {
    expect(idsOf('claude-code', ['claude-opus-4-5', 'claude-opus-4-5-20251101'])).toEqual([
      'claude-opus-4-5',
    ]);
    expect(idsOf('claude-code', ['claude-opus-4-5-20251101', 'claude-opus-4-5'])).toEqual([
      'claude-opus-4-5',
    ]);
  });

  it('keeps a dated id when it is the only one at the newest version', () => {
    expect(idsOf('claude-code', ['claude-opus-4-5', 'claude-opus-4-6-20260101'])).toEqual([
      'claude-opus-4-6-20260101',
    ]);
  });

  it('reads a YYYYMMDD tail as a stamp, never as another version segment', () => {
    // `20250805` parsed as a version component would make the dated 4.1 the
    // highest opus in the list, by five orders of magnitude.
    expect(idsOf('claude-code', ['claude-opus-4-1-20250805', 'claude-opus-4-5'])).toEqual([
      'claude-opus-4-5',
    ]);
  });
});

describe('B9 — total on hostile input, never a throw', () => {
  it('empty in, empty out', () => {
    expect(idsOf('claude-code', [])).toEqual([]);
    expect(idsOf('codex', [])).toEqual([]);
  });

  it('dedupes, trims and drops blanks', () => {
    expect(idsOf('codex', ['gpt-5.6-sol', ' gpt-5.6-sol ', '', '   '])).toEqual(['gpt-5.6-sol']);
  });

  it('ignores garbage rows instead of failing the whole catalog', () => {
    expect(
      idsOf('claude-code', ['claude-', 'claude-opus-', 'claude-opus-x', 'claude-opus-5'])
    ).toEqual(['claude-opus-5']);
  });
});

describe('B10 (pure half) — an id outside the filtered catalog is never a catalog entry', () => {
  it('gpt-5.2 and gpt-5.5 do not survive the Codex filter', () => {
    const ids = idsOf('codex', [...CODEX_LIVE_IDS, 'gpt-5.2']);
    expect(ids).not.toContain('gpt-5.2');
    expect(ids).not.toContain('gpt-5.5');
  });

  it('the axes never bleed into one another', () => {
    expect(idsOf('claude-code', CODEX_LIVE_IDS)).toEqual([]);
    expect(idsOf('codex', CLAUDE_LIVE_IDS)).toEqual([]);
  });
});

describe('B18 (pure half) — ownership is three-valued, and that is the point', () => {
  it('names the owner of an id from either namespace', () => {
    expect(resolveModelAgentOwner('claude-opus-5')).toBe('claude-code');
    expect(resolveModelAgentOwner('gpt-5.6-sol')).toBe('codex');
    expect(resolveModelAgentOwner('codex-auto-review')).toBe('codex');
  });

  it('owns the three legacy Claude short names, so `sonnet` can never reach Codex', () => {
    for (const legacy of ['opus', 'sonnet', 'haiku']) {
      expect(resolveModelAgentOwner(legacy)).toBe('claude-code');
      expect(isModelAllowedForAgent('codex', legacy)).toBe(false);
      expect(isModelAllowedForAgent('claude-code', legacy)).toBe(true);
    }
  });

  it('refuses a cross-agent id in both directions', () => {
    expect(isModelAllowedForAgent('codex', 'claude-opus-5')).toBe(false);
    expect(isModelAllowedForAgent('claude-code', 'gpt-5.6-sol')).toBe(false);
  });

  it('lets an out-of-catalog id of the RIGHT namespace through (§4.4-6 unverified)', () => {
    // The guard must not be a catalog-membership test: `gpt-5.5` was filtered
    // out of the menu but a session that already chose it must keep sending it,
    // or we have silently swapped the user's model (R11).
    expect(idsOf('codex', CODEX_LIVE_IDS)).not.toContain('gpt-5.5');
    expect(isModelAllowedForAgent('codex', 'gpt-5.5')).toBe(true);
    expect(isModelAllowedForAgent('claude-code', 'claude-opus-4-6')).toBe(true);
  });

  it('lets an id nobody owns through on both axes', () => {
    expect(resolveModelAgentOwner('some-private-deployment')).toBeNull();
    expect(isModelAllowedForAgent('codex', 'some-private-deployment')).toBe(true);
    expect(isModelAllowedForAgent('claude-code', 'some-private-deployment')).toBe(true);
  });

  it('treats blank as unowned rather than as a Claude id', () => {
    expect(resolveModelAgentOwner('   ')).toBeNull();
  });
});
