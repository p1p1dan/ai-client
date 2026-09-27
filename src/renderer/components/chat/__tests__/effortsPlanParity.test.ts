import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildDshModelPlan } from '@shared/dshModelPlan';
import { type PiManagedModelDefinition, piModelOption } from '@shared/piModelConfig';
import { describe, expect, it } from 'vitest';
import { effortsForModel } from '../efforts';

/**
 * dsh-rebase P1-5a, MP-03 — the plan's `efforts` against what this renderer
 * offered before the plan existed.
 *
 * For every model whose `reasoning` is stated the two must agree: the plan
 * translates the same map by the same rules (implied low/medium/high, `null`
 * is unsupported, xhigh/max/off/minimal only when named), so the menu a user
 * already knows does not change under the DSH engine. Two shapes differ on
 * purpose, and are pinned as such: a map that leaves nothing beyond `off` is
 * a non-reasoning model to DSH, and `reasoning` left unstated offers nothing,
 * because the native runtime never applied a level to such a model either.
 */

type Row = Pick<PiManagedModelDefinition, 'id' | 'reasoning' | 'thinkingLevelMap'>;

const SNAPSHOT = JSON.parse(
  readFileSync(path.join(process.cwd(), 'resources/model-catalog/snapshot.json'), 'utf8')
) as { providers: Record<string, { api: string; models: Row[] }> };

const CONSTRUCTED: Row[] = [
  { id: 'bare', reasoning: true },
  { id: 'no-think', reasoning: false, thinkingLevelMap: { high: 'high' } },
  { id: 'extremes', reasoning: true, thinkingLevelMap: { minimal: 'minimal', xhigh: 'xhigh' } },
  { id: 'nulls', reasoning: true, thinkingLevelMap: { low: null, max: 'max', off: null } },
  { id: 'off-valued', reasoning: true, thinkingLevelMap: { off: 'none', medium: null } },
  { id: 'high-only', reasoning: true, thinkingLevelMap: { low: null, medium: null } },
];

function planned(rows: Array<[providerId: string, api: string, row: Row]>) {
  const providers: Record<string, { api: string; baseUrl: string; models: Row[] }> = {};
  for (const [providerId, api, row] of rows) {
    providers[providerId] ??= { api, baseUrl: 'https://gw.example.test/v1', models: [] };
    providers[providerId].models.push(row);
  }
  const keyed = Object.fromEntries(Object.keys(providers).map((id) => [id, true]));
  return buildDshModelPlan({ models: { providers }, keyed });
}

const rows: Array<[string, string, Row]> = [
  ...Object.entries(SNAPSHOT.providers).flatMap(([providerId, provider]) =>
    provider.models.map((row): [string, string, Row] => [providerId, provider.api, row])
  ),
  ...CONSTRUCTED.map((row): [string, string, Row] => ['made', 'openai-completions', row]),
];

describe('MP-03 plan efforts match the renderer for models that state reasoning', () => {
  const plan = planned(rows);

  it.each(
    rows.map(([providerId, , row]) => [`${providerId}/${row.id}`, providerId, row] as const)
  )('%s', (id, providerId, row) => {
    const option = piModelOption(providerId, row);
    const before = effortsForModel(option).map((effort) => effort.id);
    const after = plan.index[id]?.efforts;
    expect(after).toEqual(before);
    // The menu row carries the plan's list and the renderer then reads it verbatim.
    expect(effortsForModel({ ...option, efforts: after }).map((e) => e.id)).toEqual(after);
  });
});

describe('MP-03 the two deliberate differences', () => {
  it('an off-only map is a non-reasoning model to DSH', () => {
    const row: Row = {
      id: 'off-only',
      reasoning: true,
      thinkingLevelMap: { off: 'none', low: null, medium: null, high: null },
    };
    const plan = planned([['p', 'openai-responses', row]]);
    expect(effortsForModel(piModelOption('p', row)).map((e) => e.id)).toEqual(['off']);
    expect(plan.index['p/off-only']?.efforts).toEqual([]);
  });

  it('a model that never states reasoning is offered no level', () => {
    const row: Row = { id: 'silent' };
    const plan = planned([['p', 'openai-completions', row]]);
    expect(effortsForModel(piModelOption('p', row)).map((e) => e.id)).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(plan.index['p/silent']?.efforts).toEqual([]);
    expect(effortsForModel({ ...piModelOption('p', row), efforts: [] })).toEqual([]);
  });
});
