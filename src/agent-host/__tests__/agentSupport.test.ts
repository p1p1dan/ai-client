import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHostAgentRegistry,
  CODEX_FLAG_ENV,
  describeHostAgentReason,
  ensureHostAgentRegistry,
  type HostAgentRegistry,
  initializeHostAgents,
  resetHostAgentRegistryForTests,
  resolveCodexEnabled,
} from '../agentSupport.ts';

/**
 * S3 slice 2a — the Codex feature flag and the agent list it produces
 * (standard #6: ship behind a flag and run both positions).
 *
 * These live outside `index.ts` on purpose: that module starts reading stdin at
 * import time, so a test importing it would hang the worker instead of failing.
 */

describe('resolveCodexEnabled', () => {
  it('is on only for the exact string "1"', () => {
    expect(resolveCodexEnabled({ [CODEX_FLAG_ENV]: '1' })).toBe(true);
  });

  it('is off for absent, empty, and every truthy-looking spelling', () => {
    // Falsifies a permissive reader (`!== '0'`, `Boolean(raw)`, `raw !== ''`):
    // this flag guards an UNFINISHED runtime, so a user who wrote `=false` or
    // `=true` on the wrong build must not get Codex sessions. It reads the
    // opposite way from the `AICLIENT_HOST_SUBAGENT_ACTIVITY` kill-switch,
    // which defaults ON — that one guards a shipped fix.
    for (const raw of ['', '0', 'true', 'True', 'yes', 'on', 'codex', '2', ' 1', '1 ']) {
      expect(resolveCodexEnabled({ [CODEX_FLAG_ENV]: raw })).toBe(false);
    }
    expect(resolveCodexEnabled({})).toBe(false);
  });

  it('ignores a lookalike variable name', () => {
    // Falsifies a prefix/substring match on the env name.
    expect(resolveCodexEnabled({ AICLIENT_AGENT_CODEX_HOME: '1' })).toBe(false);
    expect(resolveCodexEnabled({ AICLIENT_AGENT: '1' })).toBe(false);
    expect(CODEX_FLAG_ENV).toBe('AICLIENT_AGENT_CODEX');
  });

  it('re-reads the environment on every call', () => {
    // Falsifies capturing the value at module load: a suite that flips the flag
    // between turns would otherwise keep testing whichever position happened to
    // be set when the module was first imported.
    const env: NodeJS.ProcessEnv = {};
    expect(resolveCodexEnabled(env)).toBe(false);
    env[CODEX_FLAG_ENV] = '1';
    expect(resolveCodexEnabled(env)).toBe(true);
    delete env[CODEX_FLAG_ENV];
    expect(resolveCodexEnabled(env)).toBe(false);
  });

  it('falls back to process.env when called with no argument', () => {
    const previous = process.env[CODEX_FLAG_ENV];
    try {
      process.env[CODEX_FLAG_ENV] = '1';
      expect(resolveCodexEnabled()).toBe(true);
      process.env[CODEX_FLAG_ENV] = '0';
      expect(resolveCodexEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[CODEX_FLAG_ENV];
      else process.env[CODEX_FLAG_ENV] = previous;
    }
  });
});

/**
 * S3 slice 6 (#7 HostAgentRegistry) — codex availability = flag × entry
 * resolution × isolated-home preparation (arbitration doc §2.1), replacing
 * the flag-only `supportedAgents`/`SUPPORTED_AGENTS` this suite used to cover.
 */
describe('buildHostAgentRegistry (A1/A2/G1)', () => {
  it('flag off: claude-code only, codex reason flag_off, and the fs-touching probes never run (A2)', () => {
    const probeEntry = vi.fn(() => true);
    const prepareHome = vi.fn();

    const registry = buildHostAgentRegistry({ env: {}, probeEntry, prepareHome });

    expect(registry.agents).toEqual(['claude-code']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: false, reason: 'flag_off' },
    ]);
    expect(probeEntry).not.toHaveBeenCalled();
    expect(prepareHome).not.toHaveBeenCalled();
  });

  it('flag on + entry unresolved: claude-code only, codex reason entry_missing, and prepareHome never runs', () => {
    const probeEntry = vi.fn(() => false);
    const prepareHome = vi.fn();

    const registry = buildHostAgentRegistry({
      env: { [CODEX_FLAG_ENV]: '1' },
      probeEntry,
      prepareHome,
    });

    expect(registry.agents).toEqual(['claude-code']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: false, reason: 'entry_missing' },
    ]);
    expect(probeEntry).toHaveBeenCalledTimes(1);
    expect(prepareHome).not.toHaveBeenCalled();
  });

  it('flag on + entry resolved + home preparation throws: claude-code only, codex reason home_prepare_failed', () => {
    const prepareHome = vi.fn(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    const registry = buildHostAgentRegistry({
      env: { [CODEX_FLAG_ENV]: '1' },
      probeEntry: () => true,
      prepareHome,
    });

    expect(registry.agents).toEqual(['claude-code']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: false, reason: 'home_prepare_failed' },
    ]);
    expect(prepareHome).toHaveBeenCalledTimes(1);
  });

  it('flag on + entry resolved + home preparation succeeds: both agents available, codex row carries no reason', () => {
    const registry = buildHostAgentRegistry({
      env: { [CODEX_FLAG_ENV]: '1' },
      probeEntry: () => true,
      prepareHome: () => {},
    });

    expect(registry.agents).toEqual(['claude-code', 'codex']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: true },
    ]);
  });

  it('falls back to process.env when env is omitted (same convention as resolveCodexEnabled)', () => {
    const previous = process.env[CODEX_FLAG_ENV];
    try {
      delete process.env[CODEX_FLAG_ENV];
      const registry = buildHostAgentRegistry({ probeEntry: () => true, prepareHome: () => {} });
      expect(registry.agents).toEqual(['claude-code']);
    } finally {
      if (previous === undefined) delete process.env[CODEX_FLAG_ENV];
      else process.env[CODEX_FLAG_ENV] = previous;
    }
  });
});

describe('describeHostAgentReason (A1 point 7, G1 message clue)', () => {
  it('returns three mutually distinguishable clues, one per reason', () => {
    const flagOff = describeHostAgentReason('flag_off');
    const entryMissing = describeHostAgentReason('entry_missing');
    const homePrepareFailed = describeHostAgentReason('home_prepare_failed');

    // Falsifies a generic "not supported" fallback shared across reasons.
    expect(new Set([flagOff, entryMissing, homePrepareFailed]).size).toBe(3);
    expect(flagOff).toContain(CODEX_FLAG_ENV);
    expect(entryMissing).toContain('codex.js');
    expect(homePrepareFailed.toLowerCase()).toContain('home');
  });
});

describe('ensureHostAgentRegistry (A3, memoized single-flight)', () => {
  beforeEach(() => {
    resetHostAgentRegistryForTests();
  });

  it('G2: freezes on the first call — a later call with a FLIPPED env and swapped probes still returns the identical result', () => {
    const first = ensureHostAgentRegistry({
      env: { [CODEX_FLAG_ENV]: '1' },
      probeEntry: () => true,
      prepareHome: () => {},
    });
    expect(first.agents).toEqual(['claude-code', 'codex']);

    const second = ensureHostAgentRegistry({
      env: {}, // flipped: flag now off
      probeEntry: () => {
        throw new Error('must not run after the registry is frozen');
      },
      prepareHome: () => {
        throw new Error('must not run after the registry is frozen');
      },
    });

    // Same object, not just an equal-shaped one: nothing re-derived it.
    expect(second).toBe(first);
    expect(second.agents).toEqual(['claude-code', 'codex']);
  });

  it('G3: an early caller (simulating create/resume validation racing ahead of host.initialize, F15) builds it on the very first call', () => {
    const probeEntry = vi.fn(() => true);
    const prepareHome = vi.fn();

    const registry = ensureHostAgentRegistry({
      env: { [CODEX_FLAG_ENV]: '1' },
      probeEntry,
      prepareHome,
    });

    expect(probeEntry).toHaveBeenCalledTimes(1);
    expect(prepareHome).toHaveBeenCalledTimes(1);
    expect(registry.agents).toEqual(['claude-code', 'codex']);

    // A later call site (e.g. host.initialize, arriving second) gets the SAME
    // registry the early caller already built, without probing again.
    const second = ensureHostAgentRegistry({
      env: { [CODEX_FLAG_ENV]: '1' },
      probeEntry,
      prepareHome,
    });
    expect(second).toBe(registry);
    expect(probeEntry).toHaveBeenCalledTimes(1);
    expect(prepareHome).toHaveBeenCalledTimes(1);
  });

  it('resetHostAgentRegistryForTests clears the memo so the next call rebuilds from scratch', () => {
    ensureHostAgentRegistry({ env: {}, probeEntry: () => true, prepareHome: () => {} });

    resetHostAgentRegistryForTests();

    const probeEntry = vi.fn(() => true);
    const prepareHome = vi.fn();
    const registry = ensureHostAgentRegistry({
      env: { [CODEX_FLAG_ENV]: '1' },
      probeEntry,
      prepareHome,
    });
    expect(probeEntry).toHaveBeenCalledTimes(1);
    expect(registry.agents).toEqual(['claude-code', 'codex']);
  });
});

describe('initializeHostAgents (A4/G4, decoupled from Claude initialization)', () => {
  it('registry is built even when ensureClaudeRuntime rejects, and neither side is swallowed', async () => {
    const registry: HostAgentRegistry = {
      agents: ['claude-code', 'codex'],
      detail: [
        { agent: 'claude-code', available: true },
        { agent: 'codex', available: true },
      ],
    };
    const buildRegistry = vi.fn(() => registry);
    const claudeError = new Error('claude bootstrap failed');

    const outcome = await initializeHostAgents({
      buildRegistry,
      ensureClaudeRuntime: () => Promise.reject(claudeError),
    });

    expect(buildRegistry).toHaveBeenCalledTimes(1);
    // Claude's failure did not clear or replace the registry already built.
    expect(outcome.registry).toBe(registry);
    expect(outcome.claude).toEqual({ ok: false, error: claudeError });
  });

  it('a registry that left codex unavailable does not block or change the Claude outcome (reverse direction)', async () => {
    const registry: HostAgentRegistry = {
      agents: ['claude-code'],
      detail: [
        { agent: 'claude-code', available: true },
        { agent: 'codex', available: false, reason: 'home_prepare_failed' },
      ],
    };
    const ensureClaudeRuntime = vi.fn(() => Promise.resolve('claude-runtime-instance'));

    const outcome = await initializeHostAgents({
      buildRegistry: () => registry,
      ensureClaudeRuntime,
    });

    expect(ensureClaudeRuntime).toHaveBeenCalledTimes(1);
    expect(outcome.claude).toEqual({ ok: true, result: 'claude-runtime-instance' });
    expect(outcome.registry).toBe(registry);
  });

  it('builds the registry BEFORE attempting Claude — order, not just outcome', async () => {
    const order: string[] = [];
    const registry: HostAgentRegistry = {
      agents: ['claude-code'],
      detail: [{ agent: 'claude-code', available: true }],
    };

    await initializeHostAgents({
      buildRegistry: () => {
        order.push('registry');
        return registry;
      },
      ensureClaudeRuntime: async () => {
        order.push('claude');
        return 'ok';
      },
    });

    expect(order).toEqual(['registry', 'claude']);
  });
});
