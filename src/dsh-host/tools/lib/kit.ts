/**
 * Shared probe kit for the dsh-host P0 drivers (measure.ts, goal-probe.ts):
 * /proc process-tree sampling, memory reads, sandbox dirs, IPC helpers,
 * strace launch and parsing, and the probe-hooks summary.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

export function procCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

/** Block until no vitest process has been seen for two consecutive checks. */
export async function waitQuiet(): Promise<void> {
  let quietChecks = 0;
  let announced = false;
  while (quietChecks < 2) {
    const busy = readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)
      .some((pid) => /vitest/.test(procCmdline(Number(pid))));
    if (busy) {
      quietChecks = 0;
      if (!announced) process.stderr.write('[probe] vitest is running; waiting before measuring\n');
      announced = true;
      await sleep(5000);
    } else {
      quietChecks += 1;
      if (quietChecks < 2) await sleep(1000);
    }
  }
}

// ---- /proc process tree and memory ---------------------------------------

export interface ProcRow {
  pid: number;
  ppid: number;
  start: number;
}

export function procTable(): Map<number, ProcRow> {
  const table = new Map<number, ProcRow>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      // Fields after the parenthesised comm: state ppid ... starttime is field 22.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      table.set(Number(entry), {
        pid: Number(entry),
        ppid: Number(rest[1]),
        start: Number(rest[19]),
      });
    } catch {
      // Process vanished between readdir and read.
    }
  }
  return table;
}

export function descendants(rootPid: number, table = procTable()): number[] {
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const row of table.values()) {
      if (row.ppid === parent) {
        out.push(row.pid);
        queue.push(row.pid);
      }
    }
  }
  return out;
}

export interface SeenProcess {
  pid: number;
  ppid: number;
  cmd: string;
  firstSeenMs: number;
  lastSeenMs: number;
}

/** Samples the descendants of `rootPid` every 250 ms and remembers each one. */
export function treeSampler(rootPid: number, t0: number) {
  const seen = new Map<string, SeenProcess>();
  const tick = () => {
    const table = procTable();
    for (const pid of descendants(rootPid, table)) {
      const row = table.get(pid);
      if (!row) continue;
      const key = `${pid}:${row.start}`;
      const now = round(performance.now() - t0, 0);
      const known = seen.get(key);
      if (known) known.lastSeenMs = now;
      else
        seen.set(key, {
          pid,
          ppid: row.ppid,
          cmd: procCmdline(pid),
          firstSeenMs: now,
          lastSeenMs: now,
        });
    }
  };
  tick();
  const timer = setInterval(tick, 250);
  return {
    stop: () => {
      clearInterval(timer);
      return [...seen.values()];
    },
  };
}

export interface MemSample {
  rssKb: number;
  hwmKb: number;
  swapKb: number;
  pssKb: number;
  treeRssKb: number;
}

export function statusField(text: string, field: string): number {
  const match = text.match(new RegExp(`^${field}:\\s+(\\d+)`, 'm'));
  return match ? Number(match[1]) : Number.NaN;
}

export function readMem(pid: number): MemSample {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  let pssKb = Number.NaN;
  try {
    pssKb = statusField(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'), 'Pss');
  } catch {
    // smaps_rollup needs a newer kernel; PSS is supplementary.
  }
  let treeRssKb = statusField(status, 'VmRSS');
  for (const child of descendants(pid)) {
    try {
      treeRssKb += statusField(readFileSync(`/proc/${child}/status`, 'utf8'), 'VmRSS');
    } catch {
      // Child exited mid-sample.
    }
  }
  return {
    rssKb: statusField(status, 'VmRSS'),
    hwmKb: statusField(status, 'VmHWM'),
    swapKb: statusField(status, 'VmSwap'),
    pssKb,
    treeRssKb,
  };
}

export async function sampleMem(pid: number, count: number) {
  const samples: MemSample[] = [];
  for (let i = 0; i < count; i += 1) {
    samples.push(readMem(pid));
    if (i < count - 1) await sleep(1000);
  }
  const pick = (key: keyof MemSample) => samples.map((sample) => sample[key]);
  return {
    rssMedianMb: round(median(pick('rssKb')) / 1024),
    pssMedianMb: round(median(pick('pssKb')) / 1024),
    swapMedianMb: round(median(pick('swapKb')) / 1024),
    treeRssMedianMb: round(median(pick('treeRssKb')) / 1024),
    hwmMb: round(Math.max(...pick('hwmKb')) / 1024),
    rssSamplesMb: pick('rssKb').map((kb) => round(kb / 1024)),
  };
}

export function psSnapshot(rootPid: number): string {
  const pids = [rootPid, ...descendants(rootPid)];
  try {
    return execFileSync('ps', ['-o', 'pid,ppid,etime,rss,cmd', '-p', pids.join(',')], {
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    return `ps failed: ${String(error)}`;
  }
}

// ---- sandbox -------------------------------------------------------------

export interface Sandbox {
  root: string;
  home: string;
  tmp: string;
  dshHome: string;
  workspace: string;
  hookLog: string;
}

export function sandbox(scratchRoot: string, label: string, dshHome?: string): Sandbox {
  const root = join(scratchRoot, label);
  const box = {
    root,
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    dshHome: dshHome ?? join(root, 'dsh-home'),
    workspace: join(root, 'workspace'),
    hookLog: join(root, 'hooks.jsonl'),
  };
  for (const dir of [box.home, box.tmp, box.dshHome, box.workspace])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  return box;
}

/** Allowlisted environment: nothing from the developer shell but PATH and locale. */
export function baseEnv(box: Sandbox): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: box.home,
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
    SHELL: '/bin/bash',
    TMPDIR: box.tmp,
    AICLIENT_PROBE_HOOK_LOG: box.hookLog,
  };
}

export function readHookLog(file: string) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---- IPC helpers ---------------------------------------------------------

export function waitMessage(
  child: ChildProcess,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs: number,
  label: string
): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      cleanup();
      fail(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record?.type === 'fatal' || record?.type === 'probe-error') {
        cleanup();
        fail(new Error(`${label}: ${JSON.stringify(record)}`));
        return;
      }
      if (predicate(record)) {
        cleanup();
        done(record);
      }
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      fail(new Error(`${label}: process exited (code ${code}, signal ${signal})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

export function exitOf(
  child: ChildProcess
): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
}

export async function stopWithin(exited: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
}

export function captureStderr(child: ChildProcess): () => string {
  let text = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    text = (text + chunk).slice(-20_000);
  });
  child.stdout?.resume();
  return () => text;
}

export function launch(
  command: string[],
  env: Record<string, string>,
  cwd: string,
  traceFile?: string
) {
  const [file, ...args] = traceFile
    ? [
        'strace',
        '-f',
        '-qq',
        '-s',
        '512',
        '-o',
        traceFile,
        '-e',
        'trace=execve,execveat,openat,creat,mkdir,mkdirat,rename,renameat,renameat2,unlink,unlinkat,symlink,symlinkat,link,linkat',
        ...command,
      ]
    : command;
  return spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
}

export function summarizeHooks(records: Array<Record<string, unknown>>) {
  return {
    spawns: records
      .filter((r) => r.kind === 'spawn' || r.kind === 'spawn-sync')
      .map((r) => ({ tMs: r.tMs, kind: r.kind, file: r.file, args: r.args })),
    workerThreads: records.filter((r) => r.kind === 'worker-thread').map((r) => r.filename),
    netBlocked: records.filter((r) => r.kind === 'net-blocked').map((r) => `${r.host}:${r.port}`),
    netLoopback: records.filter((r) => r.kind === 'net-loopback').map((r) => `${r.host}:${r.port}`),
    dnsLookups: records.filter((r) => r.kind === 'dns-lookup').map((r) => r.hostname),
  };
}

// ---- strace parsing ------------------------------------------------------

export function parseStrace(file: string, box: Sandbox, installRoots: string[], repoRoot: string) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const execs: string[] = [];
  const writes = new Map<string, Set<string>>();
  const foreignReads = new Set<string>();
  const nativeAddons = new Set<string>();
  const realHome = os.userInfo().homedir;
  const classify = (path: string): string => {
    const absolute = path.startsWith('/') ? path : join(box.workspace, path);
    for (const [bucket, prefix] of [
      ['DSH_HOME', box.dshHome],
      ['workspace', box.workspace],
      ['TMPDIR', box.tmp],
      ['HOME', box.home],
      ['sandbox-other', box.root],
      ['dev-proc', '/dev/'],
      ['dev-proc', '/proc/'],
    ] as const) {
      if (absolute.startsWith(prefix)) return bucket;
    }
    return 'OUTSIDE';
  };
  const add = (bucket: string, path: string) => {
    const set = writes.get(bucket) ?? new Set<string>();
    set.add(path);
    writes.set(bucket, set);
  };
  for (const line of lines) {
    const exec = line.match(/^\d+\s+execve\("([^"]+)", \[(.*?)\], .*\) = 0$/);
    if (exec) {
      execs.push(
        `${exec[1]} :: ${exec[2].replace(/", "/g, ' ').replace(/^"|"$/g, '').slice(0, 300)}`
      );
      continue;
    }
    const open = line.match(
      /^\d+\s+(?:openat|creat)\((?:[^,]+, )?"([^"]+)", ([A-Z_|]+).*\) = (\d+|-1 \w+)/
    );
    if (open) {
      if (open[3].startsWith('-1')) continue;
      if (open[1].endsWith('.node')) nativeAddons.add(open[1]);
      if (!/O_WRONLY|O_RDWR|O_CREAT/.test(open[2])) {
        // Reads that escape the engine's own install root or the sandbox.
        const absolute = open[1].startsWith('/') ? open[1] : join(box.workspace, open[1]);
        if (
          absolute.includes('/node_modules/') &&
          !installRoots.some((root) => absolute.startsWith(`${root}/`))
        ) {
          foreignReads.add(absolute.replace(/^(.*?\/node_modules\/(?:@[^/]+\/)?[^/]+).*$/, '$1'));
        } else if (absolute.startsWith(`${realHome}/`) && !absolute.startsWith(`${repoRoot}/`)) {
          foreignReads.add(absolute);
        }
        continue;
      }
      add(classify(open[1]), open[1]);
      continue;
    }
    const other = line.match(
      /^\d+\s+(mkdir|mkdirat|rename|renameat|renameat2|unlink|unlinkat|symlink|symlinkat|link|linkat)\((?:AT_FDCWD, )?"([^"]+)"(?:, (?:AT_FDCWD, )?"([^"]+)")?.*\) = (0|-1 \w+)/
    );
    if (other && other[4] === '0') {
      const target = other[3] ?? other[2];
      add(classify(target), `${other[1]} ${target}`);
    }
  }
  const relative = (bucket: string, paths: Set<string>) => {
    const base = {
      DSH_HOME: box.dshHome,
      workspace: box.workspace,
      TMPDIR: box.tmp,
      HOME: box.home,
    }[bucket];
    return [...paths].map((path) => (base ? path.replace(base, `$${bucket}`) : path)).sort();
  };
  return {
    execs: [...new Set(execs)],
    foreignReads: [...foreignReads].sort(),
    nativeAddons: [...nativeAddons].sort(),
    writesByBucket: Object.fromEntries(
      [...writes].map(([bucket, paths]) => [
        bucket,
        bucket === 'DSH_HOME'
          ? { count: paths.size, sample: relative(bucket, paths).slice(0, 40) }
          : relative(bucket, paths),
      ])
    ),
  };
}
