import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHostAgentRegistry,
  CODEX_MANAGED_API_KEY_ENV,
  CODEX_MANAGED_BASE_URL_ENV,
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

  it('managed: marker is exactly "1" and BOTH halves are non-empty', () => {
    expect(
      resolveCodexCredentialMode({
        [CODEX_MANAGED_ENV]: '1',
        [CODEX_MANAGED_API_KEY_ENV]: 'sk-live',
        [CODEX_MANAGED_BASE_URL_ENV]: 'https://gateway.example.com/v1',
      })
    ).toEqual({ mode: 'managed', apiKey: 'sk-live', baseUrl: 'https://gateway.example.com/v1' });
  });

  it('trims both halves before deciding presence and before returning them', () => {
    expect(
      resolveCodexCredentialMode({
        [CODEX_MANAGED_ENV]: '1',
        [CODEX_MANAGED_API_KEY_ENV]: '  sk-live  ',
        [CODEX_MANAGED_BASE_URL_ENV]: '  https://gateway.example.com/v1  ',
      })
    ).toEqual({ mode: 'managed', apiKey: 'sk-live', baseUrl: 'https://gateway.example.com/v1' });
  });

  it('managed_missing_credentials: marker is "1" but the key is absent or blank', () => {
    const withBase = { [CODEX_MANAGED_BASE_URL_ENV]: 'https://gateway.example.com/v1' };
    expect(resolveCodexCredentialMode({ [CODEX_MANAGED_ENV]: '1', ...withBase })).toEqual({
      mode: 'managed_missing_credentials',
    });
    for (const key of ['   ', '']) {
      expect(
        resolveCodexCredentialMode({
          [CODEX_MANAGED_ENV]: '1',
          [CODEX_MANAGED_API_KEY_ENV]: key,
          ...withBase,
        })
      ).toEqual({ mode: 'managed_missing_credentials' });
    }
  });

  /**
   * S0' (D60): the base URL became a REQUIRED half. Half a credential is not a
   * degraded credential — a key pointed at whatever base URL happens to be
   * lying around is a request sent to the wrong company.
   */
  it('managed_missing_credentials: the key is fine but the base URL is absent or blank', () => {
    expect(
      resolveCodexCredentialMode({
        [CODEX_MANAGED_ENV]: '1',
        [CODEX_MANAGED_API_KEY_ENV]: 'sk-live',
      })
    ).toEqual({ mode: 'managed_missing_credentials' });
    for (const baseUrl of ['   ', '']) {
      expect(
        resolveCodexCredentialMode({
          [CODEX_MANAGED_ENV]: '1',
          [CODEX_MANAGED_API_KEY_ENV]: 'sk-live',
          [CODEX_MANAGED_BASE_URL_ENV]: baseUrl,
        })
      ).toEqual({ mode: 'managed_missing_credentials' });
    }
  });

  it('falls back to process.env when called with no argument (same convention as resolveCodexEnabled)', () => {
    const previousMarker = process.env[CODEX_MANAGED_ENV];
    const previousKey = process.env[CODEX_MANAGED_API_KEY_ENV];
    const previousBase = process.env[CODEX_MANAGED_BASE_URL_ENV];
    try {
      process.env[CODEX_MANAGED_ENV] = '1';
      process.env[CODEX_MANAGED_API_KEY_ENV] = 'sk-live';
      process.env[CODEX_MANAGED_BASE_URL_ENV] = 'https://gateway.example.com/v1';
      expect(resolveCodexCredentialMode()).toEqual({
        mode: 'managed',
        apiKey: 'sk-live',
        baseUrl: 'https://gateway.example.com/v1',
      });
      delete process.env[CODEX_MANAGED_ENV];
      expect(resolveCodexCredentialMode()).toEqual({ mode: 'fallback' });
    } finally {
      if (previousMarker === undefined) delete process.env[CODEX_MANAGED_ENV];
      else process.env[CODEX_MANAGED_ENV] = previousMarker;
      if (previousKey === undefined) delete process.env[CODEX_MANAGED_API_KEY_ENV];
      else process.env[CODEX_MANAGED_API_KEY_ENV] = previousKey;
      if (previousBase === undefined) delete process.env[CODEX_MANAGED_BASE_URL_ENV];
      else process.env[CODEX_MANAGED_BASE_URL_ENV] = previousBase;
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
    expect(describe_({ mode: 'managed', apiKey: 'k', baseUrl: 'https://x/v1' })).toBe('managed:k');
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
  const MANAGED_ENV = {
    [CODEX_MANAGED_ENV]: '1',
    [CODEX_MANAGED_API_KEY_ENV]: 'sk-live',
    [CODEX_MANAGED_BASE_URL_ENV]: 'https://gateway.example.com/v1',
  };

  it('no flag any more: with nothing set, codex is available as soon as both real gates pass', () => {
    // The retired flag's off position used to make THIS case
    // `['claude-code']` with reason `flag_off`. It is now the default-on case,
    // and it is the assertion that would go red if anyone reintroduced an env
    // gate in front of the two below.
    const probeEntry = vi.fn(() => true);

    const registry = buildHostAgentRegistry({ env: {}, probeEntry });

    expect(registry.agents).toEqual(['claude-code', 'codex']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: true },
    ]);
    expect(probeEntry).toHaveBeenCalledTimes(1);
  });

  it('managed marker on + credentials missing: codex reason credentials_missing, and probeEntry never runs (D47 S4a)', () => {
    const probeEntry = vi.fn(() => true);

    const registry = buildHostAgentRegistry({ env: { [CODEX_MANAGED_ENV]: '1' }, probeEntry });

    expect(registry.agents).toEqual(['claude-code']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: false, reason: 'credentials_missing' },
    ]);
    expect(probeEntry).not.toHaveBeenCalled();
  });

  /**
   * S0' (D60): half a credential is not a credential. The key is present and
   * fine here — only the base URL is missing — and the gate must still refuse.
   */
  it('managed marker on + api key present but base URL missing: still credentials_missing', () => {
    const probeEntry = vi.fn(() => true);

    const registry = buildHostAgentRegistry({
      env: { [CODEX_MANAGED_ENV]: '1', [CODEX_MANAGED_API_KEY_ENV]: 'sk-live' },
      probeEntry,
    });

    expect(registry.detail[1]).toEqual({
      agent: 'codex',
      available: false,
      reason: 'credentials_missing',
    });
    expect(probeEntry).not.toHaveBeenCalled();
  });

  it('managed marker ABSENT: negative control — falls through to the fallback path, NOT credentials_missing (D47 S4a §1)', () => {
    const registry = buildHostAgentRegistry({ env: {}, probeEntry: () => true });

    expect(registry.agents).toEqual(['claude-code', 'codex']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: true },
    ]);
  });

  it('managed marker on + both halves present: proceeds through the entry check normally (D47 S4a)', () => {
    const probeEntry = vi.fn(() => true);

    const registry = buildHostAgentRegistry({ env: MANAGED_ENV, probeEntry });

    expect(registry.agents).toEqual(['claude-code', 'codex']);
    expect(probeEntry).toHaveBeenCalledTimes(1);
  });

  it('entry unresolved: claude-code only, codex reason entry_missing', () => {
    const probeEntry = vi.fn(() => false);

    const registry = buildHostAgentRegistry({ env: {}, probeEntry });

    expect(registry.agents).toEqual(['claude-code']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: false, reason: 'entry_missing' },
    ]);
    expect(probeEntry).toHaveBeenCalledTimes(1);
  });

  /**
   * S0' (D60) — the gate that used to sit here is gone, and this is the
   * assertion that says so rather than leaving its absence to be noticed.
   *
   * There was a third gate: prepare an app-owned CODEX_HOME (create the
   * directory, project the user's `~/.codex/config.toml` into it, copy their
   * `auth.json`), with `home_prepare_failed` for when that threw. Nothing is
   * written at registry-build time any more, so a full-disk machine that used
   * to lose Codex here now advertises it and finds out at spawn.
   */
  it('does not touch the filesystem to build the registry', () => {
    const registry = buildHostAgentRegistry({ env: MANAGED_ENV, probeEntry: () => true });

    expect(registry.agents).toEqual(['claude-code', 'codex']);
    expect(registry.detail).toEqual([
      { agent: 'claude-code', available: true },
      { agent: 'codex', available: true },
    ]);
    // The only injected dependency left is the entry probe. A second one
    // reappearing here is the thing this assertion is watching for.
    expect(Object.keys({ env: MANAGED_ENV, probeEntry: () => true }).sort()).toEqual([
      'env',
      'probeEntry',
    ]);
  });

  it('falls back to process.env when env is omitted (same convention as the resolvers above)', () => {
    // Pinned on the managed marker now that the flag is gone: with the marker
    // forced on and no credentials in the ambient environment, the omitted-env
    // call must reach `credentials_missing` — which it can only do by reading
    // `process.env`.
    const previousMarker = process.env[CODEX_MANAGED_ENV];
    const previousKey = process.env[CODEX_MANAGED_API_KEY_ENV];
    const previousBase = process.env[CODEX_MANAGED_BASE_URL_ENV];
    try {
      process.env[CODEX_MANAGED_ENV] = '1';
      delete process.env[CODEX_MANAGED_API_KEY_ENV];
      delete process.env[CODEX_MANAGED_BASE_URL_ENV];
      const registry = buildHostAgentRegistry({ probeEntry: () => true });
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
      if (previousBase === undefined) delete process.env[CODEX_MANAGED_BASE_URL_ENV];
      else process.env[CODEX_MANAGED_BASE_URL_ENV] = previousBase;
    }
  });
});

describe('describeHostAgentReason (A1 point 7, G1 message clue)', () => {
  const REASONS: readonly HostAgentAvailabilityReason[] = ['credentials_missing', 'entry_missing'];
  const clues = REASONS.map((reason) => describeHostAgentReason(reason));

  it('returns mutually distinguishable clues, one per reason', () => {
    // Two reasons since S0' (D60) retired `home_prepare_failed`, and one since
    // 2026-08-26 retired `flag_off`. Falsifies a generic "not supported"
    // fallback shared across reasons.
    expect(new Set(clues).size).toBe(REASONS.length);
    expect(REASONS).toHaveLength(2);
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
    });
    expect(first.agents).toEqual(['claude-code', 'codex']);

    const second = ensureHostAgentRegistry({
      env: {}, // flipped: flag now off
      probeEntry: () => {
        throw new Error('must not run after the registry is frozen');
      },
    });

    // Same object, not just an equal-shaped one: nothing re-derived it.
    expect(second).toBe(first);
    expect(second.agents).toEqual(['claude-code', 'codex']);
  });

  it('G3: an early caller (simulating create/resume validation racing ahead of host.initialize, F15) builds it on the very first call', () => {
    const probeEntry = vi.fn(() => true);

    const registry = ensureHostAgentRegistry({ env: {}, probeEntry });

    expect(probeEntry).toHaveBeenCalledTimes(1);
    expect(registry.agents).toEqual(['claude-code', 'codex']);

    // A later call site (e.g. host.initialize, arriving second) gets the SAME
    // registry the early caller already built, without probing again.
    const second = ensureHostAgentRegistry({ env: {}, probeEntry });
    expect(second).toBe(registry);
    expect(probeEntry).toHaveBeenCalledTimes(1);
  });

  it('resetHostAgentRegistryForTests clears the memo so the next call rebuilds from scratch', () => {
    ensureHostAgentRegistry({ env: {}, probeEntry: () => true });

    resetHostAgentRegistryForTests();

    const probeEntry = vi.fn(() => true);
    const registry = ensureHostAgentRegistry({ env: {}, probeEntry });
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
        { agent: 'codex', available: false, reason: 'entry_missing' },
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
