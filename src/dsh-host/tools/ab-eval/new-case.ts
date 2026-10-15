/**
 * Scaffolds a case file for a field task (tools/ab-eval/README.md, "怎么加一个用例").
 *
 *   node src/dsh-host/tools/ab-eval/new-case.ts --id <id> --out <cases dir>
 *     (--git <local clone or URL> [--commit <ref or sha>] | --dir <directory>)
 *     (--prompt <text> | --prompt-file <file>)
 *     [--test <shell command>]... [--setup <shell command>]...
 *     [--must-change <glob>]... [--must-not-change <glob>]...
 *     [--answer-pattern <regex>]... [--rubric <text>] [--title <text>]
 *     [--time-min 15] [--max-steps 60] [--force]
 *
 * A local clone's ref (default HEAD) is resolved to its commit id now, so the
 * case keeps naming the same tree; a URL needs a full commit id. The file is
 * validated as the suite would load it, then the next steps are printed.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isGitUrl, loadCases } from './lib/cases.ts';
import { git } from './lib/proc.ts';
import type { CaseFile, CommandCheck } from './lib/types.ts';

const abDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(abDir, '..', '..', '..', '..');

const { values } = parseArgs({
  options: {
    id: { type: 'string' },
    out: { type: 'string' },
    git: { type: 'string' },
    commit: { type: 'string' },
    dir: { type: 'string' },
    prompt: { type: 'string' },
    'prompt-file': { type: 'string' },
    test: { type: 'string', multiple: true },
    setup: { type: 'string', multiple: true },
    'must-change': { type: 'string', multiple: true },
    'must-not-change': { type: 'string', multiple: true },
    'answer-pattern': { type: 'string', multiple: true },
    rubric: { type: 'string' },
    title: { type: 'string' },
    'time-min': { type: 'string', default: '15' },
    'max-steps': { type: 'string', default: '60' },
    force: { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const id = values.id ?? fail('--id is required');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail('--id must match [A-Za-z0-9][A-Za-z0-9._-]*');
const outDir = resolve(values.out ?? fail('--out <cases dir> is required'));
if (outDir.startsWith(join(repoRoot, 'src'))) {
  process.stderr.write(
    'note: this repository is public; keep field cases (and their prompts) outside it unless they are meant to ship\n'
  );
}
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${id}.json`);
if (existsSync(file) && !values.force) fail(`${file} exists (pass --force to replace it)`);
if (!values.git === !values.dir) fail('give the repository as --git or --dir (one of them)');
if (!values.prompt === !values['prompt-file'])
  fail('give the task as --prompt or --prompt-file (one of them)');

/** A path as the case file should hold it: relative when it sits beside the case. */
function casePath(path: string): string {
  const rel = relative(outDir, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : path;
}

let repo: CaseFile['repo'];
if (values.git) {
  if (isGitUrl(values.git)) {
    const commit = values.commit ?? fail('a git URL needs --commit <full commit id>');
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(commit))
      fail('--commit must be a full commit id for a URL');
    repo = { git: values.git, commit: commit.toLowerCase() };
  } else {
    const clone = resolve(values.git);
    if (!existsSync(clone)) fail(`${clone} does not exist`);
    const ref = values.commit ?? 'HEAD';
    let commit: string;
    try {
      commit = git(clone, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    } catch {
      fail(`${ref} is not a commit in ${clone}`);
    }
    if (git(clone, ['status', '--porcelain']).trim() !== '') {
      process.stderr.write(
        `note: ${clone} has uncommitted changes; the case uses commit ${commit} only\n`
      );
    }
    repo = { git: casePath(clone), commit };
  }
} else {
  const dir = resolve(String(values.dir));
  if (!existsSync(dir)) fail(`${dir} does not exist`);
  process.stderr.write(
    'note: a directory is copied for every run (without .git and node_modules)\n'
  );
  repo = { fixture: casePath(dir) };
}

let promptField: Pick<CaseFile, 'prompt' | 'promptFile'>;
if (values['prompt-file']) {
  const source = resolve(values['prompt-file']);
  if (!existsSync(source)) fail(`${source} does not exist`);
  const inside = casePath(source);
  if (inside === source) {
    const copy = `${id}.prompt.md`;
    copyFileSync(source, join(outDir, copy));
    promptField = { promptFile: copy };
  } else {
    promptField = { promptFile: inside };
  }
} else {
  promptField = { prompt: String(values.prompt) };
}

const commands = (list: string[] | undefined, prefix: string): CommandCheck[] =>
  (list ?? []).map((shell, index) => ({
    id: index === 0 ? prefix : `${prefix}-${index + 1}`,
    shell,
    ...(prefix === 'test' ? { expectExit: 0, timeoutMs: 300_000 } : { timeoutMs: 900_000 }),
  }));
const tests = commands(values.test, 'test');
const setup = commands(values.setup, 'setup');
const answerPatterns = (values['answer-pattern'] ?? []).map((pattern, index) => ({
  id: `answer-${index + 1}`,
  pattern,
  in: 'answer' as const,
}));
const caseFile: CaseFile = {
  id,
  ...(values.title ? { title: values.title } : {}),
  tier: 'field',
  repo,
  ...promptField,
  ...(setup.length > 0 ? { setup } : {}),
  checks: {
    ...(tests.length > 0 ? { commands: tests } : {}),
    ...(values['must-change'] ? { mustChange: values['must-change'] } : {}),
    ...(values['must-not-change'] ? { mustNotChange: values['must-not-change'] } : {}),
    ...(answerPatterns.length > 0 ? { required: answerPatterns } : {}),
  },
  budget: {
    timeMs: Math.round(Number(values['time-min']) * 60_000),
    maxSteps: Number(values['max-steps']),
  },
  ...(values.rubric ? { judge: { rubric: values.rubric } } : {}),
};
writeFileSync(file, `${JSON.stringify(caseFile, null, 2)}\n`);
try {
  loadCases([file]);
} catch (error) {
  fail(`wrote ${file}, but it does not load:\n${error instanceof Error ? error.message : error}`);
}
const run = 'node src/dsh-host/tools/ab-eval/run.ts';
process.stdout.write(
  [
    `wrote ${file}`,
    '',
    'next:',
    `  1. ${run} --cases "${outDir}" --case ${id} --check-cases`,
    '     (setup works, and the checks fail on the untouched repository; add checks until they do)',
    `  2. ${run} --cases "${outDir}" --case ${id} --runs 1`,
    '     (the whole pipeline on the local fake gateway)',
    `  3. ${run} --cases "${outDir}" --gateway real --runs 3 --judge --label <name>`,
    '',
    `checks so far: ${tests.length} command(s), ${values['must-change']?.length ?? 0} must-change, ` +
      `${values['must-not-change']?.length ?? 0} must-not-change, ${answerPatterns.length} answer pattern(s)` +
      `${caseFile.checks && Object.keys(caseFile.checks).length === 0 ? ' — none yet: the case cannot fail' : ''}`,
    `see ${basename(abDir)}/README.md for forbidden/required patterns and hidden acceptance tests (overlay)`,
    '',
  ].join('\n')
);
