import { describe, expect, it } from 'vitest';
import { CODEX_FLAG_ENV, resolveCodexEnabled, supportedAgents } from '../agentSupport.ts';

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

describe('supportedAgents', () => {
  it('advertises Claude Code alone when the flag is off', () => {
    expect(supportedAgents({ codexEnabled: false })).toEqual(['claude-code']);
  });

  it('appends Codex after Claude Code when the flag is on', () => {
    // `toEqual` on arrays is order-sensitive, which is the point: a consumer
    // that takes the head as "the default agent" must still get Claude Code
    // once Codex is switched on.
    expect(supportedAgents({ codexEnabled: true })).toEqual(['claude-code', 'codex']);
  });

  it('never leaks Codex into the off position', () => {
    // Falsifies a shared/mutated module-level array: the two positions must not
    // be the same object, or one call's push would change the other's answer.
    const off = supportedAgents({ codexEnabled: false });
    const on = supportedAgents({ codexEnabled: true });
    expect(off).not.toContain('codex');
    expect(on).toContain('codex');
    expect(off).not.toBe(on);
    expect(supportedAgents({ codexEnabled: false })).toEqual(['claude-code']);
  });

  it('is the same list the flag reader feeds it, end to end', () => {
    expect(supportedAgents({ codexEnabled: resolveCodexEnabled({}) })).toEqual(['claude-code']);
    expect(
      supportedAgents({ codexEnabled: resolveCodexEnabled({ [CODEX_FLAG_ENV]: '1' }) })
    ).toEqual(['claude-code', 'codex']);
  });
});
