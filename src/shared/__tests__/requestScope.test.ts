import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CACHE_CHAIN_ENV,
  type ClientPrefixEvidence,
  isSwitchedOff,
  PREFIX_WATCH_ENV,
  REQUEST_SCOPE_SERVICE,
  type RequestScopeView,
  SESSION_METADATA_ENV,
} from '../types/requestScope';

/**
 * Decision 173 (GitHub issue #9): the names the host's fetch wrapper, the
 * bridge and Main share, and the emergency switches.
 */
describe('request scope names', () => {
  it('keeps its service and switch names', () => {
    expect(REQUEST_SCOPE_SERVICE).toBe('aiclientRequestScope');
    expect(PREFIX_WATCH_ENV).toBe('AICLIENT_RUNTIME_PREFIX_WATCH');
    expect(SESSION_METADATA_ENV).toBe('AICLIENT_RUNTIME_SESSION_METADATA');
    expect(CACHE_CHAIN_ENV).toBe('AICLIENT_RUNTIME_CACHE_CHAIN');
  });

  it('leaves a switch on unless it is set to 0', () => {
    const name = SESSION_METADATA_ENV;
    expect(isSwitchedOff({ [name]: '0' }, name)).toBe(true);
    expect(isSwitchedOff({ [name]: ' 0\n' }, name)).toBe(true);
    for (const value of [undefined, '', '1', 'false', 'off', '00', 'no']) {
      expect(isSwitchedOff({ [name]: value }, name), String(value)).toBe(false);
    }
    // Each switch reads its own variable.
    expect(isSwitchedOff({ [PREFIX_WATCH_ENV]: '0' }, CACHE_CHAIN_ENV)).toBe(false);
    expect(isSwitchedOff({}, PREFIX_WATCH_ENV)).toBe(false);
  });

  it('describes the evidence a view hands out', () => {
    const evidence: ClientPrefixEvidence = {
      verdict: {
        kind: 'diverged',
        at: 'messages',
        index: 41,
        role: 'assistant',
        truncated: false,
        prevMessages: 70,
        messages: 72,
      },
      requestSeq: 12,
      at: 1_760_000_000_000,
    };
    const view: RequestScopeView = {
      evidenceFor: (id) => (id === 'aiclient-a' ? evidence : undefined),
    };
    expect(view.evidenceFor('aiclient-a')).toBe(evidence);
    expect(view.evidenceFor('aiclient-b')).toBeUndefined();
  });
});

describe('the module the host bundle takes in', () => {
  it('imports nothing, so the host bundle takes in nothing else with it', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'types', 'requestScope.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/^\s*export\s+[^;]*\bfrom\s+['"]/m);
  });
});
