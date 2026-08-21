import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APP_DIR_BASELINE,
  agentHostCeiling,
  agentHostFloor,
  CODEX_BINARY_FLOOR,
  evaluateAgentHostSize,
  evaluateAppDirSize,
  evaluateCodexBinarySize,
  formatBytes,
  hasBudget,
  PACKAGING_BUDGET,
  topDirectories,
} from '../packaging-budget.mjs';

/**
 * Packaging spec §7.4 D6 / D7 — the size gate.
 *
 * The four-point truth table is the whole point: a gate asserted only at its
 * midpoint passes just as happily with the bounds inverted, swapped, or off by
 * a factor of ten. Each boundary is probed on both sides, inclusively.
 */

const KEY = 'linux-x64';

describe('agent-host size gate — four-point truth table (D6)', () => {
  const floor = agentHostFloor(KEY);
  const ceiling = agentHostCeiling(KEY);

  it('has a floor strictly below its ceiling', () => {
    expect(floor).toBeGreaterThan(0);
    expect(ceiling).toBeGreaterThan(floor);
  });

  it('floor - 1 → red (under)', () => {
    expect(evaluateAgentHostSize(KEY, floor - 1).status).toBe('under');
  });

  it('floor → green (bounds are inclusive)', () => {
    expect(evaluateAgentHostSize(KEY, floor).status).toBe('ok');
  });

  it('ceiling → green (bounds are inclusive)', () => {
    expect(evaluateAgentHostSize(KEY, ceiling).status).toBe('ok');
  });

  it('ceiling + 1 → red (over)', () => {
    expect(evaluateAgentHostSize(KEY, ceiling + 1).status).toBe('over');
  });

  it('is not satisfied by a stray platform variant (+347MB)', () => {
    // The stated design criterion for h1/h2: absorb normal upstream growth,
    // never absorb one extra platform package.
    const real = 406599430;
    expect(evaluateAgentHostSize(KEY, real).status).toBe('ok');
    expect(evaluateAgentHostSize(KEY, real + 347 * 1024 * 1024).status).toBe('over');
  });

  it('catches codex not being bundled at all', () => {
    // Invisible on any box with a global codex — i.e. every dev machine and
    // every CI runner. The floor is the only thing that sees it.
    const withoutCodex = PACKAGING_BUDGET[KEY].baseAgentHost;
    expect(evaluateAgentHostSize(KEY, withoutCodex).status).toBe('under');
  });
});

describe('codex binary single-file floor — four points (D6)', () => {
  it('floor - 1 → red', () => {
    expect(evaluateCodexBinarySize(CODEX_BINARY_FLOOR - 1).status).toBe('under');
  });

  it('floor → green (inclusive)', () => {
    expect(evaluateCodexBinarySize(CODEX_BINARY_FLOOR).status).toBe('ok');
  });

  it('floor + 1 → green', () => {
    expect(evaluateCodexBinarySize(CODEX_BINARY_FLOOR + 1).status).toBe('ok');
  });

  it('a truncated file or LFS pointer → red', () => {
    expect(evaluateCodexBinarySize(133).status).toBe('under');
    expect(evaluateCodexBinarySize(0).status).toBe('under');
  });

  it('shares one constant with the build-time preflight', () => {
    expect(CODEX_BINARY_FLOOR).toBe(200 * 1024 * 1024);
  });
});

describe('unbudgeted platforms report PENDING, never a silent pass', () => {
  it('win32-x64 is budgeted from the first Windows run, not from copied figures', () => {
    // Filled in 2026-08-21 from CI run 32442630099. The assertion is on the
    // measured total landing inside the band — a copy of the linux numbers
    // would put 494.7MiB far above a 443.8MiB ceiling and fail here.
    expect(hasBudget('win32-x64')).toBe(true);
    expect(evaluateAgentHostSize('win32-x64', 518692428).status).toBe('ok');
    expect(agentHostFloor('win32-x64')).toBe(466823185);
    expect(agentHostCeiling('win32-x64')).toBe(591919521);
  });

  it('reports no-budget rather than ok for an unmeasured platform', () => {
    // The distinction matters: 'ok' would let a PENDING platform read as green.
    // darwin is the live case — it has no budget and no shipped codex.
    expect(evaluateAgentHostSize('darwin-arm64', 123).status).toBe('no-budget');
    expect(hasBudget('darwin-arm64')).toBe(false);
  });
});

describe('topDirectories breakdown (D7)', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ranks immediate children by recursive size, largest first', () => {
    fs.mkdirSync(path.join(tmp, 'big', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'big', 'nested', 'a'), 'x'.repeat(3000));
    fs.mkdirSync(path.join(tmp, 'small'));
    fs.writeFileSync(path.join(tmp, 'small', 'b'), 'x'.repeat(100));
    fs.writeFileSync(path.join(tmp, 'loose'), 'x'.repeat(500));

    const top = topDirectories(tmp, 10);
    expect(top.map((e) => e.name)).toEqual(['big', 'loose', 'small']);
    expect(top[0].bytes).toBe(3000);
    expect(top[0].isDirectory).toBe(true);
    expect(top[1].isDirectory).toBe(false);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 15; i += 1) {
      fs.writeFileSync(path.join(tmp, `f${i}`), 'x'.repeat(i + 1));
    }
    expect(topDirectories(tmp, 10)).toHaveLength(10);
  });

  it('returns empty rather than throwing on a missing directory', () => {
    expect(topDirectories(path.join(tmp, 'nope'))).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('renders MiB with one decimal', () => {
    expect(formatBytes(406599430)).toBe('387.8MiB');
    expect(formatBytes(0)).toBe('0.0MiB');
  });
});

describe('evaluateAppDirSize — secondary WARN gate (spec §6.3)', () => {
  const P = 363716282;

  it('reports no-baseline until a platform is measured, never a silent ok', () => {
    // Same discipline as PACKAGING_BUDGET: an unmeasured platform must read as
    // PENDING, because 'ok' here would look like the gate had checked something.
    expect(evaluateAppDirSize('linux-x64', 999, P).status).toBe('no-baseline');
    expect(evaluateAppDirSize('darwin-arm64', 999, P).status).toBe('no-baseline');
  });

  it('reports no-baseline when the codex payload is unknown', () => {
    // Without P the bound is not computable; guessing one would invent a gate.
    expect(evaluateAppDirSize('linux-x64', 999, null).status).toBe('no-baseline');
  });

  it('passes at the ceiling and only warns above it, once a baseline exists', () => {
    const baseline = 433000000;
    const ceiling = 2 * (baseline + P);
    const previous = APP_DIR_BASELINE['linux-x64'];
    APP_DIR_BASELINE['linux-x64'] = baseline;
    try {
      // Inclusive upper bound, same convention as the agent-host budget.
      expect(evaluateAppDirSize('linux-x64', ceiling, P)).toEqual({
        status: 'ok',
        bytes: ceiling,
        ceiling,
      });
      expect(evaluateAppDirSize('linux-x64', ceiling + 1, P).status).toBe('over');
      expect(evaluateAppDirSize('linux-x64', 1, P).status).toBe('ok');
    } finally {
      APP_DIR_BASELINE['linux-x64'] = previous;
    }
  });
});
