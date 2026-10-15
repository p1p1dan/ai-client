/**
 * End-to-end self-test of the harness on the local fake gateway (no model, no
 * network beyond 127.0.0.1). PiLab, Claude Code and a PiLab variant each run
 * every bundled case plus the self-test cases (the fake model gives up; the
 * step and time budgets run out; a git source pinned to an older commit),
 * once, with the judge on. Then it asserts:
 *
 * - every record matches its case's `fakeModel.expect` (status, pass or fail,
 *   steps, tool calls, errors, unknown tools, non-zero exits, changed files,
 *   failure tags);
 * - for every case all arms completed, both clients report identical,
 *   non-zero token totals (the fake gateway bills per step), the gateway saw
 *   exactly the model calls the records count, and the judge scored it;
 * - each client ran with what the harness asked for (Claude Code on the
 *   environment's key in bypass mode, with no MCP server or plugin a user
 *   configuration would add; PiLab on the requested model and effort);
 * - the variant reached the host: its system prompt carries the marker its
 *   home patch adds, the baseline's does not;
 * - isolation: no captured request mentions the real ~/.claude or ~/.dsh, and
 *   the key is in no output or sandbox file.
 *
 *   node src/dsh-host/tools/ab-eval/selftest.ts [--claude-bin <path>] [--git-bash <path>] [--keep]
 */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCases } from './lib/cases.ts';
import { git, killAllTracked } from './lib/proc.ts';
import { runSuite } from './lib/suite.ts';
import type { FakeExpect, RunRecord } from './lib/types.ts';

const abDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(abDir, '..', '..', '..', '..');
const MODEL = 'claude-opus-5-5';
const EFFORT = 'high';
const ARMS = ['pilab', 'claude-code', 'pilab+selftest-persona'];
const VARIANT_ARM = 'pilab+selftest-persona';
const VARIANT_MARKER = 'AB-EVAL-VARIANT-MARKER';
const FAKE_JUDGE_SCORE = 7;

const { values } = parseArgs({
  options: {
    'claude-bin': { type: 'string' },
    'git-bash': { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    killAllTracked();
    process.exit(130);
  });
}

/**
 * A git source the harness must clone and check out at the pinned commit: the
 * retry fixture committed, then a later commit adding LATER.md, which the
 * workspace must therefore not have.
 */
function gitSourceCase(): { dir: string; file: string } {
  const dir = mkdtempSync(join(os.tmpdir(), 'ab-eval-selftest-git-'));
  const origin = join(dir, 'origin');
  cpSync(join(abDir, 'fixtures', 'retry-policy'), origin, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: dir,
    USERPROFILE: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'ab-eval',
    GIT_AUTHOR_EMAIL: 'ab-eval@example.invalid',
    GIT_COMMITTER_NAME: 'ab-eval',
    GIT_COMMITTER_EMAIL: 'ab-eval@example.invalid',
  };
  git(origin, ['init', '-q', '-b', 'main'], env);
  git(origin, ['add', '-A'], env);
  git(origin, ['commit', '-q', '--no-verify', '-m', 'base'], env);
  const commit = git(origin, ['rev-parse', 'HEAD'], env).trim();
  writeFileSync(join(origin, 'LATER.md'), 'Added after the commit the case pins.\n');
  git(origin, ['add', '-A'], env);
  git(origin, ['commit', '-q', '--no-verify', '-m', 'later'], env);
  const file = join(dir, 'git-source.json');
  writeFileSync(
    file,
    JSON.stringify(
      {
        id: 'selftest-git-source',
        title: '自测：git 来源要检出用例指定的提交',
        tier: 'selftest',
        repo: { git: origin, commit },
        prompt: '（自测，git 来源）默认重试策略最多尝试几次？',
        checks: {
          mustNotChange: ['**'],
          required: [{ id: 'names-max-attempts', pattern: 'maxAttempts', in: 'answer' }],
          forbidden: [
            { id: 'pinned-commit', pattern: '[\\s\\S]', in: 'content', paths: ['LATER.md'] },
          ],
        },
        budget: { timeMs: 120000, maxSteps: 10 },
        fakeModel: {
          steps: [
            { op: 'cwd' },
            { op: 'read', path: 'src/policy.js' },
            { op: 'answer', text: '默认最多尝试 5 次（maxAttempts: 5，src/policy.js:3）。' },
          ],
          expect: { passed: true, steps: 3, toolCalls: 2, changedFiles: 0 },
        },
      },
      null,
      2
    )
  );
  return { dir, file };
}

const generated = gitSourceCase();
const casePaths = [join(abDir, 'cases'), join(abDir, 'selftest', 'cases'), generated.file];
const cases = loadCases(casePaths);
const result = await runSuite({
  repoRoot,
  abDir,
  casePaths,
  arms: ARMS.join(','),
  runs: 1,
  model: MODEL,
  effort: EFFORT,
  gateway: 'fake',
  label: 'selftest',
  keepWorkspaces: values.keep,
  judge: true,
  ...(values['claude-bin'] ? { claudeBin: values['claude-bin'] } : {}),
  ...(values['git-bash'] ? { gitBash: values['git-bash'] } : {}),
  capture: true,
  allowAncestorInstructions: false,
  log: (line) => process.stdout.write(`${line}\n`),
});

const failures: string[] = [];
const expectThat = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};
const label = (record: RunRecord) => `${record.case.id} × ${record.arm.id}`;
const metricOf: Record<
  Exclude<keyof FakeExpect, 'status' | 'passed' | 'failureTags'>,
  (r: RunRecord) => number
> = {
  steps: (r) => r.metrics.steps,
  toolCalls: (r) => r.metrics.toolCalls,
  toolErrors: (r) => r.metrics.toolErrors,
  unknownToolCalls: (r) => r.metrics.unknownToolCalls,
  nonZeroExits: (r) => r.metrics.nonZeroExits,
  changedFiles: (r) => r.metrics.changes.files,
};

function systemPrompts(record: RunRecord): string {
  const file = join(result.outDir, record.artifacts.client, 'session-main.jsonl');
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          data?: { message?: { content?: Array<{ text?: string }> } };
        }
    )
    .filter((event) => event.type === 'system/message')
    .flatMap((event) => (event.data?.message?.content ?? []).map((block) => block.text ?? ''))
    .join('\n');
}

const expectedRuns = cases.length * ARMS.length;
expectThat(
  result.records.length === expectedRuns,
  `expected ${expectedRuns} records, got ${result.records.length}`
);

for (const record of result.records) {
  const c = cases.find((item) => item.id === record.case.id);
  const expect = c?.fakeModel?.expect ?? {};
  const name = label(record);
  const status = expect.status ?? 'completed';
  expectThat(
    record.status === status,
    `${name}: status ${record.status}, expected ${status} (${record.errors.join('; ')})`
  );
  expectThat(record.passed === (expect.passed ?? true), `${name}: passed is ${record.passed}`);
  for (const [key, read] of Object.entries(metricOf)) {
    const want = expect[key as keyof typeof metricOf];
    if (want !== undefined) {
      expectThat(read(record) === want, `${name}: ${key} is ${read(record)}, expected ${want}`);
    }
  }
  for (const tag of expect.failureTags ?? []) {
    expectThat(record.failureTags.includes(tag), `${name}: missing failure tag ${tag}`);
  }
  if (record.status === 'completed') {
    for (const field of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
      expectThat(
        record.metrics.tokens[field] > 0,
        `${name}: tokens.${field} is ${record.metrics.tokens[field]}`
      );
    }
  }
  if (c?.judge) {
    expectThat(
      record.judge?.score === FAKE_JUDGE_SCORE,
      `${name}: judge score ${record.judge?.score} (${record.judge?.error ?? 'no error'})`
    );
  }
  if (record.arm.client === 'claude-code') {
    expectThat(
      record.client.apiKeySource === 'ANTHROPIC_API_KEY',
      `${name}: apiKeySource ${String(record.client.apiKeySource)}`
    );
    expectThat(
      record.status === 'timeout' || record.client.permissionMode === 'bypassPermissions',
      `${name}: permissionMode ${String(record.client.permissionMode)}`
    );
    // Nothing from a user configuration: no MCP server, no plugin beyond the built-in ones.
    const plugins = Array.isArray(record.client.plugins) ? (record.client.plugins as string[]) : [];
    expectThat(
      record.client.mcpServers === 0,
      `${name}: ${String(record.client.mcpServers)} MCP servers`
    );
    expectThat(
      plugins.every((plugin) => plugin.endsWith('@builtin')),
      `${name}: non-builtin plugins ${plugins.join(', ')}`
    );
    continue;
  }
  const config = (record.client.requestConfig ?? {}) as {
    model?: string;
    reasoningEffort?: string;
  };
  expectThat(config.model === MODEL, `${name}: the request used model ${String(config.model)}`);
  expectThat(
    config.reasoningEffort === EFFORT,
    `${name}: the request used effort ${String(config.reasoningEffort)}`
  );
  expectThat(record.client.hostStopped === true, `${name}: the host did not stop cleanly`);
  const prompts = systemPrompts(record);
  expectThat(prompts.length > 0, `${name}: no system prompt in the session log`);
  const marked = prompts.includes(VARIANT_MARKER);
  if (record.arm.id === VARIANT_ARM) {
    expectThat(marked, `${name}: the variant's marker is not in the system prompt`);
    expectThat(
      Array.isArray(record.client.envOverrides) &&
        record.client.envOverrides.includes('AICLIENT_RUNTIME_LOOP_GUARD'),
      `${name}: the variant's environment override is not recorded`
    );
  } else {
    expectThat(!marked, `${name}: the baseline's system prompt carries the variant marker`);
  }
}

const log =
  result.gateway.logFile && existsSync(result.gateway.logFile)
    ? readFileSync(result.gateway.logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { decision?: string })
    : [];
const decisions = log.map((entry) => entry.decision ?? '');
for (const stray of ['ab-eval:unmatched', 'ab-eval:no-tools']) {
  const count = decisions.filter((decision) => decision === stray).length;
  expectThat(count === 0, `${count} gateway request(s) decided ${stray}`);
}
const judged = result.records.filter((record) => record.judge).length;
const judgeRequests = decisions.filter((decision) => decision === 'ab-eval:judge').length;
expectThat(
  judgeRequests === judged,
  `${judgeRequests} judge requests for ${judged} judged records`
);
for (const c of cases) {
  const records = result.records.filter((record) => record.case.id === c.id);
  if (!records.every((record) => record.status === 'completed')) continue;
  const totals = records.map((record) => `${record.arm.id}=${record.metrics.tokens.total}`);
  expectThat(
    new Set(records.map((record) => record.metrics.tokens.total)).size === 1,
    `${c.id}: token totals differ across arms (${totals.join(', ')})`
  );
  const requests = decisions.filter((decision) => decision.startsWith(`ab-eval:${c.id} `)).length;
  const steps = records.reduce((sum, record) => sum + record.metrics.steps, 0);
  expectThat(
    requests === steps,
    `${c.id}: the gateway saw ${requests} model calls, the records count ${steps}`
  );
}

const reportFile = join(result.outDir, 'report.md');
const report = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '';
expectThat(report.length > 0, 'report.md was not written');
for (const c of cases) expectThat(report.includes(c.id), `report.md does not mention ${c.id}`);
for (const arm of ARMS) expectThat(report.includes(arm), `report.md does not mention ${arm}`);

expectThat(
  result.manifest.outcome?.leakScan.clean === true,
  `the key is in output files: ${result.manifest.outcome?.leakScan.files.join(', ')}`
);
expectThat(
  result.scratchLeaks.length === 0,
  `the key is in sandbox files: ${result.scratchLeaks.join(', ')}`
);

// Isolation: no request carried the real home's Claude Code or DSH state.
const home = os.userInfo().homedir;
const forbidden = [join(home, '.claude'), join(home, '.dsh'), process.env.CLAUDE_CONFIG_DIR]
  .filter((item): item is string => !!item)
  .flatMap((path) => [path, JSON.stringify(path).slice(1, -1), path.split('\\').join('/')]);
const captureDir = result.gateway.captureDir;
const captures = captureDir && existsSync(captureDir) ? readdirSync(captureDir) : [];
expectThat(
  captures.length === log.length,
  `${captures.length} captures for ${log.length} requests`
);
for (const name of captures) {
  const body = readFileSync(join(captureDir as string, name), 'utf8');
  const hit = forbidden.find((needle) => body.includes(needle));
  expectThat(!hit, `capture ${name} mentions ${hit}`);
}

process.stdout.write(
  '\ncase × arm: status, passed, steps, tools (errors/unknown/non-zero), tokens\n'
);
for (const record of result.records) {
  const m = record.metrics;
  process.stdout.write(
    `  ${label(record).padEnd(50)} ${record.status.padEnd(12)} ${String(record.passed).padEnd(6)} ` +
      `${String(m.steps).padStart(3)} ${String(m.toolCalls).padStart(3)} (${m.toolErrors}/${m.unknownToolCalls}/${m.nonZeroExits}) ${m.tokens.total}\n`
  );
}
process.stdout.write(`\nreport: ${reportFile}\n`);
if (!values.keep) {
  for (const dir of [result.scratchDir, generated.dir]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
if (failures.length > 0) {
  process.stdout.write(
    `\nSELF-TEST FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}\n`
  );
  process.exit(1);
}
process.stdout.write(`\nSELF-TEST PASSED: ${result.records.length} runs, every assertion held.\n`);
