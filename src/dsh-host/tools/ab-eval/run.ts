/**
 * PiLab (DSH host) vs Claude Code, headless, on the same coding tasks
 * (tools/ab-eval/README.md). Every case × arm × repetition runs in a fresh
 * sandbox on a clean repository copy, against one gateway, one model and one
 * effort, with every approval automatic.
 *
 *   node src/dsh-host/tools/ab-eval/run.ts [--gateway fake|real] [--runs 3]
 *     [--arms pilab,claude-code] [--model claude-opus-5-5] [--effort high]
 *     [--cases <file|dir>]... [--case <id,...>] [--judge] [--judge-model <id>]
 *     [--label <name>] [--out <dir>] [--scratch <dir>] [--keep-workspaces]
 *     [--claude-bin <path>] [--git-bash <path>] [--allow-ancestor-instructions]
 *
 * `--gateway real` reads AB_BASE_URL (the gateway root, without /v1) and
 * AB_API_KEY from the environment; neither is written anywhere. The default
 * is the local fake gateway, which never leaves 127.0.0.1.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { killAllTracked } from './lib/proc.ts';
import { runSuite } from './lib/suite.ts';

const abDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(abDir, '..', '..', '..', '..');

const { values } = parseArgs({
  options: {
    cases: { type: 'string', multiple: true },
    case: { type: 'string' },
    arms: { type: 'string', default: 'pilab,claude-code' },
    runs: { type: 'string', default: '3' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    effort: { type: 'string', default: 'high' },
    gateway: { type: 'string', default: 'fake' },
    out: { type: 'string' },
    label: { type: 'string' },
    scratch: { type: 'string' },
    'keep-workspaces': { type: 'boolean', default: false },
    judge: { type: 'boolean', default: false },
    'judge-model': { type: 'string' },
    'claude-bin': { type: 'string' },
    'git-bash': { type: 'string' },
    'allow-ancestor-instructions': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  process.stdout.write(
    'usage: node src/dsh-host/tools/ab-eval/run.ts [--gateway fake|real] [--runs N] [--arms a,b] ' +
      '[--model id] [--effort level] [--cases path]... [--case id,...] [--judge] [--label name]\n' +
      'see src/dsh-host/tools/ab-eval/README.md\n'
  );
  process.exit(0);
}
if (values.gateway !== 'fake' && values.gateway !== 'real') {
  process.stderr.write('--gateway must be fake or real\n');
  process.exit(2);
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
  const result = await runSuite({
    repoRoot,
    abDir,
    casePaths: values.cases && values.cases.length > 0 ? values.cases : [resolve(abDir, 'cases')],
    ...(values.case
      ? {
          caseFilter: values.case
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        }
      : {}),
    arms: values.arms,
    runs: Number(values.runs),
    model: values.model,
    effort: values.effort,
    gateway: values.gateway,
    ...(values.out ? { outDir: resolve(values.out) } : {}),
    label: values.label ?? values.gateway,
    ...(values.scratch ? { scratch: resolve(values.scratch) } : {}),
    keepWorkspaces: values['keep-workspaces'],
    judge: values.judge,
    ...(values['judge-model'] ? { judgeModel: values['judge-model'] } : {}),
    ...(values['claude-bin'] ? { claudeBin: values['claude-bin'] } : {}),
    ...(values['git-bash'] ? { gitBash: values['git-bash'] } : {}),
    capture: false,
    allowAncestorInstructions: values['allow-ancestor-instructions'],
    log: (line) => process.stdout.write(`${line}\n`),
  });
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
