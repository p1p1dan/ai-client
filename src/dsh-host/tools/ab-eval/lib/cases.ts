/** Loads and validates case files (cases/*.json); a bad case fails the suite before any run. */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CaseFile, FakeStep, LoadedCase, PatternCheck } from './types.ts';
import { treeHash } from './workspace.ts';

export const DEFAULT_TIME_MS = 15 * 60_000;
export const DEFAULT_MAX_STEPS = 60;

const FAKE_OPS = new Set<FakeStep['op']>([
  'cwd',
  'shell',
  'read',
  'edit',
  'write',
  'grep',
  'glob',
  'call',
  'answer',
]);

function caseFilesIn(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(path, name));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function checkPatterns(list: unknown, where: string, problems: string[]): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    problems.push(`${where} must be an array`);
    return;
  }
  for (const [index, item] of (list as PatternCheck[]).entries()) {
    if (typeof item?.pattern !== 'string') {
      problems.push(`${where}[${index}].pattern must be a string`);
      continue;
    }
    try {
      new RegExp(item.pattern, item.flags);
    } catch (error) {
      problems.push(`${where}[${index}]: ${String(error)}`);
    }
    if (item.in !== undefined && !['added', 'content', 'answer'].includes(item.in)) {
      problems.push(`${where}[${index}].in must be added, content or answer`);
    }
    if (item.paths !== undefined && !isStringArray(item.paths)) {
      problems.push(`${where}[${index}].paths must be an array of strings`);
    }
  }
}

/** Problems with one parsed case file; empty when it is usable. */
export function validateCase(raw: unknown, dir: string): string[] {
  const problems: string[] = [];
  const c = raw as Partial<CaseFile>;
  if (typeof c?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c.id)) {
    problems.push('id must match [A-Za-z0-9][A-Za-z0-9._-]*');
  }
  if (typeof c?.prompt !== 'string' || c.prompt.trim() === '') problems.push('prompt is required');
  const repo = c?.repo as Record<string, unknown> | undefined;
  if (typeof repo?.fixture === 'string') {
    if (!existsSync(join(dir, repo.fixture)))
      problems.push(`repo.fixture ${repo.fixture} not found`);
  } else if (typeof repo?.git === 'string') {
    if (typeof repo.commit !== 'string' || repo.commit === '')
      problems.push('repo.commit is required with repo.git');
  } else {
    problems.push('repo needs fixture, or git and commit');
  }
  const checks = c?.checks;
  if (checks !== undefined) {
    for (const key of ['mustChange', 'mustNotChange', 'ignore'] as const) {
      if (checks[key] !== undefined && !isStringArray(checks[key])) {
        problems.push(`checks.${key} must be an array of strings`);
      }
    }
    for (const [index, command] of (checks.commands ?? []).entries()) {
      const hasArgv = isStringArray(command?.argv) && command.argv.length > 0;
      const hasShell = typeof command?.shell === 'string' && command.shell !== '';
      if (hasArgv === hasShell)
        problems.push(`checks.commands[${index}] needs argv or shell (one of them)`);
    }
    checkPatterns(checks.forbidden, 'checks.forbidden', problems);
    checkPatterns(checks.required, 'checks.required', problems);
    if (checks.overlay !== undefined && !existsSync(join(dir, checks.overlay))) {
      problems.push(`checks.overlay ${checks.overlay} not found`);
    }
  }
  for (const key of ['timeMs', 'maxSteps'] as const) {
    const value = c?.budget?.[key];
    if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
      problems.push(`budget.${key} must be a positive integer`);
    }
  }
  if (c?.judge !== undefined && typeof c.judge.rubric !== 'string')
    problems.push('judge.rubric must be a string');
  if (c?.fakeModel !== undefined) {
    if (!Array.isArray(c.fakeModel.steps)) problems.push('fakeModel.steps must be an array');
    for (const [index, step] of (c.fakeModel.steps ?? []).entries()) {
      if (!FAKE_OPS.has(step?.op)) problems.push(`fakeModel.steps[${index}].op is not a known op`);
    }
  }
  return problems;
}

/** Every case under `paths` (files, or directories of *.json), in a stable order. */
export function loadCases(paths: readonly string[]): LoadedCase[] {
  const files = paths.flatMap((path) => caseFilesIn(resolve(path)));
  const cases: LoadedCase[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      problems.push(`${file}: ${String(error)}`);
      continue;
    }
    const dir = dirname(file);
    const found = validateCase(raw, dir);
    if (found.length > 0) {
      problems.push(...found.map((problem) => `${file}: ${problem}`));
      continue;
    }
    const c = raw as CaseFile;
    if (cases.some((other) => other.id === c.id)) {
      problems.push(`${file}: duplicate case id ${c.id}`);
      continue;
    }
    cases.push({
      ...c,
      file,
      dir,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      repoSha256:
        'fixture' in c.repo
          ? treeHash(join(dir, c.repo.fixture))
          : createHash('sha256').update(`${c.repo.git}@${c.repo.commit}`).digest('hex'),
      ...(c.checks?.overlay ? { overlayDir: join(dir, c.checks.overlay) } : {}),
      budgetResolved: {
        timeMs: c.budget?.timeMs ?? DEFAULT_TIME_MS,
        maxSteps: c.budget?.maxSteps ?? DEFAULT_MAX_STEPS,
      },
    });
  }
  if (problems.length > 0) throw new Error(`invalid cases:\n  ${problems.join('\n  ')}`);
  return cases;
}

/** The suite's version (§15): one hash over every case and fixture hash, in order. */
export function suiteVersion(cases: readonly LoadedCase[]): string {
  const hash = createHash('sha256');
  for (const c of cases) hash.update(`${c.id}\0${c.sha256}\0${c.repoSha256}\0`);
  return hash.digest('hex').slice(0, 16);
}
