/**
 * Route B S-5 (docs/plantree/plans/claude-sdk-engine/topics/s5-regression.md R-1): the
 * regression set. Starts the local fake gateway on a free port, runs every `host-probe.ts`
 * group in fresh temporary directories, prints one line per group and writes a JSON
 * summary; exits 1 when a check fails or a group does not finish.
 *
 *   node tools/probe-suite.ts [--only flow,modes] [--host-entry <host.js>]
 *                             [--out <summary.json>] [--logs <dir>] [--keep]
 *
 * `--host-entry` drives another host entry (a packaged `resources/claude-sdk-host/host.js`)
 * through PROBE_HOST_ENTRY. `--keep` keeps the temporary directories; a failed group's
 * are kept anyway, and its log path is printed; `--logs` copies every group's log there, a
 * passed group's too (CI uploads them: a report-only check and the `stop` scenario's
 * PowerShell timings, README §11.2 #52, are only in the log). Only the fake gateway is used:
 * the probe key is a fake one and nothing here reads a stored credential.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import {
  copyFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Group {
  name: string;
  scenarios: string[];
  /** `fakehome`: the workspace sits in a directory named *fakehome* (projcfg-home). */
  layout?: 'fakehome';
}

/** Every group, in the order a full run takes them. */
export const GROUPS: readonly Group[] = [
  {
    name: 'flow',
    scenarios: [
      'text',
      'tools',
      'ask',
      'stop',
      'plan',
      'steer',
      // S-6 feedback 13: Ctrl+Enter during the last reply, taken back, and Send now.
      'steer-late',
      'steer-withdraw',
      'sendnow',
      'agent',
      // S-6 feedback 4: background jobs in the window, their output, Stop and TaskStop.
      'jobs',
      'search',
      'compact',
      'history',
      // Decision 204: released while idle, reopened on a new host, sent to again.
      'reopen',
    ],
  },
  {
    name: 'modes',
    scenarios: [
      'keyiso',
      'mode-manual',
      'mode-edits',
      'mode-plan',
      'mode-bypass',
      'mode-switch',
      'mode-enterplan',
      'mode-auto',
    ],
  },
  { name: 'refused', scenarios: ['mode-plan-refused'] },
  { name: 'errors', scenarios: ['errors', 'repoenv'] },
  { name: 'projcfg', scenarios: ['projcfg'] },
  { name: 'scratch', scenarios: ['projcfg-scratch'] },
  { name: 'home', scenarios: ['projcfg-home'], layout: 'fakehome' },
  // S-6 feedback 5: its host runs behind a recording proxy, so it goes on its own.
  { name: 'webfetch', scenarios: ['webfetch'] },
  // S-6 feedback 1/9 (ruling 24): the worktree tools (a git workspace of its own), a
  // ScheduleWakeup coming due (a minute at least) and ReportFindings in every posture.
  { name: 'hosttools', scenarios: ['worktree', 'wakeup', 'findings'] },
  // dsh-rebase decision 194: the slash menu, a local command's output and command rows in
  // history; its own workspace, since it writes a project skill.
  { name: 'slash', scenarios: ['slash'] },
];

/** What one group's probe output says: its checks, the failed ones, and its verdict line. */
export function readProbeOutput(text: string): {
  checks: number;
  failed: string[];
  summary: string | null;
} {
  const failed: string[] = [];
  let checks = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\[check\] (ok|FAIL)\s+(.*)$/.exec(line);
    if (!match) continue;
    checks += 1;
    if (match[1] === 'FAIL') failed.push(match[2].trim());
  }
  const summary = /^(PROBE CHECKS: .*|PROBE FAILED: .*)$/m.exec(text)?.[1] ?? null;
  return { checks, failed, summary };
}

/** A group passed: it ran to its verdict, every check held, and the probe exited 0. */
export function groupPassed(result: {
  exit: number | null;
  checks: number;
  failed: string[];
  summary: string | null;
}): boolean {
  return (
    result.exit === 0 &&
    result.checks > 0 &&
    result.failed.length === 0 &&
    Boolean(result.summary?.startsWith('PROBE CHECKS: all '))
  );
}

function parseArgs(argv: string[]): {
  only: string[] | null;
  hostEntry: string | null;
  out: string | null;
  logs: string | null;
  keep: boolean;
} {
  const args = {
    only: null as string[] | null,
    hostEntry: null as string | null,
    out: null as string | null,
    logs: null as string | null,
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--keep') args.keep = true;
    else if (flag === '--only') args.only = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (flag === '--host-entry') args.hostEntry = argv[++i] ?? null;
    else if (flag === '--out') args.out = argv[++i] ?? null;
    else if (flag === '--logs') args.logs = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

/**
 * The system temporary directory spelled in full. GitHub's Windows runners set TEMP to an
 * 8.3 short path (`C:\Users\RUNNER~1\...`), and the CLI asks before every read or write
 * under a path spelled that way ("a suspicious Windows path pattern"), which the scripted
 * scenarios do not expect. A workspace the user opens is spelled in full.
 */
export function longTmpdir(): string {
  try {
    return realpathSync.native(tmpdir());
  } catch {
    return tmpdir();
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() - started > timeoutMs) throw new Error(`fake gateway not up at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; log: string; timeoutMs: number }
): Promise<number | null> {
  return new Promise((resolve) => {
    const out = createWriteStream(options.log);
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    const timer = setTimeout(() => {
      out.write(`\n[probe-suite] group timed out after ${options.timeoutMs} ms\n`);
      child.kill();
    }, options.timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      out.end(() => resolve(code));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const here = fileURLToPath(new URL('.', import.meta.url));
  const hostDir = join(here, '..');
  const gatewayScript = join(here, '..', '..', 'dsh-host', 'tools', 'fake-gateway.mjs');
  const probe = join(here, 'host-probe.ts');
  const groups = args.only ? GROUPS.filter((g) => args.only?.includes(g.name)) : [...GROUPS];
  if (args.only && groups.length !== args.only.length) {
    throw new Error(`unknown group in --only; groups are ${GROUPS.map((g) => g.name).join(', ')}`);
  }

  const base = mkdtempSync(join(longTmpdir(), 'pilab-probe-suite-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const gateway: ChildProcess = spawn(
    process.execPath,
    [
      gatewayScript,
      '--port',
      String(port),
      '--plan',
      'claude-sdk',
      '--reset',
      '--model-id',
      'claude-opus-5-5',
      '--state',
      join(base, 'gw-state.json'),
      '--log',
      join(base, 'gw.log'),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  );
  const results: Array<Record<string, unknown> & { passed: boolean }> = [];
  try {
    await waitForHealth(url, 15_000);
    console.log(`[probe-suite] fake gateway ${url}; work in ${base}`);
    for (const group of groups) {
      const dir = join(base, group.name);
      const parent = group.layout === 'fakehome' ? join(dir, 'pilab-fakehome') : dir;
      const workspace = join(parent, 'proj');
      const config = join(dir, 'config');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(config, { recursive: true });
      const log = join(dir, 'probe.log');
      const env: NodeJS.ProcessEnv = { ...process.env, PROBE_CONFIG_DIR: config };
      if (args.hostEntry) env.PROBE_HOST_ENTRY = args.hostEntry;
      const started = Date.now();
      const exit = await run(process.execPath, [probe, url, workspace, ...group.scenarios], {
        cwd: hostDir,
        env,
        log,
        timeoutMs: 20 * 60_000,
      });
      const parsed = readProbeOutput(readFileSync(log, 'utf8'));
      const passed = groupPassed({ exit, ...parsed });
      results.push({
        group: group.name,
        scenarios: group.scenarios,
        exit,
        checks: parsed.checks,
        failed: parsed.failed,
        summary: parsed.summary,
        durationMs: Date.now() - started,
        passed,
        ...(passed ? {} : { log }),
      });
      console.log(
        `[probe-suite] ${passed ? 'ok  ' : 'FAIL'} ${group.name.padEnd(8)} ${parsed.summary ?? `exit ${exit}, no verdict`} (${Math.round((Date.now() - started) / 1000)} s)${passed ? '' : ` log: ${log}`}`
      );
      for (const label of parsed.failed) console.log(`[probe-suite]        - ${label}`);
      // Every group's log, not only a failed one: what a passed group reported without
      // blocking (the `stop` leftover check on CI, ps-diag) is only there (#52).
      if (args.logs) {
        mkdirSync(args.logs, { recursive: true });
        copyFileSync(log, join(args.logs, `${group.name}.log`));
      }
      if (passed && !args.keep) rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    gateway.kill();
  }
  const ok = results.length === groups.length && results.every((r) => r.passed);
  const summary = { ok, gateway: url, hostEntry: args.hostEntry ?? 'source', groups: results };
  if (args.out) writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `[probe-suite] ${ok ? 'all groups passed' : 'FAILED'}: ${results.filter((r) => r.passed).length} of ${groups.length} groups`
  );
  if (ok && !args.keep) rmSync(base, { recursive: true, force: true });
  process.exitCode = ok ? 0 : 1;
}

// Run as a script, not when a test imports the parsers above.
const self = fileURLToPath(import.meta.url).toLowerCase();
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self) {
  main().catch((error) => {
    console.error('[probe-suite] failed:', error);
    process.exitCode = 1;
  });
}
