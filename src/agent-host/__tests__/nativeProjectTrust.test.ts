/**
 * decision 009 — a native worker trusts the project it was pointed at, in both
 * credential modes.
 *
 * The regression this guards is invisible at runtime and silent in every log:
 * the worker entry used to derive `projectTrusted` from
 * `AICLIENT_PI_TRUST_PROJECT_CONFIG`, which Main sets to `'0'` for a company
 * account. That one character closed four unrelated layers at once — project
 * MCP servers, project skills and prompt templates, the repository's permission
 * policy, and its CLAUDE.md / AGENTS.md — and a session that quietly loads
 * fewer sources still answers, just worse.
 *
 * Asserted against the entry's SOURCE rather than through a spawned worker on
 * purpose. What has to stay true is that the managed flag is not in this
 * decision at all, and a forked process can only show the answer for the one
 * environment it was handed. Reading the file shows there is no environment
 * that changes it — including an absent key, which is the case the old
 * tri-state reader resolved to "untrusted".
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_PROJECT_TRUSTED, PI_PROJECT_TRUST_ENV } from '../../shared/piModelConfig.ts';

const WORKER_ENTRY = path.resolve(__dirname, '..', 'worker.ts');
const entrySource = () => readFileSync(WORKER_ENTRY, 'utf8');

/** Comments name the retired variable on purpose; strip them before matching. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('native project trust', () => {
  it('trusts the project, which is what the four project-scoped layers need', () => {
    expect(NATIVE_PROJECT_TRUSTED).toBe(true);
  });

  it('is what the worker entry hands the RPC server', () => {
    expect(withoutComments(entrySource())).toContain('projectTrusted: NATIVE_PROJECT_TRUSTED');
  });

  it('is not derived from the managed-route marker, at any value or none', () => {
    // The whole point of decision 009: `'0'`, `'1'` and an absent key all leave
    // a native session reading the repository. A reference to the variable here
    // would mean one of those three answers had become "do not read it".
    const code = withoutComments(entrySource());
    expect(code).not.toContain(PI_PROJECT_TRUST_ENV);
    expect(code).not.toContain('PI_PROJECT_TRUST_ENV');
  });
});
