import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type AutoCompactionPolicy,
  autoCompactionOverride,
  autoCompactionPolicy,
  DSH_COMPACTION_HEADROOM_TOKENS,
  dshCompactSpec,
} from '../../../shared/dshAutoCompaction.ts';
import { buildDshModelPlan } from '../../../shared/dshModelPlan/build.ts';
import {
  autoCompactionOverlay,
  COMPACTION_ROW,
  type CompactionModelPolicy,
  compactionModelPolicies,
  describeAutoCompaction,
  findComposedRow,
  type PlannedCompaction,
  planAutoCompaction,
} from '../hostCompaction.ts';

/**
 * dsh-rebase decision 177 — the `compaction-basic` row's per-model policies:
 * how the host derives them from the plan, how it merges them into the row,
 * what it logs, and (where src/dsh-host is installed) that the installed
 * `dsh-compaction-basic` resolves them to exactly the thresholds and summary
 * caps the shared rules predict.
 */

const HOST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPACTION_BASIC = join(
  HOST_DIR,
  'node_modules',
  '@deepseek-ai',
  'dsh-compaction-basic',
  'lib',
  'index.js'
);
const UTIL_VALUES = join(
  HOST_DIR,
  'node_modules',
  '@deepseek-ai',
  'dsh-util-values',
  'lib',
  'index.js'
);

function samplePlan() {
  return buildDshModelPlan({
    models: {
      providers: {
        gw: {
          api: 'anthropic-messages',
          baseUrl: 'https://gw.example.test',
          models: [
            { id: 'huge', contextWindow: 1_000_000, maxTokens: 128_000 },
            { id: 'w64k', contextWindow: 65_536, maxTokens: 8192 },
            { id: 'w32k', contextWindow: 32_768, maxTokens: 4096 },
            { id: 'unsized' },
            // A second base URL: its own route, `gw~2`.
            { id: 'other', baseUrl: 'https://other.example.test', contextWindow: 200_000 },
          ],
        },
      },
    },
    keyed: { gw: true },
  });
}

describe('planAutoCompaction', () => {
  it('sizes every routed model as llm-pi-ai does and works its policy out', () => {
    const planned = planAutoCompaction(samplePlan());
    expect(planned.map(({ provider, model }) => `${provider}/${model}`)).toEqual([
      'gw/huge',
      'gw/w64k',
      'gw/w32k',
      'gw/unsized',
      'gw~2/other',
    ]);
    const byModel = new Map(planned.map((entry) => [entry.model, entry.policy]));
    expect(byModel.get('huge')).toMatchObject({ auto: true, thresholdTokens: 800_000 });
    expect(byModel.get('w64k')).toMatchObject({ auto: true, headroomLowered: true });
    expect(byModel.get('w32k')).toMatchObject({ auto: false, reason: 'window_too_small' });
    // The route's defaults stand in: 128000 / 8192.
    expect(byModel.get('unsized')).toMatchObject({
      contextWindow: 128_000,
      maxTokens: 8192,
      thresholdTokens: 54_272,
    });
    expect(byModel.get('other')).toMatchObject({ contextWindow: 200_000, maxTokens: 8192 });
  });

  it('lists only the models whose compaction differs from DSH defaults', () => {
    expect(compactionModelPolicies(planAutoCompaction(samplePlan()))).toEqual([
      { provider: 'gw', model: 'w64k', headroomTokens: 23_593, maxTokens: 8192 },
      { provider: 'gw', model: 'w32k', maxTokens: 4096 },
      { provider: 'gw', model: 'unsized', maxTokens: 8192 },
      { provider: 'gw~2', model: 'other', maxTokens: 8192 },
    ]);
  });

  it('plans nothing for an empty plan', () => {
    expect(planAutoCompaction({ routes: {} })).toEqual([]);
  });
});

describe('autoCompactionOverlay', () => {
  const policies: CompactionModelPolicy[] = [{ provider: 'gw', model: 'm', maxTokens: 8192 }];

  it("adds the policies to the row's config as dsh-base leaves it (no config)", () => {
    expect(autoCompactionOverlay({ id: COMPACTION_ROW }, policies)).toEqual({
      kind: 'overlay',
      overlay: { id: COMPACTION_ROW, config: { modelPolicies: policies } },
      policies: 1,
    });
  });

  it("keeps a layer's own switch, an expression included (the probe bundle's `auto`)", () => {
    const auto = { __jsExpr: "process.env.AICLIENT_DSH_COMPACTION_AUTO !== '0'" };
    const row = { id: COMPACTION_ROW, config: { auto, compactionRetries: 2 } };
    const result = autoCompactionOverlay(row, policies);
    expect(result).toMatchObject({
      kind: 'overlay',
      overlay: { config: { auto, compactionRetries: 2, modelPolicies: policies } },
    });
    // The composed row is not written to.
    expect(row.config).toEqual({ auto, compactionRetries: 2 });
  });

  it('leaves a row alone that a layer tunes itself, or that is off or missing', () => {
    expect(
      autoCompactionOverlay({ id: COMPACTION_ROW, config: { headroomTokens: 1000 } }, policies)
    ).toEqual({ kind: 'skipped', reason: 'a layer already sets headroomTokens' });
    expect(
      autoCompactionOverlay(
        { id: COMPACTION_ROW, config: { modelPolicies: [], thresholdRatio: 0.5 } },
        policies
      )
    ).toEqual({ kind: 'skipped', reason: 'a layer already sets modelPolicies, thresholdRatio' });
    expect(autoCompactionOverlay({ id: COMPACTION_ROW, disabled: true }, policies)).toEqual({
      kind: 'skipped',
      reason: 'the compaction-basic row is off',
    });
    expect(
      autoCompactionOverlay({ id: COMPACTION_ROW, config: { __jsExpr: '({})' } }, policies)
    ).toEqual({ kind: 'skipped', reason: 'the compaction-basic config is an expression' });
    expect(autoCompactionOverlay(undefined, policies)).toEqual({
      kind: 'skipped',
      reason: 'the composition has no compaction-basic row',
    });
  });

  it('adds nothing when every model is served by the defaults', () => {
    expect(autoCompactionOverlay({ id: COMPACTION_ROW }, [])).toEqual({ kind: 'none' });
  });

  it('finds the row in a composed list, inside a group too', () => {
    const row = { id: COMPACTION_ROW, name: '@deepseek-ai/dsh-compaction-basic' };
    expect(findComposedRow([{ id: 'a' }, row], COMPACTION_ROW)).toBe(row);
    expect(
      findComposedRow([{ id: 'group', config: { initial: [{ id: 'b' }, row] } }], COMPACTION_ROW)
    ).toBe(row);
    expect(findComposedRow([{ id: 'a' }], COMPACTION_ROW)).toBeUndefined();
  });
});

describe('describeAutoCompaction', () => {
  it("names every model's sizes and threshold, and what is not DSH's default, in one line", () => {
    const planned = planAutoCompaction(samplePlan());
    const outcome = autoCompactionOverlay({ id: COMPACTION_ROW }, compactionModelPolicies(planned));
    expect(describeAutoCompaction('0123456789abcdef', planned, outcome)).toEqual([
      'auto compaction, plan 0123456789ab (5 models, 1 headroom lowered, 1 off; 4 model policies): ' +
        'gw/huge 1000000/128000 at 800000; ' +
        'gw/w64k 65536/8192 at 33751 headroom 23593 summary 8192; ' +
        'gw/w32k 32768/4096 off (window too small) summary 4096; ' +
        'gw/unsized 128000/8192 at 54272 summary 8192; ' +
        'gw~2/other 200000/8192 at 126272 summary 8192',
    ]);
  });

  it('says how far to lower an output limit, and why the policies were not applied', () => {
    const planned: PlannedCompaction[] = [
      {
        provider: 'p',
        model: 'm',
        policy: autoCompactionPolicy({ contextWindow: 65_536, maxTokens: 32_768 }),
      },
      { provider: 'p', model: 'odd', policy: undefined },
    ];
    expect(
      describeAutoCompaction('rev', planned, { kind: 'skipped', reason: 'the row is off' })
    ).toEqual([
      'auto compaction, plan rev (2 models, 0 headroom lowered, 1 off; not applied: the row is off): ' +
        'p/m 65536/32768 off (output limit too large; on with output <= 26527) summary 32768; ' +
        'p/odd unsized',
    ]);
    expect(describeAutoCompaction('rev', [], { kind: 'none' })).toEqual([
      "auto compaction, plan rev (0 models, 0 headroom lowered, 0 off; DSH's defaults): no model",
    ]);
  });

  it('numbers its lines when the models would not fit in one stderr line', () => {
    const planned: PlannedCompaction[] = Array.from({ length: 60 }, (_, index) => ({
      provider: 'a-provider-with-a-long-name',
      model: `model-${index}`,
      policy: autoCompactionPolicy({ contextWindow: 65_536, maxTokens: 8192 }),
    }));
    const lines = describeAutoCompaction('rev', planned, { kind: 'none' });
    expect(lines.length).toBeGreaterThan(1);
    for (const [index, line] of lines.entries()) {
      // Main cuts a host's stderr line at 2000 characters (hostStderr.ts).
      expect(line.length).toBeLessThan(2000);
      expect(line).toContain(`[${index + 1}/${lines.length}]: `);
    }
    expect(lines.join(' ').match(/model-\d+ /g)).toHaveLength(60);
  });
});

/**
 * `dsh-compaction-basic` ships one bundled file and exports only the engine,
 * so its pure configuration functions are taken from the installed file's own
 * `lib/types/config.js` region, unchanged.
 */
interface DshCompactionConfigFunctions {
  resolveConfig(config: unknown): unknown;
  resolveTargetPolicy(
    config: unknown,
    target: { provider: string; model: string }
  ): { maxTokens: number; headroomTokens: number };
  resolveCompactSpec(
    policy: unknown,
    contextWindow: number,
    reservedCompletionTokens: number
  ): { thresholdTokens: number; retainTokens: number; maxTokens: number };
}

async function loadDshConfigFunctions(): Promise<DshCompactionConfigFunctions> {
  const source = readFileSync(COMPACTION_BASIC, 'utf8');
  const start = source.indexOf('//#region lib/types/config.js');
  const end = source.indexOf('//#endregion', start);
  if (start < 0 || end < 0) throw new Error('dsh-compaction-basic has no config region');
  const { deepFreeze } = (await import(pathToFileURL(UTIL_VALUES).href)) as {
    deepFreeze: (value: unknown) => unknown;
  };
  const factory = new Function(
    'deepFreeze',
    `${source.slice(start, end)}\nreturn { resolveConfig, resolveTargetPolicy, resolveCompactSpec };`
  ) as (freeze: typeof deepFreeze) => DshCompactionConfigFunctions;
  return factory(deepFreeze);
}

const WINDOWS = [
  4096, 8192, 16_384, 32_768, 40_960, 43_105, 49_152, 64_000, 65_536, 98_304, 128_000, 131_072,
  200_000, 204_800, 262_144, 272_000, 400_000, 500_000, 1_000_000, 1_048_576, 1_050_000, 10_000_000,
];
const OUTPUTS = [
  0, 1024, 2048, 4096, 8192, 16_384, 24_000, 32_000, 32_768, 40_000, 50_000, 64_000, 65_536,
  100_000, 125_000, 128_000, 131_072, 200_000, 384_000,
];

/** A deterministic spread of sizes beyond the grid (a linear congruential generator). */
function scatteredSizes(count: number): Array<[number, number]> {
  let state = 177;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state;
  };
  return Array.from({ length: count }, () => {
    const window = 4096 + (next() % 1_200_000);
    return [window, next() % window] as [number, number];
  });
}

describe.skipIf(!existsSync(COMPACTION_BASIC) || !existsSync(UTIL_VALUES))(
  'the installed dsh-compaction-basic, given these policies',
  () => {
    const target = { provider: 'gw', model: 'm' };

    it('restates resolveCompactSpec exactly, failures included', async () => {
      const dsh = await loadDshConfigFunctions();
      for (const [W, O] of [
        ...WINDOWS.flatMap((W) => OUTPUTS.map((O) => [W, O] as [number, number])),
        ...scatteredSizes(400),
      ]) {
        for (const headroom of [DSH_COMPACTION_HEADROOM_TOKENS, 8192, 23_593]) {
          const resolved = dsh.resolveConfig({ headroomTokens: headroom });
          const policy = dsh.resolveTargetPolicy(resolved, target);
          const ours = dshCompactSpec(W, O, headroom);
          let theirs: { thresholdTokens: number; retainTokens: number } | undefined;
          try {
            theirs = dsh.resolveCompactSpec(policy, W, O);
          } catch {
            theirs = undefined;
          }
          if (theirs === undefined) {
            expect(ours.ok, `${W}/${O} headroom ${headroom}`).toBe(false);
          } else {
            expect(ours, `${W}/${O} headroom ${headroom}`).toMatchObject({
              ok: true,
              thresholdTokens: theirs.thresholdTokens,
              retainTokens: theirs.retainTokens,
            });
          }
        }
      }
    });

    it('resolves every override to the threshold, tail and summary cap the policy predicts', async () => {
      const dsh = await loadDshConfigFunctions();
      let lowered = 0;
      let off = 0;
      for (const [W, O] of [
        ...WINDOWS.flatMap((W) => OUTPUTS.map((O) => [W, O] as [number, number])),
        ...scatteredSizes(400),
      ]) {
        const ours = autoCompactionPolicy({
          contextWindow: W,
          maxTokens: O,
        }) as AutoCompactionPolicy;
        const override = autoCompactionOverride(ours);
        // The row's config exactly as the host composes it (decision 177).
        const resolved = dsh.resolveConfig({
          modelPolicies: override ? [{ ...target, ...override }] : [],
        });
        const policy = dsh.resolveTargetPolicy(resolved, target);
        expect(policy.maxTokens, `${W}/${O} summary`).toBe(ours.summaryMaxTokens);
        if (ours.auto) {
          if (ours.headroomLowered) lowered += 1;
          expect(dsh.resolveCompactSpec(policy, W, O), `${W}/${O}`).toMatchObject({
            thresholdTokens: ours.thresholdTokens,
            retainTokens: ours.retainTokens,
            maxTokens: ours.summaryMaxTokens,
          });
        } else {
          off += 1;
          expect(() => dsh.resolveCompactSpec(policy, W, O), `${W}/${O}`).toThrow();
        }
      }
      // The sweep went through all three outcomes.
      expect(lowered).toBeGreaterThan(20);
      expect(off).toBeGreaterThan(20);
    });

    it('accepts the whole modelPolicies list a plan produces in one config', async () => {
      const dsh = await loadDshConfigFunctions();
      const planned = planAutoCompaction(samplePlan());
      const resolved = dsh.resolveConfig({
        auto: true,
        modelPolicies: compactionModelPolicies(planned),
      });
      for (const { provider, model, policy } of planned) {
        if (!policy) continue;
        const target = { provider, model };
        expect(dsh.resolveTargetPolicy(resolved, target).maxTokens).toBe(policy.summaryMaxTokens);
      }
    });
  }
);
