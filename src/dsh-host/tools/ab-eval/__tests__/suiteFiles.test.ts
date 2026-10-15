import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isGitUrl, loadCases, validateCase } from '../lib/cases.ts';
import { makeRedactor, REDACTED, scanForSecrets } from '../lib/redact.ts';
import { fmt, meanSd, spread } from '../lib/stats.ts';
import { passCell, renderReport, type SuiteManifest, wilson } from '../lib/summary.ts';
import type { RunRecord } from '../lib/types.ts';
import { parseArms } from '../lib/variants.ts';

/**
 * The bundled cases and variants must load as shipped; a broken case fails a
 * suite before any run. Stats, the report and the secret guards are pinned
 * too, since a report another agent reads must say what it measured.
 */

const AB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ab-eval-unit-'));
  dirs.push(dir);
  return dir;
}

describe('bundled cases and variants', () => {
  it('load and validate', () => {
    const cases = loadCases([join(AB_DIR, 'cases'), join(AB_DIR, 'selftest', 'cases')]);
    expect(cases.map((c) => c.id)).toEqual([
      'fix-median-sort',
      'retry-total-sleep',
      'slugify-max-length',
      'selftest-gives-up',
      'selftest-question',
      'selftest-setup',
      'selftest-step-budget',
      'selftest-time-budget',
    ]);
    expect(cases.find((c) => c.id === 'selftest-setup')?.prompt).toContain('setup-marker.txt');
    for (const c of cases) {
      expect(c.fakeModel?.steps.at(-1)?.op).toBe('answer');
      expect(c.repoSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const arms = parseArms('pilab,claude-code,pilab+selftest-persona', join(AB_DIR, 'variants'));
    expect(arms.map((arm) => arm.id)).toEqual(['pilab', 'claude-code', 'pilab+selftest-persona']);
    expect(arms[2].variant?.resolvedFiles.dshHome['cordis.patch.yml']).toContain(
      'AB-EVAL-VARIANT-MARKER'
    );
  });

  it('refuses a variant used with the other client', () => {
    expect(() => parseArms('claude-code+selftest-persona', join(AB_DIR, 'variants'))).toThrow(
      /is for pilab/
    );
  });
});

describe('validateCase', () => {
  it('reports every problem of a bad case', () => {
    const dir = scratch();
    const problems = validateCase(
      {
        id: 'bad id',
        prompt: '',
        repo: { git: 'https://example.invalid/r.git' },
        checks: { commands: [{ argv: ['node'], shell: 'node' }], forbidden: [{ pattern: '(' }] },
        budget: { maxSteps: 0 },
        fakeModel: { steps: [{ op: 'teleport' }] },
      },
      dir
    );
    expect(problems).toHaveLength(7);
  });

  it('rejects duplicate ids across files', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'fx'));
    const body = JSON.stringify({ id: 'same', prompt: 'p', repo: { fixture: 'fx' } });
    writeFileSync(join(dir, 'a.json'), body);
    writeFileSync(join(dir, 'b.json'), body);
    expect(() => loadCases([dir])).toThrow(/duplicate case id same/);
  });

  it('reads a prompt file, resolves paths beside the case, and hashes the prompt too', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'repo'));
    writeFileSync(join(dir, 'task.md'), '\uFEFF修一下这个 bug\n');
    const body = {
      id: 'field-1',
      promptFile: 'task.md',
      repo: { git: 'repo', commit: 'abcdef1' },
      setup: [{ shell: 'npm ci' }],
    };
    writeFileSync(join(dir, 'case.json'), JSON.stringify(body));
    const [first] = loadCases([join(dir, 'case.json')]);
    expect(first.prompt).toBe('修一下这个 bug\n');
    expect(first.repo).toEqual({ git: join(dir, 'repo'), commit: 'abcdef1' });
    writeFileSync(join(dir, 'task.md'), '换一个任务\n');
    const [second] = loadCases([join(dir, 'case.json')]);
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.repoSha256).toBe(first.repoSha256);
  });

  it('wants exactly one of prompt and promptFile, and well-formed setup commands', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'fx'));
    const problems = validateCase(
      {
        id: 'x',
        prompt: 'p',
        promptFile: 'missing.md',
        repo: { fixture: 'fx' },
        setup: [{ id: 'empty' }],
      },
      dir
    );
    expect(problems).toEqual([
      'give the task as prompt or promptFile (one of them)',
      'promptFile missing.md not found',
      'setup[0] needs argv or shell (one of them)',
    ]);
  });

  it('tells a git remote from a local path', () => {
    expect(isGitUrl('https://example.invalid/org/repo.git')).toBe(true);
    expect(isGitUrl('git@example.invalid:org/repo.git')).toBe(true);
    expect(isGitUrl('file:///srv/repo.git')).toBe(true);
    expect(isGitUrl('F:\\work\\repo')).toBe(false);
    expect(isGitUrl('../repos/service')).toBe(false);
  });
});

describe('stats', () => {
  it('gives the mean and the sample standard deviation', () => {
    const s = spread([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s?.mean).toBe(5);
    expect(fmt(s?.sd ?? 0, 3)).toBe('2.138');
    expect(s?.median).toBe(4.5);
    expect(meanSd([3])).toBe('3');
    expect(meanSd([])).toBe('—');
  });
});

describe('secrets', () => {
  it('redacts every occurrence, URL-encoded ones included', () => {
    const redact = makeRedactor(['sk-secret/123']);
    expect(redact('a sk-secret/123 b sk-secret%2F123')).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it('finds files that still hold a secret', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'deep'));
    writeFileSync(join(dir, 'clean.txt'), 'nothing here');
    writeFileSync(join(dir, 'deep', 'leak.txt'), 'key=sk-secret-123');
    expect(scanForSecrets(dir, ['sk-secret-123'])).toEqual([join(dir, 'deep', 'leak.txt')]);
  });
});

function record(arm: string, caseId: string, passed: boolean, steps: number): RunRecord {
  return {
    schema: 'ab-eval.run/1',
    runId: `${caseId}-${arm}`,
    suiteRunId: 's',
    timestamp: '2026-10-14T00:00:00Z',
    case: { id: caseId, sha256: 'x', repoSha256: 'y' },
    arm: { id: arm, client: arm === 'claude-code' ? 'claude-code' : 'pilab' },
    rep: 1,
    order: 1,
    model: 'm',
    effort: 'high',
    gateway: { kind: 'fake', id: 'sha256:0' },
    status: 'completed',
    passed,
    checks: [{ id: 'command:tests', kind: 'command', passed, detail: {} }],
    failureTags: passed ? [] : ['check:command:tests'],
    metrics: {
      durationMs: 1000,
      wallMs: 1500,
      steps,
      toolCalls: steps - 1,
      toolErrors: 0,
      unknownToolCalls: 0,
      nonZeroExits: 0,
      pendingToolCalls: 0,
      subagentToolCalls: 0,
      tools: {},
      categories: { read: { calls: 2, errors: 0, unknown: 0, nonZeroExits: 0 } },
      tokens: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, total: 100 },
      tokensSource: 'test',
      changes: { files: 1, added: 1, deleted: 1, lines: 2 },
    },
    answer: { chars: 0, text: '' },
    client: {},
    baseCommit: 'abc',
    artifacts: { record: `runs/${caseId}/${arm}/1/record.json` },
    errors: [],
  };
}

describe('renderReport', () => {
  it('compares arms per case, against the first arm as the baseline', () => {
    const manifest = {
      schema: 'ab-eval.suite/1',
      suiteRunId: 's',
      label: 'unit',
      startedAt: '2026-10-14T00:00:00Z',
      model: 'm',
      effort: 'high',
      runs: 1,
      gateway: { kind: 'fake', id: 'sha256:0' },
      arms: [
        { id: 'pilab', client: 'pilab' },
        { id: 'claude-code', client: 'claude-code' },
      ],
      cases: [{ id: 'c1', sha256: 'x', repoSha256: 'y' }],
      suiteVersion: 'v',
      stamp: {
        harness: { commit: '0123456789abcdef', branch: 'b', dirty: false },
        appVersion: '1',
        node: 'v24',
        platform: 'p',
        osRelease: 'r',
        dsh: { 'dsh-base': '0.1.7-rc.2' },
        catalog: {},
        fakeGatewaySha256: 'f',
      },
    } satisfies SuiteManifest;
    const text = renderReport([
      {
        dir: 'd',
        manifest,
        records: [record('pilab', 'c1', false, 9), record('claude-code', 'c1', true, 5)],
      },
    ]);
    // Per case × arm: passes with their interval, then the means.
    expect(text).toContain('| c1 | pilab | 0/1 · 0%（0–79%） | 9 |');
    expect(text).toContain('| c1 | claude-code | 1/1 · 100%（21–100%） | 5 |');
    // Against the baseline, per case and over all cases.
    expect(text).toContain('| c1 | claude-code | +100 | -4 |');
    expect(text).toContain('| **全部用例** | claude-code | +100 | -4 |');
    // The spread table, and the failing run.
    expect(text).toContain('| c1 | pilab | 1 | 9 | 8 | 0 | 100 | 1 | 2 |');
    expect(text).toContain('| c1 | pilab | 1 | completed | check:command:tests |');
  });

  it('gives pass rates a Wilson interval that stays wide for few runs', () => {
    const [low, high] = wilson(2, 3);
    expect(fmt(low, 3)).toBe('0.208');
    expect(fmt(high, 3)).toBe('0.939');
    expect(wilson(0, 0)).toEqual([0, 1]);
    const runs = [record('a', 'c', true, 1), record('a', 'c', true, 1), record('a', 'c', false, 1)];
    expect(passCell(runs)).toBe('2/3 · 67%（21–94%）');
  });
});
