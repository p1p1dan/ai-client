/**
 * One suite run: every case × arm × repetition, one at a time, each in a
 * fresh sandbox with a clean repository copy. Arms rotate per case and
 * repetition so neither client always goes first. Each run leaves a record
 * (record.json and a line of records.jsonl), a normalized trace, the diff and
 * the client's raw artifacts; the report is rewritten after every run, and
 * the suite ends with a manifest carrying the version stamp and a scan
 * proving no secret reached the output.
 *
 * `planSuite` is the preflight (`--dry-run`): what would run and what stops
 * it, without starting anything. A suite can be resumed (`resume`): recorded
 * runs stay, the rest run, `runs` may grow, and runs that ended in a client
 * or setup error can be run again (`retryErrors`).
 */

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, relative } from 'node:path';
import { isGitUrl, loadCases, suiteVersion } from './cases.ts';
import { commandChecks, runCommandList, staticChecks } from './checks.ts';
import { runClaudeCode } from './claudeCode.ts';
import { type Gateway, gatewayId, realGateway, startFakeGateway } from './gateway.ts';
import { JUDGE_VERSION, type JudgeEndpoint, runJudge } from './judge.ts';
import { runPilab } from './pilab.ts';
import { runPilabSdk, sdkVersions } from './pilabSdk.ts';
import { git } from './proc.ts';
import { makeRedactor, type Redactor, scanForSecrets } from './redact.ts';
import {
  baseEnv,
  createSandbox,
  findClaude,
  findGitBash,
  instructionFilesAbove,
  packageCacheEnv,
  type Sandbox,
} from './sandbox.ts';
import { versionStamp } from './stamp.ts';
import { loadSuite, renderReport, type SuiteManifest } from './summary.ts';
import { excerpt, summarizeEvents } from './toolMetrics.ts';
import type { Arm, CheckResult, ClientRun, LoadedCase, RunRecord, RunStatus } from './types.ts';
import { parseArms } from './variants.ts';
import {
  applyOverlay,
  collectChanges,
  commitSetup,
  DEFAULT_IGNORE,
  prepareWorkspace,
} from './workspace.ts';

export interface SuiteOptions {
  repoRoot: string;
  /** src/dsh-host/tools/ab-eval */
  abDir: string;
  casePaths: string[];
  caseFilter?: string[];
  arms: string;
  runs: number;
  model: string;
  effort: string;
  gateway: 'fake' | 'real';
  outDir?: string;
  label: string;
  scratch?: string;
  keepWorkspaces: boolean;
  judge: boolean;
  judgeModel?: string;
  claudeBin?: string;
  gitBash?: string;
  /** Keep the fake gateway's request captures (the self-test reads them). */
  capture: boolean;
  allowAncestorInstructions: boolean;
  /** An earlier suite's output directory to continue. */
  resume?: string;
  /** With `resume`: run again what ended in client_error or setup_error. */
  retryErrors?: boolean;
  log: (line: string) => void;
}

export interface SuitePlan {
  cases: LoadedCase[];
  arms: Arm[];
  runs: number;
  scratchRoot: string;
  claudeBin?: string;
  gitBash?: string;
  /** What stops the suite from running. */
  problems: string[];
  /** Upper bound of the agents' time: every run using its whole time budget. */
  maxMs: number;
}

export interface SuiteResult {
  outDir: string;
  scratchDir: string;
  manifest: SuiteManifest;
  records: RunRecord[];
  gateway: Gateway;
  /** Scratch files that contained a secret before cleanup (should be none). */
  scratchLeaks: string[];
}

/** Run statuses `retryErrors` runs again: the run never got a fair go. */
const RETRIED: readonly RunStatus[] = ['client_error', 'setup_error'];

function stampId(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // A file still locked on Windows; the scratch root goes at the end anyway.
  }
}

const runKey = (caseId: string, armId: string, rep: number) => `${caseId}\0${armId}\0${rep}`;

/** The preflight: what would run, and every problem that would stop it. Starts nothing. */
export function planSuite(options: SuiteOptions): SuitePlan {
  const problems: string[] = [];
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 24) problems.push(`Node 24 or newer is required (this is ${process.version})`);
  let cases = loadCases(options.casePaths);
  if (options.caseFilter && options.caseFilter.length > 0) {
    const unknown = options.caseFilter.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length > 0) problems.push(`unknown case ids: ${unknown.join(', ')}`);
    cases = cases.filter((c) => options.caseFilter?.includes(c.id));
  }
  if (cases.length === 0) problems.push('no cases to run');
  const arms = parseArms(options.arms, join(options.abDir, 'variants'));
  if (!Number.isInteger(options.runs) || options.runs < 1)
    problems.push('--runs must be a positive integer');
  const scratchRoot = options.scratch ?? join(os.tmpdir(), 'ab-eval');
  const above = instructionFilesAbove(scratchRoot);
  if (above.length > 0 && !options.allowAncestorInstructions) {
    problems.push(
      `instruction files above the scratch directory would leak into every run: ${above.join(', ')}.` +
        ' Pick another --scratch, or pass --allow-ancestor-instructions.'
    );
  }
  const needsClaude = arms.some((arm) => arm.client === 'claude-code');
  const claudeBin = needsClaude ? findClaude(options.claudeBin) : undefined;
  if (needsClaude && !claudeBin)
    problems.push('Claude Code not found: pass --claude-bin, or set AB_CLAUDE_BIN');
  const needsSdk = arms.some((arm) => arm.client === 'pilab-sdk');
  const gitBash = needsClaude || needsSdk ? findGitBash(options.gitBash) : undefined;
  if ((needsClaude || needsSdk) && process.platform === 'win32' && !gitBash) {
    problems.push('Git Bash not found (Claude Code needs it on Windows): pass --git-bash');
  }
  if (needsSdk && !sdkVersions(options.repoRoot).sdk) {
    problems.push(
      'the Claude SDK host is not installed: run `npm ci` in src/claude-sdk-host (pilab-sdk arm)'
    );
  }
  if (
    arms.some((arm) => arm.client === 'pilab') &&
    !existsSync(
      join(options.repoRoot, 'src', 'dsh-host', 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    )
  ) {
    problems.push('the DSH host is not installed: run `npm ci --ignore-scripts` in src/dsh-host');
  }
  if (
    options.gateway === 'real' &&
    (!process.env.AB_BASE_URL?.trim() || !process.env.AB_API_KEY?.trim())
  ) {
    problems.push('--gateway real needs AB_BASE_URL and AB_API_KEY in the environment');
  }
  // A local git source must have the commit; a remote one is checked when cloned.
  const gitEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: os.tmpdir(),
    USERPROFILE: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const c of cases) {
    if (!('git' in c.repo) || isGitUrl(c.repo.git)) continue;
    try {
      git(c.repo.git, ['cat-file', '-e', `${c.repo.commit}^{commit}`], gitEnv);
    } catch {
      problems.push(`${c.id}: commit ${c.repo.commit} is not in ${c.repo.git}`);
    }
  }
  const maxMs =
    cases.reduce((sum, c) => sum + c.budgetResolved.timeMs, 0) *
    arms.length *
    Math.max(1, options.runs);
  return {
    cases,
    arms,
    runs: options.runs,
    scratchRoot,
    ...(claudeBin ? { claudeBin } : {}),
    ...(gitBash ? { gitBash } : {}),
    problems,
    maxMs,
  };
}

interface RunContext {
  options: SuiteOptions;
  suiteRunId: string;
  outDir: string;
  scratchDir: string;
  scratchRoot: string;
  gitCache: string;
  gateway: Gateway;
  judge?: JudgeEndpoint;
  secrets: string[];
  redact: Redactor;
  claudeBin?: string;
  gitBash?: string;
  appVersion: string;
  /** Sandbox files that contained a secret, across runs (should stay empty). */
  sandboxLeaks: string[];
}

function errorRun(status: RunStatus, error: string): ClientRun {
  return {
    status,
    error,
    durationMs: 0,
    wallMs: 0,
    answer: '',
    events: [],
    offeredTools: [],
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    tokensSource: 'none',
    info: {},
  };
}

async function runOne(
  ctx: RunContext,
  c: LoadedCase,
  arm: Arm,
  rep: number,
  order: number
): Promise<RunRecord> {
  const { options, redact } = ctx;
  const runId = `${ctx.suiteRunId}-${c.id}-${arm.id}-${rep}`;
  const runDir = join(ctx.outDir, 'runs', c.id, arm.id, String(rep));
  removeTree(runDir);
  mkdirSync(runDir, { recursive: true });
  const rel = (path: string) => relative(ctx.outDir, path).split('\\').join('/');
  const box: Sandbox = createSandbox(ctx.scratchDir, `r${order}`);
  const base = baseEnv(box, { proxies: ctx.gateway.kind === 'real' });
  const errors: string[] = [];
  const clientDir = join(runDir, 'client');
  let baseCommit = '';
  let setup: RunRecord['setup'];
  let client: ClientRun | undefined;
  try {
    baseCommit = prepareWorkspace(c, box.ws, ctx.gitCache, base);
  } catch (error) {
    client = errorRun(
      'setup_error',
      `preparing the workspace: ${error instanceof Error ? error.message : error}`
    );
  }
  if (!client && c.setup && c.setup.length > 0) {
    // Setup may need the network (package registries) and gets shared caches.
    const setupEnv = { ...baseEnv(box, { proxies: true }), ...packageCacheEnv(ctx.scratchRoot) };
    const started = performance.now();
    const results = await runCommandList(c.setup, 'setup', box.ws, setupEnv);
    setup = { ms: Math.round(performance.now() - started), results };
    const failed = results.find((result) => !result.passed);
    if (failed) {
      client = errorRun('setup_error', `setup failed: ${failed.id}`);
    } else {
      try {
        baseCommit = commitSetup(box.ws, baseCommit, base);
      } catch (error) {
        client = errorRun('setup_error', `committing setup: ${String(error)}`);
      }
    }
  }
  if (!client) {
    const common = {
      box,
      base,
      gateway: ctx.gateway,
      model: options.model,
      effort: options.effort,
      prompt: c.prompt,
      timeMs: c.budgetResolved.timeMs,
      maxSteps: c.budgetResolved.maxSteps,
      ...(arm.variant ? { variant: arm.variant } : {}),
      clientDir,
      redact,
    };
    try {
      client =
        arm.client === 'pilab'
          ? await runPilab({
              ...common,
              repoRoot: options.repoRoot,
              appVersion: ctx.appVersion,
              label: `${order}`,
            })
          : arm.client === 'pilab-sdk'
            ? await runPilabSdk({
                ...common,
                repoRoot: options.repoRoot,
                appVersion: ctx.appVersion,
                ...(ctx.gitBash ? { gitBash: ctx.gitBash } : {}),
                label: `${order}`,
              })
            : await runClaudeCode({
                ...common,
                claudeBin: ctx.claudeBin as string,
                ...(ctx.gitBash ? { gitBash: ctx.gitBash } : {}),
              });
    } catch (error) {
      client = errorRun('client_error', String(error instanceof Error ? error.message : error));
    }
  }
  if (client.error) errors.push(client.error);

  const ignore = [...DEFAULT_IGNORE, ...(c.checks?.ignore ?? [])];
  let changes: ReturnType<typeof collectChanges> = { files: [], patch: '' };
  const ranAgent = baseCommit !== '' && client.status !== 'setup_error';
  if (ranAgent) {
    try {
      changes = collectChanges(box.ws, baseCommit, ignore, base);
    } catch (error) {
      errors.push(`collecting changes: ${String(error)}`);
    }
  }
  writeFileSync(join(runDir, 'diff.patch'), redact(changes.patch));

  const checks = c.checks ?? {};
  const results: CheckResult[] = [];
  if (ranAgent) {
    try {
      results.push(
        ...staticChecks(checks, {
          ws: box.ws,
          changes: changes.files,
          patch: changes.patch,
          answer: client.answer,
          env: base,
        })
      );
      if (c.overlayDir) applyOverlay(c.overlayDir, box.ws);
      results.push(...(await commandChecks(checks, box.ws, base)));
    } catch (error) {
      // A check that cannot run is a failed check, never a silent pass.
      errors.push(`running checks: ${String(error)}`);
      results.push({
        id: 'checks-crashed',
        kind: 'command',
        passed: false,
        detail: { error: String(error) },
      });
    }
  }

  const counted = summarizeEvents(client.events);
  const added = changes.files.reduce((sum, file) => sum + file.added, 0);
  const deleted = changes.files.reduce((sum, file) => sum + file.deleted, 0);
  const passed = client.status === 'completed' && results.every((result) => result.passed);
  const failureTags = passed
    ? []
    : [
        ...(client.status !== 'completed' ? [client.status] : []),
        ...results.filter((result) => !result.passed).map((result) => `check:${result.id}`),
        ...(ranAgent && client.answer.trim() === '' ? ['empty_answer'] : []),
        ...(counted.unknownToolCalls > 0 ? ['unknown_tool'] : []),
      ];

  let judge: RunRecord['judge'];
  if (ctx.judge && c.judge && ranAgent) {
    judge = await runJudge(ctx.judge, {
      prompt: c.prompt,
      judge: c.judge,
      answer: client.answer,
      patch: changes.patch,
    });
    if (judge.error) judge.error = redact(judge.error);
  }

  // The key reaches the clients through the environment and IPC only; prove
  // neither client wrote it into its state directories or the workspace.
  const leaked = scanForSecrets(box.root, ctx.secrets).map((path) =>
    relative(box.root, path).split('\\').join('/')
  );
  if (leaked.length > 0) {
    errors.push(`a secret was found in sandbox files: ${leaked.join(', ')}`);
    ctx.sandboxLeaks.push(...leaked.map((path) => `r${order}/${path}`));
  }

  const trace = [
    {
      kind: 'meta',
      runId,
      case: c.id,
      arm: arm.id,
      rep,
      model: options.model,
      effort: options.effort,
    },
    ...client.events,
    { kind: 'final', status: client.status, answer: client.answer },
  ];
  writeFileSync(
    join(runDir, 'trace.jsonl'),
    `${trace.map((event) => redact(JSON.stringify(event))).join('\n')}\n`
  );

  const record: RunRecord = {
    schema: 'ab-eval.run/1',
    runId,
    suiteRunId: ctx.suiteRunId,
    timestamp: new Date().toISOString(),
    case: {
      id: c.id,
      ...(c.title ? { title: c.title } : {}),
      ...(c.tier ? { tier: c.tier } : {}),
      sha256: c.sha256,
      repoSha256: c.repoSha256,
    },
    arm: {
      id: arm.id,
      client: arm.client,
      ...(arm.variant ? { variant: { name: arm.variant.name, sha256: arm.variant.sha256 } } : {}),
    },
    rep,
    order,
    model: options.model,
    effort: options.effort,
    gateway: { kind: ctx.gateway.kind, id: ctx.gateway.id },
    status: client.status,
    passed,
    ...(setup ? { setup } : {}),
    checks: results,
    failureTags,
    metrics: {
      ...counted,
      durationMs: client.durationMs,
      wallMs: client.wallMs,
      tokens: {
        ...client.tokens,
        total:
          client.tokens.input +
          client.tokens.cacheRead +
          client.tokens.cacheWrite +
          client.tokens.output,
      },
      tokensSource: client.tokensSource,
      changes: { files: changes.files.length, added, deleted, lines: added + deleted },
    },
    answer: { chars: client.answer.length, text: client.answer },
    ...(judge ? { judge } : {}),
    client: { offeredTools: client.offeredTools, ...client.info },
    baseCommit,
    artifacts: {
      record: rel(join(runDir, 'record.json')),
      trace: rel(join(runDir, 'trace.jsonl')),
      diff: rel(join(runDir, 'diff.patch')),
      client: rel(clientDir),
    },
    errors,
  };
  const json = redact(JSON.stringify(record));
  writeFileSync(join(runDir, 'record.json'), `${JSON.stringify(JSON.parse(json), null, 2)}\n`);
  appendFileSync(join(ctx.outDir, 'records.jsonl'), `${json}\n`);
  options.log(
    `[${order}] ${c.id} × ${arm.id} #${rep}: ${client.status}, ${passed ? 'PASS' : 'FAIL'}` +
      `, ${counted.steps} steps, ${counted.toolCalls} tools, ${Math.round(client.durationMs / 100) / 10}s` +
      (failureTags.length > 0 ? ` [${failureTags.join(', ')}]` : '') +
      (client.error ? ` — ${excerpt(redact(client.error), 200)}` : '')
  );
  if (!options.keepWorkspaces) removeTree(box.root);
  return record;
}

function manifestArms(arms: readonly Arm[]): SuiteManifest['arms'] {
  return arms.map((arm) => ({
    id: arm.id,
    client: arm.client,
    ...(arm.variant
      ? {
          variant: {
            name: arm.variant.name,
            sha256: arm.variant.sha256,
            ...(arm.variant.description ? { description: arm.variant.description } : {}),
          },
        }
      : {}),
  }));
}

function manifestCases(cases: readonly LoadedCase[]): SuiteManifest['cases'] {
  return cases.map((c) => ({
    id: c.id,
    ...(c.title ? { title: c.title } : {}),
    ...(c.tier ? { tier: c.tier } : {}),
    sha256: c.sha256,
    repoSha256: c.repoSha256,
  }));
}

/** Why `earlier` cannot be continued with these options; empty when it can. */
function resumeConflicts(
  earlier: SuiteManifest,
  options: SuiteOptions,
  arms: readonly Arm[],
  cases: readonly LoadedCase[]
): string[] {
  const conflicts: string[] = [];
  if (earlier.model !== options.model) conflicts.push(`model ${earlier.model} ≠ ${options.model}`);
  if (earlier.effort !== options.effort)
    conflicts.push(`effort ${earlier.effort} ≠ ${options.effort}`);
  if (earlier.gateway.kind !== options.gateway) {
    conflicts.push(`gateway ${earlier.gateway.kind} ≠ ${options.gateway}`);
  } else if (options.gateway === 'real') {
    const url = process.env.AB_BASE_URL?.trim().replace(/\/+$/, '') ?? '';
    if (gatewayId(url) !== earlier.gateway.id)
      conflicts.push('AB_BASE_URL is not the gateway the suite started on');
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (
    !same(
      earlier.arms.map((arm) => [arm.id, arm.variant?.sha256]),
      arms.map((arm) => [arm.id, arm.variant?.sha256])
    )
  ) {
    conflicts.push('the arms (or a variant) changed');
  }
  for (const c of manifestCases(cases)) {
    const before = earlier.cases.find((item) => item.id === c.id);
    if (!before) conflicts.push(`case ${c.id} was not in the suite`);
    else if (before.sha256 !== c.sha256 || before.repoSha256 !== c.repoSha256)
      conflicts.push(`case ${c.id} changed`);
  }
  if (cases.length !== earlier.cases.length) conflicts.push('the set of cases changed');
  return conflicts;
}

export async function runSuite(options: SuiteOptions): Promise<SuiteResult> {
  const plan = planSuite(options);
  if (plan.problems.length > 0) throw new Error(plan.problems.join('\n'));
  const { cases, arms, claudeBin, gitBash, scratchRoot } = plan;

  const earlier = options.resume ? loadSuite(options.resume) : undefined;
  if (earlier) {
    const conflicts = resumeConflicts(earlier.manifest, options, arms, cases);
    if (conflicts.length > 0)
      throw new Error(`cannot resume ${options.resume}: ${conflicts.join('; ')}`);
  }
  const label = earlier?.manifest.label ?? options.label.replace(/[^A-Za-z0-9._-]/g, '-');
  const started = new Date();
  const suiteRunId = earlier?.manifest.suiteRunId ?? `${stampId(started)}-${label}`;
  const outDir = earlier?.dir ?? options.outDir ?? join(options.abDir, 'out', suiteRunId);
  const scratchDir = join(scratchRoot, suiteRunId);
  mkdirSync(scratchDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const stampBox = createSandbox(scratchDir, 'stamp');
  const stamp = await versionStamp({
    repoRoot: options.repoRoot,
    ...(claudeBin ? { claudeBin } : {}),
    env: baseEnv(stampBox, { proxies: false }),
    cwd: stampBox.ws,
  });

  const gateway =
    options.gateway === 'real'
      ? realGateway()
      : await startFakeGateway({
          entry: join(options.repoRoot, 'src', 'dsh-host', 'tools', 'fake-gateway.mjs'),
          dir: join(scratchDir, 'gateway'),
          cases,
          model: options.model,
          capture: options.capture,
        });
  let judge: JudgeEndpoint | undefined;
  let judgeSecrets: string[] = [];
  if (options.judge) {
    const separateUrl = process.env.AB_JUDGE_BASE_URL?.trim().replace(/\/+$/, '');
    const separateKey = process.env.AB_JUDGE_API_KEY?.trim();
    judge = {
      baseUrl: separateUrl || gateway.baseUrl,
      apiKey: separateKey || gateway.apiKey,
      model: options.judgeModel ?? options.model,
    };
    judgeSecrets = [separateUrl, separateKey].filter((item): item is string => !!item);
  }
  const secrets = [...gateway.secrets, ...judgeSecrets];
  const redact = makeRedactor(secrets);

  const manifest: SuiteManifest = earlier
    ? {
        ...earlier.manifest,
        runs: Math.max(earlier.manifest.runs, options.runs),
        resumes: [
          ...(earlier.manifest.resumes ?? []),
          { at: started.toISOString(), runs: options.runs, harness: stamp.harness },
        ],
      }
    : {
        schema: 'ab-eval.suite/1',
        suiteRunId,
        label,
        startedAt: started.toISOString(),
        model: options.model,
        effort: options.effort,
        runs: options.runs,
        gateway: { kind: gateway.kind, id: gateway.id },
        arms: manifestArms(arms),
        cases: manifestCases(cases),
        suiteVersion: suiteVersion(cases),
        stamp,
        casePaths: options.casePaths,
        ...(options.caseFilter && options.caseFilter.length > 0
          ? { caseFilter: options.caseFilter }
          : {}),
      };
  if (judge) {
    manifest.judge = {
      model: judge.model,
      version: JUDGE_VERSION,
      endpoint: judgeSecrets.length > 0 ? 'separate' : 'gateway',
    };
  }
  if (earlier) {
    const before = earlier.manifest.stamp.harness;
    if (
      before.commit !== stamp.harness.commit ||
      before.dirtyDiffSha256 !== stamp.harness.dirtyDiffSha256
    ) {
      options.log('warning: the harness changed since the suite started; its records mix versions');
    }
  }
  delete manifest.finishedAt;
  delete manifest.outcome;
  const writeManifest = () =>
    writeFileSync(join(outDir, 'manifest.json'), `${redact(JSON.stringify(manifest, null, 2))}\n`);
  writeManifest();

  // Records to keep from an earlier start; the file is rewritten to hold exactly them.
  const records: RunRecord[] = (earlier?.records ?? []).filter(
    (record) => !(options.retryErrors && RETRIED.includes(record.status))
  );
  if (earlier) {
    writeFileSync(
      join(outDir, 'records.jsonl'),
      records.map((record) => `${JSON.stringify(record)}\n`).join('')
    );
  }
  const done = new Set(records.map((record) => runKey(record.case.id, record.arm.id, record.rep)));
  const total = cases.length * arms.length * manifest.runs;
  options.log(
    `suite ${suiteRunId}: ${cases.length} case(s) × ${arms.length} arm(s) × ${manifest.runs} run(s), ` +
      `gateway ${gateway.kind}, model ${options.model}/${options.effort}` +
      (earlier ? `; resuming with ${done.size} of ${total} recorded` : '')
  );
  options.log(`output: ${outDir}`);

  const ctx: RunContext = {
    options,
    suiteRunId,
    outDir,
    scratchDir,
    scratchRoot,
    gitCache: join(scratchRoot, 'git-cache'),
    gateway,
    ...(judge ? { judge } : {}),
    secrets,
    redact,
    ...(claudeBin ? { claudeBin } : {}),
    ...(gitBash ? { gitBash } : {}),
    appVersion: stamp.appVersion,
    sandboxLeaks: [],
  };
  mkdirSync(ctx.gitCache, { recursive: true });
  const writeReport = () =>
    writeFileSync(
      join(outDir, 'report.md'),
      redact(renderReport([{ dir: outDir, manifest, records }]))
    );
  let scratchLeaks: string[] = [];
  try {
    let order = records.reduce((max, record) => Math.max(max, record.order), 0);
    for (let rep = 1; rep <= manifest.runs; rep += 1) {
      for (const [index, c] of cases.entries()) {
        const shift = (rep - 1 + index) % arms.length;
        for (const arm of [...arms.slice(shift), ...arms.slice(0, shift)]) {
          if (done.has(runKey(c.id, arm.id, rep))) continue;
          order += 1;
          records.push(await runOne(ctx, c, arm, rep, order));
          writeReport();
        }
      }
    }
  } finally {
    await gateway.stop();
    scratchLeaks = [
      ...ctx.sandboxLeaks,
      ...scanForSecrets(scratchDir, secrets).map((path) =>
        relative(scratchDir, path).split('\\').join('/')
      ),
    ];
  }
  manifest.finishedAt = new Date().toISOString();
  writeManifest();
  const leaks = scanForSecrets(outDir, secrets).map((path) =>
    relative(outDir, path).split('\\').join('/')
  );
  manifest.outcome = {
    records: records.length,
    leakScan: { clean: leaks.length === 0, files: leaks },
  };
  writeManifest();
  writeReport();
  if (!options.keepWorkspaces && !options.capture) removeTree(scratchDir);
  return { outDir, scratchDir, manifest, records, gateway, scratchLeaks };
}
