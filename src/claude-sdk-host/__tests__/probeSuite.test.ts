import { describe, expect, it } from 'vitest';
import { GROUPS, groupPassed, readProbeOutput } from '../tools/probe-suite.ts';

/**
 * Route B S-5 (topic s5-regression.md R-1): the regression runner judges a group by
 * the probe's own output, so a crash, a timeout or a run with no checks never reads
 * as a pass.
 */

const PASS = [
  'bootstrap 300 ms: {}',
  '  [check] ok   ends in session.completed',
  '  [check] ok   Write ran and completed ok',
  'PROBE CHECKS: all 2 passed',
].join('\n');

describe('the probe-suite runner', () => {
  it('reads checks, failures and the verdict line', () => {
    expect(readProbeOutput(PASS)).toEqual({
      checks: 2,
      failed: [],
      summary: 'PROBE CHECKS: all 2 passed',
    });
    const failing = [
      '  [check] ok   ends in session.completed',
      '  [check] FAIL the sleeps were running before Stop',
      'PROBE CHECKS: 1 of 2 failed',
      '  - stop: the sleeps were running before Stop',
    ].join('\r\n');
    expect(readProbeOutput(failing)).toEqual({
      checks: 2,
      failed: ['the sleeps were running before Stop'],
      summary: 'PROBE CHECKS: 1 of 2 failed',
    });
  });

  it('passes a group only when it ran to an all-passed verdict and exited 0', () => {
    const ok = readProbeOutput(PASS);
    expect(groupPassed({ exit: 0, ...ok })).toBe(true);
    expect(groupPassed({ exit: 1, ...ok })).toBe(false);
    // Killed on a timeout: no exit code.
    expect(groupPassed({ exit: null, ...ok })).toBe(false);
    // Crashed before its verdict.
    const crashed = readProbeOutput('  [check] ok   one\nPROBE FAILED: Error: host exited');
    expect(groupPassed({ exit: 0, ...crashed })).toBe(false);
    // No checks at all.
    expect(groupPassed({ exit: 0, ...readProbeOutput('PROBE CHECKS: all 0 passed') })).toBe(false);
    const failing = readProbeOutput('  [check] FAIL x\nPROBE CHECKS: 1 of 1 failed');
    expect(groupPassed({ exit: 0, ...failing })).toBe(false);
  });

  it('runs every scenario group, each scenario once', () => {
    const scenarios = GROUPS.flatMap((g) => g.scenarios);
    expect(new Set(scenarios).size).toBe(scenarios.length);
    for (const name of [
      'text',
      'stop',
      'mode-auto',
      'keyiso',
      'repoenv',
      'projcfg',
      'projcfg-home',
      'slash',
    ]) {
      expect(scenarios).toContain(name);
    }
    // projcfg-home needs its workspace under a directory named *fakehome*.
    expect(GROUPS.find((g) => g.scenarios.includes('projcfg-home'))?.layout).toBe('fakehome');
  });
});
