import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHostAgentRegistry,
  CODEX_MANAGED_API_KEY_ENV,
  CODEX_MANAGED_ENV,
  type CodexCredentialMode,
  describeHostAgentReason,
  ensureHostAgentRegistry,
  type HostAgentAvailabilityReason,
  type HostAgentRegistry,
  initializeHostAgents,
  resetHostAgentRegistryForTests,
  resolveCodexCredentialMode,
} from '../agentSupport.ts';

/**
 * S3 slice 2a — the agent list the Host produces.
 *
 * The `AICLIENT_AGENT_CODEX` flag this file used to open with was retired on
 * 2026-08-26 (用户拍板): the runtime it guarded is finished, and the switch was
 * unreachable for any user who launches the packaged app from a desktop icon
 * rather than a terminal. `resolveCodexEnabled`'s whole describe block went
 * with it; what remains is the three gates that are facts about the machine.
 *
 * These live outside `index.ts` on purpose: that module starts reading stdin at
 * import time, so a test importing it would hang the worker instead of failing.
 */

/**
 * D47 S4a §1 (rev.2) — the three-state resolver every managed-mode reader
 * goes through. `env` is always passed explicitly here (never omitted) so
 * these cases stay hermetic; the "falls back to process.env" case below is
 * the one exception, by design, matching this module's own convention for
 * env-reading functions.
 */
describe('resolveCodexCredentialMode (D47 S4a §1 three-state resolver)', () => {
  it('fallback: marker missing/blank/anything other than the exact string "1" — today behaviour byte for byte', () => {
    for (const raw of [undefined, '', '0', 'true', 'True', ' 1', '1 ', '2']) {
      const env: NodeJS.ProcessEnv = raw === undefined ? {} : { [CODEX_MANAGED_ENV]: raw };
      expect(resolveCodexCredentialMode(env)).toEqual({ mode: 'fallback' });
    }
  });

  it('fallback even when the api key IS present, as long as the marker is not exactly "1" (negative control)', () => {
    // Falsifies "presence of the key alone turns managed mode on" — the
    // explicit marker is the ONLY switch (rev.1's "a" was struck down).
    expect(resolveCodexCredentialMode({ [CODEX_MANAGED_API_KEY_ENV]: 'sk-live' })).toEqual({
      mode: 'fallback',
    });
  });

  it('managed: marker is exactly "1" and the api key is non-empty', () => {
    expect(
      resolveCodexCredentialMode({
        [CODEX_MANAGED_ENV]: '1',
        [CODEX_MANAGED_API_KEY_ENV]: 'sk-live',
      })
    ).toEqual({ mode: 'managed', apiKey: 'sk-live' });
  });

  it('trims the api key before deciding presence and before returning it', () => {
    expect(
      resolveCodexCredentialMode({
        [CODEX_MANAGED_ENV]: '1',
        [CODEX_MANAGED_API_KEY_ENV]: '  sk-live  ',
      })
    ).toEqual({ mode: 'managed', apiKey: 'sk-live' });
  });

  it('managed_missing_credentials: marker is "1" but the key is absent or blank', () => {
    expect(resolveCodexCredentialMode({ [CODEX_MANAGED_ENV]: '1' })).toEqual({
      mode: 'managed_missing_credentials',
    });
    expect(
      resolveCodexCredentialMode({ [CODEX_MANAGED_ENV]: '1', [CODEX_MANAGED_API_KEY_ENV]: '   ' })
    ).toEqual({ mode: 'managed_missing_credentials' });
    expect(
      resolveCodexCredentialMode({ [CODEX_MANAGED_ENV]: '1', [CODEX_MANAGED_API_KEY_ENV]: '' })
    ).toEqual({ mode: 'managed_missing_credentials' });
  });

  it('falls back to process.env when called with no argument (same convention as resolveCodexEnabled)', () => {
    const previousMarker = process.env[CODEX_MANAGED_ENV];
    const previousKey = process.env[CODEX_MANAGED_API_KEY_ENV];
    try {
      process.env[CODEX_MANAGED_ENV] = '1';
      process.env[CODEX_MANAGED_API_KEY_ENV] = 'sk-live';
      expect(resolveCodexCredentialMode()).toEqual({ mode: 'managed', apiKey: 'sk-live' });
      delete process.env[CODEX_MANAGED_ENV];
      expect(resolveCodexCredentialMode()).toEqual({ mode: 'fallback' });
    } finally {
      if (previousMarker === undefined) delete process.env[CODEX_MANAGED_ENV];
      else process.env[CODEX_MANAGED_ENV] = previousMarker;
      if (previousKey === undefined) delete process.env[CODEX_MANAGED_API_KEY_ENV];
      else process.env[CODEX_MANAGED_API_KEY_ENV] = previousKey;
    }
  });

  it('the three modes are mutually exclusive discriminants (exhaustive switch compiles)', () => {
    // A compile-time falsification as much as a runtime one: adding a fourth
    // mode without updating every switch over CodexCredentialMode fails tsc.
    const describe_ = (m: CodexCredentialMode): string => {
      switch (m.mode) {
        case 'fallback':
          return 'fallback';
        case 'managed':
          return `managed:${m.apiKey}`;
        case 'managed_missing_credentials':
          return 'managed_missing_credentials';
      }
    };
    expect(describe_({ mode: 'fallback' })).toBe('fallback');
    expect(describe_({ mode: 'managed', apiKey: 'k' })).toBe('managed:k');
    expect(describe_({ mode: 'managed_missing_credentials' })).toBe('managed_missing_credentials');
  });
});

/**
 * D47 S4a §1 — the marker literal is a single source of truth on purpose (see
 * `CODEX_MANAGED_ENV`'s docstring): every reader must go through
 * `resolveCodexCredentialMode` instead of re-testing the env var itself. This
 * scan is scoped to `src/agent-host` (this file's own directory) — Main's
 * `hostEnv.ts` half of the contract is asserted independently on that side
 * (out of scope here, S3b).
 */
describe('AICLIENT_CODEX_MANAGED marker literal — single source of truth (D47 S4a §1)', () => {
  it('appears in no PRODUCTION source under src/agent-host except its own definition in agentSupport.ts', () => {
    // `__tests__` is deliberately excluded: test titles/assertions legitimately
    // spell the constant's value out in prose (including this very file, whose
    // own describe title above names it) — the discipline being enforced is
    // that no CODE branches on the raw string a second time, not that no
    // English sentence mentions it.
    const dir = path.resolve(import.meta.dirname, '..');
    const files = (readdirSync(dir, { recursive: true }) as string[])
      .map(String)
      .filter((p) => p.endsWith('.ts') && !p.includes('node_modules'))
      .filter((p) => !p.includes('__tests__') && !p.startsWith(`spikes${path.sep}`))
      .map((p) => path.join(dir, p));

    const offenders = files
      .filter((file) => path.basename(file) !== 'agentSupport.ts')
      .filter((file) => readFileSync(file, 'utf8').includes(CODEX_MANAGED_ENV))
      .map((file) => path.relative(dir, file));

    expect(offenders).toEqual([]);
  });
});

/**
 * S3 slice 6 (#7 HostAgentRegistry) — codex availability = flag × credential
 * mode × entry resolution × isolated-home preparation (arbitration doc
 * §2.1), replacing the flag-only `supportedAgents`/`SUPPORTED_AGENTS` this
 * suite used to cover. `credentials_missing` (D47 S4a) is the second gate.
 */
describe('buildHostAgentRegistry (A1/A2/G1)', () => {
  it('no flag any more: with nothing set, codex is available as soon as the three real gates pass', () => {
    // The retired flag's off position used to make THIS case
    // `['claude-code']` with reason `flag_off`. It is now the default-on
    // case, and it is the assertion that would go red if anyone reintroduced
    // an env gate in front of the three below.
    const probeEntry = vi.fn(() => true);
    const prepareHome = vi.fn();

    const registry = buildHostAgentRegistry({ env: {}, probeEntry, prepareHome });

    expect(registry.agents).toEqual(['claude-code', 'codex']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: true },
    ]);
    // And the fs-touching probes DO run now — the flag arm used to short
    // -circuit them, which is the behaviour change the module header records.
    expect(probeEntry).toHaveBeenCalledTimes(1);
    expect(prepareHome).toHaveBeenCalledTimes(1);
  });

  it('managed marker on + api key missing: codex reason credentials_missing, and probeEntry/prepareHome never run (D47 S4a)', () => {
    const probeEntry = vi.fn(() => true);
    const prepareHome = vi.fn();

    const registry = buildHostAgentRegistry({
      env: { [CODEX_MANAGED_ENV]: '1' },
      probeEntry,
      prepareHome,
    });

    expect(registry.agents).toEqual(['claude-code']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: false, reason: 'credentials_missing' },
    ]);
    expect(probeEntry).not.toHaveBeenCalled();
    expect(prepareHome).not.toHaveBeenCalled();
  });

  it('managed marker ABSENT: negative control — falls through to the existing fallback path, NOT credentials_missing (D47 S4a §1)', () => {
    const registry = buildHostAgentRegistry({
      env: {},
      probeEntry: () => true,
      prepareHome: () => {},
    });

    expect(registry.agents).toEqual(['claude-code', 'codex']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: true },
    ]);
  });

  it('managed marker on + api key present: proceeds through the entry/home checks normally (D47 S4a)', () => {
    const probeEntry = vi.fn(() => true);
    const prepareHome = vi.fn();

    const registry = buildHostAgentRegistry({
      env: {
        [CODEX_MANAGED_ENV]: '1',
        [CODEX_MANAGED_API_KEY_ENV]: 'sk-live',
      },
      probeEntry,
      prepareHome,
    });

    expect(registry.agents).toEqual(['claude-code', 'codex']);
    expect(probeEntry).toHaveBeenCalledTimes(1);
    expect(prepareHome).toHaveBeenCalledTimes(1);
  });

  it('entry unresolved: claude-code only, codex reason entry_missing, and prepareHome never runs', () => {
    const probeEntry = vi.fn(() => false);
    const prepareHome = vi.fn();

    const registry = buildHostAgentRegistry({
      env: {},
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

  it('entry resolved + home preparation throws: claude-code only, codex reason home_prepare_failed', () => {
    const prepareHome = vi.fn(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    const registry = buildHostAgentRegistry({
      env: {},
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

  it('entry resolved + home preparation succeeds: both agents available, codex row carries no reason', () => {
    const registry = buildHostAgentRegistry({
      env: {},
      probeEntry: () => true,
      prepareHome: () => {},
    });

    expect(registry.agents).toEqual(['claude-code', 'codex']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: true },
    ]);
  });

  it('falls back to process.env when env is omitted (same convention as the resolvers above)', () => {
    // Pinned on the managed marker now that the flag is gone: with the marker
    // forced on and no api key in the ambient environment, the omitted-env
    // call must reach `credentials_missing` — which it can only do by reading
    // `process.env`.
    const previousMarker = process.env[CODEX_MANAGED_ENV];
    const previousKey = process.env[CODEX_MANAGED_API_KEY_ENV];
    try {
      process.env[CODEX_MANAGED_ENV] = '1';
      delete process.env[CODEX_MANAGED_API_KEY_ENV];
      const registry = buildHostAgentRegistry({ probeEntry: () => true, prepareHome: () => {} });
      expect(registry.agents).toEqual(['claude-code']);
      expect(registry.detail[1]).toEqual({
        agent: 'codex',
        available: false,
        reason: 'credentials_missing',
      });
    } finally {
      if (previousMarker === undefined) delete process.env[CODEX_MANAGED_ENV];
      else process.env[CODEX_MANAGED_ENV] = previousMarker;
      if (previousKey === undefined) delete process.env[CODEX_MANAGED_API_KEY_ENV];
      else process.env[CODEX_MANAGED_API_KEY_ENV] = previousKey;
    }
  });
});

describe('describeHostAgentReason (A1 point 7, G1 message clue)', () => {
  const REASONS: readonly HostAgentAvailabilityReason[] = [
    'credentials_missing',
    'entry_missing',
    'home_prepare_failed',
  ];
  const clues = REASONS.map((reason) => describeHostAgentReason(reason));

  it('returns three mutually distinguishable clues, one per reason (flag_off retired 2026-08-26)', () => {
    // Falsifies a generic "not supported" fallback shared across reasons.
    expect(new Set(clues).size).toBe(3);
  });

  it('D47 S4a new discipline: no clue is a substring of another (ordered pairs) — Set.size alone cannot catch one clue merely EXTENDING another', () => {
    for (let i = 0; i < clues.length; i += 1) {
      for (let j = 0; j < clues.length; j += 1) {
        if (i === j) continue;
        const a = clues[i] as string;
        const b = clues[j] as string;
        expect(
          a.includes(b),
          `clue for ${REASONS[i]} must not contain the clue for ${REASONS[j]}`
        ).toBe(false);
      }
    }
  });

  it('names the api-key var / codex.js / "home" respectively', () => {
    expect(describeHostAgentReason('credentials_missing')).toContain(CODEX_MANAGED_API_KEY_ENV);
    expect(describeHostAgentReason('entry_missing')).toContain('codex.js');
    expect(describeHostAgentReason('home_prepare_failed').toLowerCase()).toContain('home');
  });
});

describe('ensureHostAgentRegistry (A3, memoized single-flight)', () => {
  beforeEach(() => {
    resetHostAgentRegistryForTests();
  });

  it('G2: freezes on the first call — a later call with a FLIPPED env and swapped probes still returns the identical result', () => {
    const first = ensureHostAgentRegistry({
      env: {},
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
      env: {},
      probeEntry,
      prepareHome,
    });

    expect(probeEntry).toHaveBeenCalledTimes(1);
    expect(prepareHome).toHaveBeenCalledTimes(1);
    expect(registry.agents).toEqual(['claude-code', 'codex']);

    // A later call site (e.g. host.initialize, arriving second) gets the SAME
    // registry the early caller already built, without probing again.
    const second = ensureHostAgentRegistry({
      env: {},
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
      env: {},
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
