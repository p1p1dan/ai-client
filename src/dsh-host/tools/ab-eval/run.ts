/**
 * PiLab (DSH host), PiLab+SDK (route B's Claude Agent SDK host) and Claude
 * Code, headless, on the same coding tasks (tools/ab-eval/README.md). Every
 * case × arm × repetition runs in a fresh sandbox on a clean repository copy,
 * against one gateway, one model and one effort, with every approval automatic.
 *
 *   node src/dsh-host/tools/ab-eval/run.ts [--gateway fake|real] [--runs 3]
 *     [--arms pilab,pilab-sdk,claude-code] [--model claude-opus-5-5] [--effort high]
 *     [--cases <file|dir>]... [--case <id,...>] [--judge] [--judge-model <id>]
 *     [--label <name>] [--out <dir>] [--scratch <dir>] [--keep-workspaces]
 *     [--claude-bin <path>] [--git-bash <path>] [--allow-ancestor-instructions]
 *     [--dry-run [--probe]] [--check-cases] [--resume <suite dir> [--retry-errors]]
 *
 * `--gateway real` reads AB_BASE_URL (the gateway root, without /v1) and
 * AB_API_KEY from the environment; neither is written anywhere. The default
 * is the local fake gateway, which never leaves 127.0.0.1. `--dry-run` checks
 * everything and starts nothing (`--probe` adds one tiny request to the
 * gateway). `--check-cases` prepares every case, runs its setup and its checks
 * against the untouched repository, with no model: a case whose checks all
 * pass there cannot fail anyone. `--resume` continues a suite: its settings are the defaults, runs
 * already recorded are kept, `--runs` may add repetitions, and
 * `--retry-errors` runs again what ended in a client or setup error.
 */

import { rmSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkCases } from './lib/caseCheck.ts';
import { loadCases } from './lib/cases.ts';
import { probeGateway } from './lib/gateway.ts';
import { killAllTracked } from './lib/proc.ts';
import { planSuite, runSuite, type SuiteOptions } from './lib/suite.ts';
import { loadSuite } from './lib/summary.ts';

const abDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(abDir, '..', '..', '..', '..');

const { values } = parseArgs({
  options: {
    cases: { type: 'string', multiple: true },
    case: { type: 'string' },
    arms: { type: 'string' },
    runs: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    gateway: { type: 'string' },
    out: { type: 'string' },
    label: { type: 'string' },
    scratch: { type: 'string' },
    'keep-workspaces': { type: 'boolean', default: false },
    judge: { type: 'boolean' },
    'judge-model': { type: 'string' },
    'claude-bin': { type: 'string' },
    'git-bash': { type: 'string' },
    'allow-ancestor-instructions': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    probe: { type: 'boolean', default: false },
    'check-cases': { type: 'boolean', default: false },
    resume: { type: 'string' },
    'retry-errors': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  process.stdout.write(
    'usage: node src/dsh-host/tools/ab-eval/run.ts [--gateway fake|real] [--runs N] [--arms a,b] ' +
      '[--model id] [--effort level] [--cases path]... [--case id,...] [--judge] [--label name] ' +
      '[--dry-run [--probe]] [--check-cases] [--resume dir [--retry-errors]]\n' +
      'see src/dsh-host/tools/ab-eval/README.md\n'
  );
  process.exit(0);
}

// A resumed suite's own settings are the defaults; anything given must match them.
const earlier = values.resume ? loadSuite(resolve(values.resume)).manifest : undefined;
const gateway = values.gateway ?? earlier?.gateway.kind ?? 'fake';
if (gateway !== 'fake' && gateway !== 'real') {
  process.stderr.write('--gateway must be fake or real\n');
  process.exit(2);
}
const ids = (text: string) =>
  text
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
const caseFilter = values.case ? ids(values.case) : earlier?.caseFilter;
const judge = values.judge ?? earlier?.judge !== undefined;
const judgeModel = values['judge-model'] ?? earlier?.judge?.model;
const options: SuiteOptions = {
  repoRoot,
  abDir,
  casePaths:
    values.cases && values.cases.length > 0
      ? values.cases.map((path) => resolve(path))
      : (earlier?.casePaths ?? [resolve(abDir, 'cases')]),
  ...(caseFilter ? { caseFilter } : {}),
  arms: values.arms ?? earlier?.arms.map((arm) => arm.id).join(',') ?? 'pilab,claude-code',
  runs: Number(values.runs ?? earlier?.runs ?? 3),
  model: values.model ?? earlier?.model ?? 'claude-opus-5-5',
  effort: values.effort ?? earlier?.effort ?? 'high',
  gateway,
  ...(values.out ? { outDir: resolve(values.out) } : {}),
  label: values.label ?? earlier?.label ?? gateway,
  ...(values.scratch ? { scratch: resolve(values.scratch) } : {}),
  keepWorkspaces: values['keep-workspaces'],
  judge,
  ...(judgeModel ? { judgeModel } : {}),
  ...(values['claude-bin'] ? { claudeBin: values['claude-bin'] } : {}),
  ...(values['git-bash'] ? { gitBash: values['git-bash'] } : {}),
  capture: false,
  allowAncestorInstructions: values['allow-ancestor-instructions'],
  ...(values.resume ? { resume: resolve(values.resume) } : {}),
  retryErrors: values['retry-errors'],
  log: (line) => process.stdout.write(`${line}\n`),
};

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

if (values['check-cases']) {
  try {
    let cases = loadCases(options.casePaths);
    if (options.caseFilter) cases = cases.filter((c) => options.caseFilter?.includes(c.id));
    const scratchRoot = options.scratch ?? join(os.tmpdir(), 'ab-eval');
    const scratchDir = join(scratchRoot, `check-cases-${process.pid}`);
    const results = await checkCases(cases, scratchRoot, scratchDir, (line) =>
      process.stdout.write(`${line}\n`)
    );
    rmSync(scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    const bad = results.filter((result) => result.error || result.toothless);
    process.stdout.write(
      bad.length === 0
        ? `\nall ${results.length} case(s) are ready, and each fails at least one check when nothing is done\n`
        : `\n${bad.length} of ${results.length} case(s) need work: ${bad.map((result) => result.id).join(', ')}\n`
    );
    process.exit(bad.length === 0 ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (values['dry-run']) {
  try {
    const plan = planSuite(options);
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(
      `dry run: ${plan.cases.length} case(s) × ${plan.arms.length} arm(s) × ${plan.runs} run(s) = ` +
        `${plan.cases.length * plan.arms.length * plan.runs} runs; gateway ${options.gateway}; ` +
        `model ${options.model}/${options.effort}${options.judge ? `; judge ${options.judgeModel ?? options.model}` : ''}`
    );
    for (const c of plan.cases) {
      const source =
        'fixture' in c.repo ? `fixture ${c.repo.fixture}` : `git ${c.repo.git} @ ${c.repo.commit}`;
      out(
        `  ${c.id}: ${source}; ${c.setup?.length ?? 0} setup, ${c.checks?.commands?.length ?? 0} check command(s); ` +
          `budget ${c.budgetResolved.timeMs / 1000} s / ${c.budgetResolved.maxSteps} steps${c.judge ? '; judged' : ''}`
      );
    }
    out(`arms: ${plan.arms.map((arm) => arm.id).join(', ')}`);
    if (plan.claudeBin)
      out(`Claude Code: ${plan.claudeBin}${plan.gitBash ? `; Git Bash: ${plan.gitBash}` : ''}`);
    out(`scratch: ${plan.scratchRoot}`);
    out(`at most ${duration(plan.maxMs)} of agent time (every run using its whole time budget)`);
    if (values.probe && options.gateway === 'real' && plan.problems.length === 0) {
      const probe = await probeGateway(options.model);
      out(
        probe.ok
          ? `gateway probe: HTTP ${probe.status} in ${probe.ms} ms, model ${probe.model ?? '?'}`
          : `gateway probe FAILED: ${probe.error}`
      );
      if (!probe.ok) plan.problems.push('the gateway probe failed');
    }
    if (plan.problems.length > 0) {
      out(`problems:\n  ${plan.problems.join('\n  ')}`);
      process.exit(1);
    }
    out('no problems found');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// A PiLab host stops by itself once this process is gone (IPC disconnect);
// Claude Code runs in its own process group on POSIX and is killed here.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    killAllTracked();
    process.exit(130);
  });
}

try {
  const result = await runSuite(options);
  const passed = result.records.filter((record) => record.passed).length;
  process.stdout.write(
    `\n${passed}/${result.records.length} runs passed. Report: ${resolve(result.outDir, 'report.md')}\n`
  );
  const leaks = [...(result.manifest.outcome?.leakScan.files ?? []), ...result.scratchLeaks];
  if (leaks.length > 0) {
    process.stderr.write(`SECRET FOUND in: ${leaks.join(', ')}\n`);
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
