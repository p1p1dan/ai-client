/**
 * Decision 173 §4.4 (GitHub issue #9), A: the request prefix probe. On a real
 * host, a chat's anthropic-messages requests must only ever append to the
 * previous request of the same session (the moving `cache_control` marker
 * aside); and the issue's diagnostics run end to end: the request tap's
 * `metadata.user_id` (D) and prefix watch (B1), the bridge's per-step cache
 * chain (B2).
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/request-prefix-probe.ts
 *      [--out file.json] [--keep] [--only S1,S3])
 *
 * CI runs it from the repo root as a hard gate (dsh-bridge-gate.yml). It
 * starts real hosts, one at a time: on the 2-core dev box (2026-10-10) a run
 * took 14-35 s, each host peaking at about 730 MB (VmHWM, briefly) and
 * otherwise near 280 MB. Run it alone there, with no Electron or Vitest
 * beside it; it refuses to start below 800 MB available. `--only` picks
 * scenarios for local iteration (S4 brings S1 along: it reopens S1's session).
 *
 * One fake gateway (plan dsh-p0-2, `--capture`: every request, body and all,
 * to the scratch directory), one DSH home, the host's three switches left on
 * (the default). Host 1 runs S1-S3, a session each; host 2 runs S4:
 *   S1  P1-CHAIN (8 steps, a thinking block on each, step 3's command sleeps
 *       3 s) with a `worker.interject` while that command runs; a second
 *       P1-CHAIN turn; `worker.compact` (DSH's `/compact`); a third P1-CHAIN
 *       turn, fresh after the compaction
 *   S2  plan mode: P1-PLAN-REVIEW, its review answered keep-planning, then
 *       set as goal on full auto; the goal round runs to idle. That script
 *       carries no thinking and no simulated cache, so B2 is reported here,
 *       not asserted
 *   S3  P1-CHAIN on a split upstream (`cacheSim: split`: every 4th request of
 *       the session goes to a backend B that caches apart and counts 0.55x)
 *   S4  host 1 stopped, host 2 on the same DSH home reopens S1's stub and
 *       runs one more P1-CHAIN turn
 *
 * Checks, each a named boolean with its reason (exit 0 only when all pass):
 * every request captured; each a JSON `metadata.user_id` whose `session_id`
 * is `gatewaySessionUuid(<dsh session id>)` and whose `device_id` is the DSH
 * home's anonymous id hashed (one for every session), stable across the
 * restart and distinct per session; per session and purpose (as the host's
 * prefix watch keeps them) every request is `first`, `append` or `same` but
 * the expected two, S1's first agent request after the compaction and S2's
 * first request after the plan is approved (at the system prompt, the
 * config or the tools), each with its `[dsh-host] prefix-watch:` line and no
 * other such line; no `cache-chain: upstream cache inconsistency` line for
 * S1, at least one for S3 with `prefix=append` and a `matched=` step; no
 * `client request diverged without a logged cause` line; no request tap
 * warning; both hosts exit 0. Plus each scenario's own evidence: the note
 * reached the model mid-turn, the compaction ran, the goal round wrote its
 * file, backend B served S3, the reopened session kept its id.
 *
 * A diverged transition nobody expected is an issue #9 finding, not a probe
 * bug: read its fields in the report before touching an expectation.
 *
 * `--out` writes the report: sequence numbers, counts, ids, verdict fields
 * and the hosts' diagnostic lines, never request content. The captures do
 * hold content: they stay in the scratch directory under /var/tmp, removed
 * unless `--keep`. Every model request goes to the fake gateway, the probe
 * hooks drop any non-loopback connect, and signals only ever go to a
 * ChildProcess this script spawned.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { ANONYMOUS_ID_FILE } from '../lib/anonymousId.ts';
import { deviceIdFrom, gatewaySessionUuid } from '../lib/sessionMetadata.ts';
import {
  answeringReviews,
  compactSession,
  type ExperimentHost,
  type ExperimentSession,
  type ExperimentTurn,
  type FakeGateway,
  gatewayRequests,
  interject,
  openSession,
  readyOrFatal,
  sendTurn,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
  stopFakeGateway,
  waitIdle,
  waitToolStarts,
} from './lib/experiment-host.ts';
import { fakeGatewayPlan, type Message } from './lib/hostClient.ts';
import {
  baseEnv,
  descendants,
  readMem,
  type Sandbox,
  sandbox,
  sleep,
  statusField,
} from './lib/kit.ts';
import {
  buildPrefixChains,
  type ChainedRequest,
  isBreak,
  laneBreaks,
  laneRow,
  lastCapturedSeq,
  loadCapturedRequests,
  type PrefixChains,
  type PrefixLane,
} from './lib/prefixChain.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;
const MIN_AVAILABLE_MB = 800;

const SCENARIOS = ['S1', 'S2', 'S3', 'S4'] as const;
type Scenario = (typeof SCENARIOS)[number];
type SessionScenario = Exclude<Scenario, 'S4'>;

/** S1's mid-turn note: no scenario marker, so the gateway's script carries on. */
const S1_NOTE = 'PROBE-NOTE-S1 noted while a command runs; carry on.';
const PLAN_PERMISSIONS = Object.freeze({ mode: 'plan', gear: 'auto' } as const);
const TAP_ON = 'request tap: session metadata on, prefix watch on';

// ---- arguments and the machine ---------------------------------------------------

function parseArgs(argv: string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const only = value('--only')
    ?.split(',')
    .map((name) => name.trim().toUpperCase())
    .filter(Boolean);
  for (const name of only ?? []) {
    if (!(SCENARIOS as readonly string[]).includes(name)) {
      throw new Error(`unknown scenario ${name}: ${SCENARIOS.join(', ')}`);
    }
  }
  const selected = new Set<Scenario>((only as Scenario[] | undefined) ?? SCENARIOS);
  if (selected.has('S4')) selected.add('S1');
  return { out: value('--out'), keep: argv.includes('--keep'), selected };
}

function availableMb(): number {
  try {
    const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
    return match ? Math.round(Number(match[1]) / 1024) : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * VmRSS summed over `pid` and its descendants, in kB; undefined when none
 * reports one. A process that exited, or a zombie (its status has no Vm
 * lines), is left out instead of turning the sum into NaN.
 */
function treeRssKb(pid: number): number | undefined {
  let members: number[];
  try {
    members = [pid, ...descendants(pid)];
  } catch {
    return undefined;
  }
  let total: number | undefined;
  for (const member of members) {
    try {
      const kb = statusField(readFileSync(`/proc/${member}/status`, 'utf8'), 'VmRSS');
      if (Number.isFinite(kb)) total = (total ?? 0) + kb;
    } catch {
      // Exited between the listing and the read.
    }
  }
  return total;
}

/** Megabytes for the report, `n/a` when the figure is unknown. */
function mbText(mb: number | undefined): string {
  return mb === undefined ? 'n/a' : `${mb} MB`;
}

/** The host's process tree RSS, sampled each second, and the machine's lowest MemAvailable. */
function memoryWatch(pid: number | undefined) {
  let peakTreeMb: number | undefined;
  let minAvailableMb = availableMb();
  const tick = () => {
    minAvailableMb = Math.min(minAvailableMb, availableMb());
    if (pid === undefined) return;
    const kb = treeRssKb(pid);
    if (kb !== undefined) peakTreeMb = Math.max(peakTreeMb ?? 0, Math.round(kb / 1024));
  };
  tick();
  const timer = setInterval(tick, 1000);
  timer.unref();
  return {
    /** The host's own VmHWM (peak RSS), read while it lives. */
    hwmMb(): number | undefined {
      if (pid === undefined) return undefined;
      try {
        const kb = readMem(pid).hwmKb;
        return Number.isFinite(kb) ? Math.round(kb / 1024) : undefined;
      } catch {
        return undefined;
      }
    },
    stop() {
      tick();
      clearInterval(timer);
      return { peakTreeMb, minAvailableMb };
    },
  };
}

// ---- the run ---------------------------------------------------------------------------

/** Capture sequence numbers a phase of a session covers, both ends included. */
interface Phase {
  label: string;
  host: string;
  from: number;
  to: number;
  ms: number;
}

interface SessionRecord {
  scenario: SessionScenario;
  logicalSessionId: string;
  dshSessionId: string;
  /** `gatewaySessionUuid(dshSessionId)`: the session every request must name. */
  gatewaySession: string;
  phases: Phase[];
}

interface HostRecord {
  label: string;
  host: ExperimentHost;
  memory: ReturnType<typeof memoryWatch>;
  ready: boolean;
  fatal?: string;
  hwmMb?: number;
  peakTreeMb?: number;
  stop?: { stopped: boolean; exit: { code: number | null; signal: string | null } };
}

interface Run {
  box: Sandbox;
  hostCwd: string;
  captureDir: string;
  gateway: FakeGateway;
  env: Record<string, string>;
  plan: ReturnType<typeof fakeGatewayPlan>;
  hosts: HostRecord[];
  sessions: Partial<Record<SessionScenario, SessionRecord>>;
  /** What each scenario did, for the report and the evidence checks. */
  facts: Partial<Record<Scenario, Message>>;
  errors: string[];
  /** The last capture of host 1; later ones are host 2's. */
  host1LastSeq?: number;
}

function chainPrompt(params: Record<string, unknown>): string {
  return `P1-CHAIN ${JSON.stringify(params)} run the chain.`;
}

function workspace(run: Run, name: string, files: Record<string, string> = {}): string {
  const dir = join(run.box.workspace, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

/** Waits until no request reached the gateway for `quietMs` (at most `maxMs`). */
async function settle(run: Run, quietMs = 1_000, maxMs = 20_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = lastCapturedSeq(run.captureDir);
  let since = Date.now();
  while (Date.now() < deadline) {
    await sleep(200);
    const now = lastCapturedSeq(run.captureDir);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
  }
}

/** Runs one phase of a session and records which captures it made. */
async function phase<T>(
  run: Run,
  record: SessionRecord,
  label: string,
  host: string,
  body: () => Promise<T>
): Promise<T> {
  const from = lastCapturedSeq(run.captureDir) + 1;
  const started = performance.now();
  try {
    return await body();
  } finally {
    await settle(run);
    record.phases.push({
      label,
      host,
      from,
      to: lastCapturedSeq(run.captureDir),
      ms: Math.round(performance.now() - started),
    });
  }
}

function sessionRecord(scenario: SessionScenario, session: ExperimentSession): SessionRecord {
  return {
    scenario,
    logicalSessionId: session.logicalSessionId,
    dshSessionId: session.dshSessionId,
    gatewaySession: gatewaySessionUuid(session.dshSessionId),
    phases: [],
  };
}

/** A turn as the report keeps it: whether it ended, its tool calls, and the expected reply. */
function turnFacts(turn: ExperimentTurn, expectedReply?: string): Message {
  return {
    requestId: turn.requestId,
    idle: turn.idle,
    toolCalls: new Set(
      turn.events
        .filter((event) => event.type === 'tool.started')
        .map((event) => (event.payload as Message | undefined)?.toolCallId)
    ).size,
    ...(expectedReply ? { replyOk: turn.reply.includes(expectedReply) } : {}),
  };
}

/** `worker.compact`'s answer without the summary's text. */
function compactFacts(answer: Message): Message {
  if (answer.ok !== true) return answer;
  const result = (answer.result ?? {}) as Message;
  const blocks = (result.summary as Message | undefined)?.blocks;
  return {
    ok: true,
    compacted: result.compacted === true,
    summaryBlocks: Array.isArray(blocks) ? blocks.length : 0,
  };
}

async function startHost(run: Run, label: string): Promise<HostRecord> {
  const host = startExperimentHost({
    label,
    nodeBin,
    nodeArgs: ['--import', hooksEntry],
    entry: hostEntry,
    cwd: run.hostCwd,
    env: run.env,
    plan: run.plan,
    key: 'issue9-fake-key',
  });
  const record: HostRecord = { label, host, memory: memoryWatch(host.child.pid), ready: false };
  run.hosts.push(record);
  const ready = await readyOrFatal(host);
  record.ready = ready?.type === 'ready';
  if (!record.ready) {
    record.fatal = ready?.type === 'fatal' ? String(ready.message) : 'no ready in time';
    throw new Error(`${label}: ${record.fatal}\n${host.stderr().slice(-1500)}`);
  }
  return record;
}

async function stopHost(record: HostRecord): Promise<void> {
  if (record.stop) return;
  record.hwmMb = record.memory.hwmMb();
  record.stop = await stopExperimentHost(record.host);
  record.peakTreeMb = record.memory.stop().peakTreeMb;
}

/** S1, on host 1: the interjected chain, a second turn, the compaction, a third turn. */
async function runS1(run: Run, hostRecord: HostRecord): Promise<ExperimentSession> {
  const { host } = hostRecord;
  const session = await openSession(host, {
    logicalSessionId: 'issue9-s1',
    cwd: workspace(run, 's1'),
  });
  const record = sessionRecord('S1', session);
  run.sessions.S1 = record;
  const facts: Message = { dshSessionId: session.dshSessionId };
  run.facts.S1 = facts;
  const turns: Message[] = [];
  facts.turns = turns;

  const t1 = await phase(run, record, 't1', hostRecord.label, () =>
    sendTurn(host, session, {
      requestId: 'issue9-s1-t1',
      text: chainPrompt({
        tag: 's1-t1',
        steps: 8,
        think: true,
        sleepStep: 3,
        sleepSeconds: 3,
        cacheSim: 'single',
      }),
      during: async (from) => {
        // The fourth call is step 3's, whose command sleeps 3 s: steer into it.
        if (!(await waitToolStarts(host, session, from, 4))) {
          throw new Error('S1: step 3 never started');
        }
        await sleep(800);
        facts.interject = await interject(host, session, 'issue9-s1-note', S1_NOTE);
      },
    })
  );
  turns.push(turnFacts(t1, 'P1-CHAIN done s1-t1'));

  const t2 = await phase(run, record, 't2', hostRecord.label, () =>
    sendTurn(host, session, {
      requestId: 'issue9-s1-t2',
      text: chainPrompt({ tag: 's1-t2', steps: 5, think: true, cacheSim: 'single' }),
    })
  );
  turns.push(turnFacts(t2, 'P1-CHAIN done s1-t2'));

  facts.compact = compactFacts(
    await phase(run, record, 'compact', hostRecord.label, () => compactSession(host, session))
  );

  // Fresh after the compaction: the first turn's trigger may be gone from the history.
  const t3 = await phase(run, record, 't3', hostRecord.label, () =>
    sendTurn(host, session, {
      requestId: 'issue9-s1-t3',
      text: chainPrompt({ tag: 's1-t3', steps: 4, think: true, cacheSim: 'single' }),
    })
  );
  turns.push(turnFacts(t3, 'P1-CHAIN done s1-t3'));
  return session;
}

/** S2, on host 1: plan mode, keep planning, then set as goal on full auto; the goal round. */
async function runS2(run: Run, hostRecord: HostRecord): Promise<void> {
  const { host } = hostRecord;
  const cwd = workspace(run, 's2', { 'plan-notes.txt': 'plan notes\n' });
  const session = await openSession(host, {
    logicalSessionId: 'issue9-s2',
    cwd,
    permissions: PLAN_PERMISSIONS,
  });
  const record = sessionRecord('S2', session);
  run.sessions.S2 = record;
  const answered: Message[] = [];
  const facts: Message = { dshSessionId: session.dshSessionId, answered };
  run.facts.S2 = facts;
  const from = host.client.events(session.ch).length;
  await phase(run, record, 'plan+goal', hostRecord.label, async () => {
    const turn = await sendTurn(host, session, {
      requestId: 'issue9-s2-plan',
      text: 'P1-PLAN-REVIEW: plan the change, then carry it out.',
      during: answeringReviews(
        host,
        session,
        [
          {
            answers: { 'plan-review': 'keep-planning' },
            response: 'Name the output file in the goal.',
          },
          { answers: { 'plan-review': 'goal:auto' } },
        ],
        answered,
        (index) => {
          // The approval: every request after it is past plan mode.
          if (index === 1) facts.approvalSeq = lastCapturedSeq(run.captureDir);
        }
      ),
    });
    facts.turn = turnFacts(turn);
    // The goal's first round: a turn nobody sent.
    const roundId = `dsh-turn-${session.dshSessionId}-2`;
    facts.goalRound = { requestId: roundId, idle: await waitIdle(host, session, roundId, from) };
  });
  facts.written = existsSync(join(cwd, 'plan-output.txt'));
}

/** S3, on host 1: the chain on a split upstream. */
async function runS3(run: Run, hostRecord: HostRecord): Promise<void> {
  const { host } = hostRecord;
  const session = await openSession(host, {
    logicalSessionId: 'issue9-s3',
    cwd: workspace(run, 's3'),
  });
  const record = sessionRecord('S3', session);
  run.sessions.S3 = record;
  const facts: Message = { dshSessionId: session.dshSessionId };
  run.facts.S3 = facts;
  const turn = await phase(run, record, 't1', hostRecord.label, () =>
    sendTurn(host, session, {
      requestId: 'issue9-s3-t1',
      text: chainPrompt({ tag: 's3', steps: 8, think: true, cacheSim: 'split' }),
    })
  );
  facts.turn = turnFacts(turn, 'P1-CHAIN done s3');
}

/** S4, on host 2: S1's stub reopened after the restart, one more chain turn. */
async function runS4(run: Run, hostRecord: HostRecord, s1: ExperimentSession): Promise<void> {
  const { host } = hostRecord;
  const record = run.sessions.S1;
  if (!record) throw new Error('S4: S1 never ran');
  const facts: Message = {};
  run.facts.S4 = facts;
  const session = await openSession(host, {
    logicalSessionId: s1.logicalSessionId,
    cwd: s1.cwd,
    sessionFile: s1.stubFile,
  });
  facts.dshSessionId = session.dshSessionId;
  facts.sameSession = session.dshSessionId === s1.dshSessionId;
  facts.resumed = session.boot.initialHistory !== undefined;
  const turn = await phase(run, record, 't4', hostRecord.label, () =>
    sendTurn(host, session, {
      requestId: 'issue9-s1-t4',
      text: chainPrompt({ tag: 's1-t4', steps: 3, think: true, cacheSim: 'single' }),
    })
  );
  facts.turn = turnFacts(turn, 'P1-CHAIN done s1-t4');
}

// ---- reading the hosts' lines ------------------------------------------------------------

interface PrefixWatchLine {
  host: string;
  session: string;
  purpose: string;
  req: number;
  fields: string;
}

interface CacheChainLine {
  host: string;
  kind: 'upstream' | 'client';
  session?: string;
  fields: Record<string, string>;
  /** The line as the host wrote it (ids and numbers only). */
  line: string;
}

const PREFIX_WATCH = /prefix-watch: session=(\S+) purpose=(\S+) req=(\d+) (verdict=.*)$/;
const CACHE_CHAIN =
  /cache-chain: (upstream cache inconsistency|client request diverged without a logged cause) (.*)$/;
const TAP_WARNING = /\[dsh-host\] warning: request tap:/;

function hostLines(run: Run) {
  const prefixWatch: PrefixWatchLine[] = [];
  const cacheChain: CacheChainLine[] = [];
  const tapWarnings: string[] = [];
  const tapState: Record<string, string> = {};
  for (const { label, host } of run.hosts) {
    for (const line of host.stderrLines()) {
      if (line.includes('[dsh-host] request tap:')) {
        tapState[label] = line.slice(line.indexOf('request tap:'));
      }
      if (TAP_WARNING.test(line)) tapWarnings.push(`${label}: ${line}`);
      const watch = PREFIX_WATCH.exec(line);
      if (watch) {
        prefixWatch.push({
          host: label,
          session: watch[1] ?? '',
          purpose: watch[2] ?? '',
          req: Number(watch[3]),
          fields: watch[4] ?? '',
        });
      }
      const chain = CACHE_CHAIN.exec(line);
      if (chain) {
        const fields: Record<string, string> = {};
        for (const match of (chain[2] ?? '').matchAll(/([A-Za-z]+)=(\S+)/g)) {
          fields[match[1] ?? ''] = match[2] ?? '';
        }
        cacheChain.push({
          host: label,
          kind: chain[1]?.startsWith('upstream') ? 'upstream' : 'client',
          ...(fields.session ? { session: fields.session } : {}),
          fields,
          line: line.slice(line.indexOf('cache-chain:')),
        });
      }
    }
  }
  return { prefixWatch, cacheChain, tapWarnings, tapState };
}

// ---- judging -------------------------------------------------------------------------------

interface Check {
  ok: boolean;
  reason: string;
}

interface ExpectedBreak {
  scenario: SessionScenario;
  what: string;
  seq: number;
  /** The `at` a divergence there may name; empty for any. */
  allowedAt: string[];
}

function evaluate(run: Run, selected: ReadonlySet<Scenario>) {
  const checks: Record<string, Check> = {};
  const check = (name: string, ok: boolean, reason: string) => {
    checks[name] = { ok, reason };
  };
  const { requests: captured, unreadable } = loadCapturedRequests(run.captureDir);
  const byPurpose = buildPrefixChains(captured, { byPurpose: true });
  const upstream = buildPrefixChains(captured);
  const logged = gatewayRequests(run.gateway.log);
  const lines = hostLines(run);
  const records = Object.values(run.sessions);
  const recordOf = (uuid: string | undefined) =>
    records.find((record) => record.gatewaySession === uuid);
  const phaseOf = (seq: number) => {
    for (const record of records) {
      const found = record.phases.find((p) => seq >= p.from && seq <= p.to);
      if (found) return { record, phase: found };
    }
    return undefined;
  };
  const hostOf = (seq: number) =>
    run.host1LastSeq === undefined || seq <= run.host1LastSeq ? 'issue9-h1' : 'issue9-h2';
  const scenarioOf = (lane: PrefixLane) => recordOf(lane.sessionId)?.scenario ?? '?';

  // Every request reached the gateway's disk, and is an anthropic-messages one.
  const capturedSeqs = new Set(captured.map((request) => request.seq));
  const missing = logged.filter((entry) => !capturedSeqs.has(Number(entry.seq)));
  check(
    'captureComplete',
    logged.length > 0 &&
      missing.length === 0 &&
      unreadable.length === 0 &&
      byPurpose.skipped.length === 0 &&
      captured.length === logged.length,
    `${captured.length} captured of ${logged.length} logged; missing ${missing.map((e) => e.seq).join(',') || 'none'}; unreadable ${unreadable.length}; not anthropic-messages ${byPurpose.skipped.map((s) => `${s.seq} (${s.reason})`).join(', ') || 'none'}`
  );

  // D: metadata.user_id on every request, in Claude Code's JSON form.
  const requests = byPurpose.requests;
  const malformed = requests.filter(({ userId }) => {
    return !(
      userId.format === 'json' &&
      JSON.stringify(userId.metadataKeys) === '["user_id"]' &&
      JSON.stringify(userId.keys) === '["device_id","account_uuid","session_id"]' &&
      /^[0-9a-f]{64}$/.test(userId.deviceId ?? '') &&
      userId.accountUuid === '' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        userId.sessionId ?? ''
      )
    );
  });
  check(
    'userIdWellFormed',
    requests.length > 0 && malformed.length === 0,
    malformed.length === 0
      ? `${requests.length} requests, each {"device_id","account_uuid":"","session_id":<uuid v5>} and nothing else in metadata`
      : `malformed: ${malformed.map((r) => `seq ${r.seq} ${r.userId.format}`).join(', ')}`
  );

  // The session named is the one the request was made for (by phase), so the
  // request scope reached fetch for every purpose.
  const misattributed = requests.filter((request) => {
    const owner = phaseOf(request.seq);
    return !owner || request.userId.sessionId !== owner.record.gatewaySession;
  });
  const purposes = [...new Set(requests.map((r) => r.purpose))].sort().join('+');
  check(
    'userIdSessionMatches',
    requests.length > 0 && misattributed.length === 0,
    misattributed.length === 0
      ? `every ${purposes} request names gatewaySessionUuid(<its dsh session>)`
      : misattributed
          .map((r) => {
            const owner = phaseOf(r.seq);
            return `seq ${r.seq}: ${owner ? `made for ${owner.record.dshSessionId}` : 'outside every phase'}, names ${r.userId.sessionId ?? 'nothing'}`;
          })
          .join('; ')
  );

  let anonymousId = '';
  try {
    anonymousId = readFileSync(join(run.box.dshHome, ANONYMOUS_ID_FILE), 'utf8').trim();
  } catch {
    // Checked below: no id, no device.
  }
  const expectedDevice = anonymousId ? deviceIdFrom(anonymousId) : undefined;
  const devices = new Set(requests.map((r) => r.userId.deviceId));
  check(
    'deviceIdStable',
    expectedDevice !== undefined && devices.size === 1 && devices.has(expectedDevice),
    expectedDevice === undefined
      ? `no anonymous id in the DSH home`
      : `${devices.size} device id(s) over ${records.length} session(s); ${devices.has(expectedDevice) ? '' : 'not '}sha256("aiclient-device:" + the home's anonymous id)`
  );

  const s1 = run.sessions.S1;
  if (selected.has('S4') && s1) {
    const ofS1 = requests.filter((r) => phaseOf(r.seq)?.record === s1);
    const before = ofS1.filter((r) => hostOf(r.seq) === 'issue9-h1');
    const after = ofS1.filter((r) => hostOf(r.seq) === 'issue9-h2');
    const ids = (list: ChainedRequest[]) =>
      new Set(list.map((r) => `${r.userId.sessionId}|${r.userId.deviceId}`));
    const [idBefore] = ids(before);
    const [idAfter] = ids(after);
    check(
      'idsStableAcrossRestart',
      run.facts.S4?.sameSession === true &&
        before.length > 0 &&
        after.length > 0 &&
        ids(before).size === 1 &&
        ids(after).size === 1 &&
        idBefore === idAfter,
      `S1 on host 1: ${before.length} requests, on host 2: ${after.length}; reopened as ${String(run.facts.S4?.dshSessionId)}; one session and device id across both: ${idBefore === idAfter}`
    );
  }
  const named = (['S1', 'S2', 'S3'] as const).filter((s) => run.sessions[s]);
  if (named.length >= 2) {
    const uuids = named.map((s) => run.sessions[s]?.gatewaySession);
    const seen = named.map((s) => {
      const record = run.sessions[s];
      return new Set(
        requests.filter((r) => phaseOf(r.seq)?.record === record).map((r) => r.userId.sessionId)
      );
    });
    check(
      'sessionIdsDistinct',
      new Set(uuids).size === named.length && seen.every((set) => set.size === 1),
      `${named.join(', ')}: ${named.length} sessions, ${new Set(uuids).size} distinct gateway sessions, ${seen.map((set) => set.size).join('/')} id(s) seen each`
    );
  }

  // B1 from the captures: per session and purpose, nothing but appends, save the expected.
  const expected: ExpectedBreak[] = [];
  const laneOf = (record: SessionRecord | undefined, purpose: string) =>
    byPurpose.lanes.find(
      (l) => record && l.sessionId === record.gatewaySession && l.purpose === purpose
    );
  const compactPhase = s1?.phases.find((p) => p.label === 'compact');
  const afterCompaction =
    compactPhase && laneOf(s1, 'agent')?.requests.find((r) => r.seq > compactPhase.to);
  if (s1 && compactPhase) {
    expected.push({
      scenario: 'S1',
      what: 'the first agent request after the compaction',
      seq: afterCompaction?.seq ?? -1,
      allowedAt: [],
    });
  }
  const s2 = run.sessions.S2;
  const approvalSeq = run.facts.S2?.approvalSeq;
  const afterApproval =
    typeof approvalSeq === 'number'
      ? laneOf(s2, 'agent')?.requests.find((r) => r.seq > approvalSeq)
      : undefined;
  if (s2) {
    expected.push({
      scenario: 'S2',
      what: 'the first request after the plan is approved (plan mode exits)',
      seq: afterApproval?.seq ?? -1,
      allowedAt: ['system', 'config', 'tools'],
    });
  }
  const breaks = requests.filter(isBreak);
  const firsts = byPurpose.lanes.filter((lane) => lane.counts.first !== 1);
  const unexpected = breaks.filter((r) => !expected.some((e) => e.seq === r.seq));
  const describe = (r: ChainedRequest) => {
    const owner = phaseOf(r.seq);
    return `${owner?.record.scenario ?? '?'} ${r.purpose} seq ${r.seq} (after seq ${r.prevSeq ?? '-'}, ${owner?.phase.label ?? '?'} on ${hostOf(r.seq)}): ${r.fields}`;
  };
  check(
    'prefixOnlyAppends',
    requests.length > 0 && unexpected.length === 0 && firsts.length === 0,
    unexpected.length === 0 && firsts.length === 0
      ? `${requests.length} requests on ${byPurpose.lanes.length} lanes: first/append/same but ${breaks.length} expected break(s)`
      : [
          ...unexpected.map((r) => `UNEXPECTED ${describe(r)}`),
          ...firsts.map((l) => `lane ${l.lane} starts ${l.counts.first} times`),
        ].join('; ')
  );
  const expectedFound = expected.map((e) => {
    const request = requests.find((r) => r.seq === e.seq);
    const at = request?.verdict?.kind === 'diverged' ? request.verdict.at : undefined;
    return {
      ...e,
      fields: request?.fields ?? 'no such request',
      ok: at !== undefined && (e.allowedAt.length === 0 || e.allowedAt.includes(at)),
    };
  });
  check(
    'expectedBreaksSeen',
    expectedFound.every((e) => e.ok),
    expectedFound.length === 0
      ? 'none expected in the scenarios run'
      : expectedFound
          .map(
            (e) =>
              `${e.scenario} ${e.what}: seq ${e.seq} ${e.fields}${e.ok ? '' : ' (NOT as expected)'}`
          )
          .join('; ')
  );

  // B1 in the host: each capture break has its prefix-watch line, and no line is left over.
  const hostPosition = (request: ChainedRequest) => {
    const lane = byPurpose.lanes.find((l) => l.requests.includes(request));
    const host = hostOf(request.seq);
    return (lane?.requests ?? []).filter((r) => hostOf(r.seq) === host && r.seq <= request.seq)
      .length;
  };
  const matched = new Set<PrefixWatchLine>();
  const lineFor = (request: ChainedRequest) => {
    const owner = phaseOf(request.seq);
    const line = lines.prefixWatch.find(
      (l) =>
        !matched.has(l) &&
        l.host === hostOf(request.seq) &&
        l.session === owner?.record.dshSessionId &&
        l.purpose === request.purpose &&
        l.req === hostPosition(request) &&
        l.fields === request.fields
    );
    if (line) matched.add(line);
    return line;
  };
  const breakLines = breaks.map((request) => ({ request, line: lineFor(request) }));
  const unlogged = breakLines.filter(
    ({ request, line }) => !line && expected.some((e) => e.seq === request.seq)
  );
  check(
    'prefixWatchLogged',
    unlogged.length === 0,
    unlogged.length === 0
      ? `${breakLines.filter((b) => b.line).length} of ${breakLines.length} break(s) logged by the host's prefix watch, every expected one among them`
      : `no line for ${unlogged.map(({ request }) => describe(request)).join('; ')}`
  );
  const strays = lines.prefixWatch.filter((l) => !matched.has(l));
  check(
    'noOtherPrefixWatch',
    strays.length === 0,
    strays.length === 0
      ? `${lines.prefixWatch.length} prefix-watch line(s), all accounted for`
      : `unaccounted: ${strays.map((l) => `${l.host} session=${l.session} purpose=${l.purpose} req=${l.req} ${l.fields}`).join('; ')}`
  );

  // B2: what the cache chain logged.
  const upstreamLines = (record: SessionRecord | undefined) =>
    lines.cacheChain.filter(
      (l) => l.kind === 'upstream' && record && l.session === record.dshSessionId
    );
  if (s1) {
    const found = upstreamLines(s1);
    check(
      'b2QuietOnS1',
      found.length === 0,
      found.length === 0
        ? 'no unexplained cache rebuild on S1 (single upstream), restart included'
        : found.map((l) => l.line).join('; ')
    );
  }
  const s3 = run.sessions.S3;
  if (s3) {
    const found = upstreamLines(s3);
    const evidenced = found.filter(
      (l) =>
        l.fields.prefix === 'append' && l.fields.matched !== undefined && l.fields.matched !== '-'
    );
    check(
      'b2FlagsSplitS3',
      evidenced.length > 0,
      `${found.length} upstream inconsistency line(s) on S3, ${evidenced.length} with prefix=append and a matched step`
    );
  }
  const clientLines = lines.cacheChain.filter((l) => l.kind === 'client');
  check(
    'b2NoUnexplainedClientBreak',
    clientLines.length === 0,
    clientLines.length === 0
      ? 'no "client request diverged without a logged cause" line'
      : clientLines.map((l) => `${l.host}: ${l.line}`).join('; ')
  );

  check(
    'requestTapOn',
    run.hosts.length > 0 && run.hosts.every((h) => lines.tapState[h.label] === TAP_ON),
    run.hosts
      .map((h) => `${h.label}: ${lines.tapState[h.label] ?? 'no request tap line'}`)
      .join('; ')
  );
  check(
    'noRequestTapWarnings',
    lines.tapWarnings.length === 0,
    lines.tapWarnings.length === 0 ? 'none' : lines.tapWarnings.join('; ')
  );
  check(
    'cleanShutdown',
    run.hosts.length > 0 &&
      run.hosts.every((h) => h.stop?.stopped === true && h.stop.exit.code === 0),
    run.hosts
      .map(
        (h) =>
          `${h.label}: ${h.stop ? `stopped=${h.stop.stopped} code=${h.stop.exit.code} signal=${h.stop.exit.signal}` : 'never stopped'}`
      )
      .join('; ')
  );

  // Each scenario did what it is there for.
  const gatewayOf = (record: SessionRecord | undefined) =>
    logged.filter((entry) => record && entry.userIdSession === record.gatewaySession);
  if (s1) {
    const facts = run.facts.S1 ?? {};
    const turns = (facts.turns ?? []) as Message[];
    const t1 = s1.phases.find((p) => p.label === 't1');
    const noteSeq = captured.find((r) => r.body.includes('PROBE-NOTE-S1'))?.seq;
    const note = facts.interject as Message | undefined;
    check(
      's1Evidence',
      turns.length === 3 &&
        turns.every((t) => t.idle === true && t.replyOk === true) &&
        note?.ok === true &&
        (note.result as Message | undefined)?.interjected === true &&
        noteSeq !== undefined &&
        t1 !== undefined &&
        noteSeq > t1.from &&
        noteSeq <= t1.to &&
        (facts.compact as Message | undefined)?.compacted === true &&
        laneOf(s1, 'compaction') !== undefined,
      `turns ${turns.map((t) => `${t.requestId}:${t.idle ? 'idle' : 'stuck'}/${t.replyOk ? 'done' : 'no reply'}/${t.toolCalls} calls`).join(' ')}; note ${JSON.stringify(note)} first seen at seq ${noteSeq ?? '-'} (turn 1: ${t1?.from}..${t1?.to}); compact ${JSON.stringify(facts.compact)}; compaction requests ${laneOf(s1, 'compaction')?.requests.length ?? 0}`
    );
  }
  if (s2) {
    const facts = run.facts.S2 ?? {};
    const answered = (facts.answered ?? []) as Message[];
    check(
      's2Evidence',
      answered.length === 2 &&
        answered.every((a) => a.ok === true) &&
        (facts.turn as Message | undefined)?.idle === true &&
        (facts.goalRound as Message | undefined)?.idle === true &&
        facts.written === true &&
        typeof approvalSeq === 'number',
      `reviews ${JSON.stringify(answered)}; plan turn idle ${(facts.turn as Message | undefined)?.idle}; goal round idle ${(facts.goalRound as Message | undefined)?.idle}; plan-output.txt ${facts.written ? 'written' : 'missing'}; approved after seq ${approvalSeq ?? '-'}`
    );
  }
  if (s3) {
    const facts = run.facts.S3 ?? {};
    const sims = gatewayOf(s3).map((entry) => entry.cacheSim as Message | undefined);
    const onB = sims.filter((sim) => sim?.backend === 'B').length;
    check(
      's3Evidence',
      (facts.turn as Message | undefined)?.idle === true &&
        (facts.turn as Message | undefined)?.replyOk === true &&
        onB > 0,
      `turn ${JSON.stringify(facts.turn)}; ${sims.length} requests, ${onB} on backend B`
    );
  }
  if (selected.has('S4')) {
    const facts = run.facts.S4 ?? {};
    check(
      's4Evidence',
      facts.sameSession === true &&
        (facts.turn as Message | undefined)?.idle === true &&
        (facts.turn as Message | undefined)?.replyOk === true,
      `reopened ${String(facts.dshSessionId)} (same: ${facts.sameSession}, history on bootstrap: ${facts.resumed}); turn ${JSON.stringify(facts.turn)}`
    );
  }
  check(
    'scenariosRan',
    run.errors.length === 0,
    run.errors.length === 0 ? [...selected].sort().join(', ') : run.errors.join(' | ')
  );

  // What the simulated upstream billed, per session: counts only.
  const billing = records.map((record) => {
    const entries = gatewayOf(record);
    const sims = entries
      .map((entry) => entry.cacheSim as Message | undefined)
      .filter((sim): sim is Message => sim !== undefined);
    return {
      scenario: record.scenario,
      requests: entries.length,
      simulated: sims.length,
      backendB: sims.filter((sim) => sim.backend === 'B').length,
      coldReads: sims.filter((sim) => sim.read === 0).length,
      compaction: entries.filter((entry) => entry.decision === 'compaction').length,
      thinkingForms: [...new Set(entries.map((entry) => entry.thinkingForm).filter(Boolean))],
    };
  });

  return {
    checks,
    expected: expectedFound,
    byPurpose,
    upstream,
    breakLines: breakLines.map(({ request, line }) => ({
      seq: request.seq,
      scenario: phaseOf(request.seq)?.record.scenario ?? '?',
      purpose: request.purpose,
      fields: request.fields,
      expected: expected.some((e) => e.seq === request.seq),
      logged: line ? `${line.host} req=${line.req}` : null,
    })),
    lines,
    billing,
    scenarioOf,
  };
}

// ---- output ------------------------------------------------------------------------------

/** The lanes with their scenario, the requests' verdicts (seq and fields only). */
function laneReport(chains: PrefixChains, label: (lane: PrefixLane) => string) {
  return chains.lanes.map((lane) => ({
    lane: label(lane),
    purpose: lane.purpose,
    sessionId: lane.sessionId ?? null,
    counts: lane.counts,
    transitions: lane.requests.map((r) => ({
      seq: r.seq,
      position: r.position,
      prevSeq: r.prevSeq ?? null,
      messages: r.messages,
      fields: r.fields,
    })),
  }));
}

function printSummary(
  pass: boolean,
  result: ReturnType<typeof evaluate>,
  run: Run,
  elapsedS: number
): void {
  const out: string[] = [];
  const checks = Object.entries(result.checks);
  const passed = checks.filter(([, c]) => c.ok).length;
  out.push(
    `[issue9] request prefix probe: ${pass ? 'PASS' : 'FAIL'} (${passed}/${checks.length} checks, ${elapsedS} s)`
  );
  const label = (lane: PrefixLane) => {
    const record = Object.values(run.sessions).find((r) => r.gatewaySession === lane.sessionId);
    return record ? `${record.scenario} ${record.dshSessionId}` : lane.chain.slice(0, 30);
  };
  out.push('lanes (session and purpose, as the host prefix watch keeps them):');
  for (const lane of result.byPurpose.lanes) {
    out.push(`  ${laneRow(lane, label(lane))}`);
    for (const request of lane.requests.filter(isBreak)) {
      const known = result.breakLines.find((b) => b.seq === request.seq);
      out.push(
        `      seq ${request.seq} (req ${request.position}) ${request.fields}  [${known?.expected ? 'expected' : 'UNEXPECTED'}; ${known?.logged ? `logged ${known.logged}` : 'not logged'}]`
      );
    }
  }
  out.push('upstream view (one chain per session, purposes together; informational):');
  for (const lane of result.upstream.lanes) {
    out.push(`  ${laneRow(lane, label(lane))}`);
    for (const line of laneBreaks(lane)) out.push(`      ${line}`);
  }
  out.push(
    `B2 lines: ${result.lines.cacheChain.length === 0 ? 'none' : ''}`,
    ...result.lines.cacheChain.map((l) => `  ${l.host}: ${l.line}`)
  );
  const s2 = run.sessions.S2;
  if (s2) {
    const onS2 = result.lines.cacheChain.filter((l) => l.session === s2.dshSessionId).length;
    out.push(`B2 on S2 (static usage, reported, not asserted): ${onS2} line(s)`);
  }
  out.push(
    `simulated upstream: ${result.billing.map((b) => `${b.scenario} ${b.simulated}/${b.requests} billed, ${b.backendB} on B, ${b.coldReads} cold, ${b.compaction} compaction`).join('; ')}`,
    `hosts: ${run.hosts.map((h) => `${h.label} peak tree RSS ${mbText(h.peakTreeMb)} (VmHWM ${mbText(h.hwmMb)})`).join('; ')}`
  );
  out.push('checks:');
  for (const [name, c] of checks) out.push(`  ${c.ok ? 'PASS' : 'FAIL'} ${name}: ${c.reason}`);
  process.stdout.write(`${out.join('\n')}\n`);
}

// ---- main ----------------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const started = performance.now();
  const startAvailableMb = availableMb();
  if (startAvailableMb < MIN_AVAILABLE_MB) {
    process.stderr.write(
      `[issue9] only ${startAvailableMb} MB available; the probe needs ${MIN_AVAILABLE_MB} MB (wait for other runs)\n`
    );
    return 2;
  }
  const machine = memoryWatch(undefined);
  const scratchRoot = join('/var/tmp', `aiclient-dsh-issue9-${Date.now()}`);
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const box = sandbox(scratchRoot, 'run');
  const hostCwd = join(box.root, 'host-cwd');
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  const captureDir = join(scratchRoot, 'capture');
  const gateway = await startFakeGateway(nodeBin, gatewayEntry, scratchRoot, {
    capture: captureDir,
  });
  const run: Run = {
    box,
    hostCwd,
    captureDir,
    gateway,
    // AICLIENT_RUNTIME_SESSION_METADATA, _PREFIX_WATCH and _CACHE_CHAIN are left unset: on.
    env: { ...baseEnv(box), DSH_HOME: box.dshHome, DSH_TELEMETRY_DISABLED: '1' },
    plan: fakeGatewayPlan({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      clientVersion: 'issue9-probe',
    }),
    hosts: [],
    sessions: {},
    facts: {},
    errors: [],
  };
  const timings: Record<string, number> = {};
  const timed = async (name: string, body: () => Promise<void>) => {
    const t0 = performance.now();
    try {
      await body();
    } catch (error) {
      run.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      timings[name] = Math.round(performance.now() - t0);
    }
  };
  try {
    let host1: HostRecord | undefined;
    let s1: ExperimentSession | undefined;
    await timed('host1', async () => {
      host1 = await startHost(run, 'issue9-h1');
    });
    if (host1) {
      const live = host1;
      if (args.selected.has('S1')) {
        await timed('S1', async () => {
          s1 = await runS1(run, live);
        });
      }
      if (args.selected.has('S2')) await timed('S2', () => runS2(run, live));
      if (args.selected.has('S3')) await timed('S3', () => runS3(run, live));
      await stopHost(live);
    }
    run.host1LastSeq = lastCapturedSeq(captureDir);
    if (args.selected.has('S4')) {
      await timed('S4', async () => {
        if (!s1) throw new Error('S1 did not complete; nothing to reopen');
        const reopened = s1;
        const host2 = await startHost(run, 'issue9-h2');
        try {
          await runS4(run, host2, reopened);
        } finally {
          await stopHost(host2);
        }
      });
    }
  } finally {
    for (const record of run.hosts) {
      if (!record.stop) {
        await stopHost(record).catch(() => {
          if (record.host.child.exitCode === null) record.host.child.kill('SIGKILL');
        });
      }
    }
    await stopFakeGateway(gateway);
  }

  const { minAvailableMb } = machine.stop();
  const result = evaluate(run, args.selected);
  const pass = Object.values(result.checks).every((c) => c.ok);
  const elapsedS = Math.round((performance.now() - started) / 1000);
  printSummary(pass, result, run, elapsedS);
  process.stdout.write(
    `memory: ${startAvailableMb} MB available at start, ${minAvailableMb} MB at the lowest\n`
  );
  if (!pass) {
    for (const { label, host } of run.hosts) {
      process.stderr.write(`--- ${label} stderr (tail)\n${host.stderr().slice(-3000)}\n`);
    }
  }
  if (args.out) {
    const label = (lane: PrefixLane) => result.scenarioOf(lane);
    const report = {
      probe: 'issue-9-request-prefix',
      pass,
      scenarios: [...args.selected].sort(),
      checks: result.checks,
      expectedBreaks: result.expected,
      breaks: result.breakLines,
      lanes: laneReport(result.byPurpose, label),
      upstreamLanes: laneReport(result.upstream, label),
      sessions: run.sessions,
      facts: run.facts,
      prefixWatchLines: result.lines.prefixWatch,
      cacheChainLines: result.lines.cacheChain.map(({ host, line }) => ({ host, line })),
      simulatedUpstream: result.billing,
      hosts: run.hosts.map((h) => ({
        label: h.label,
        ready: h.ready,
        fatal: h.fatal ?? null,
        stop: h.stop ?? null,
        tap: result.lines.tapState[h.label] ?? null,
        hwmMb: h.hwmMb ?? null,
        peakTreeMb: h.peakTreeMb ?? null,
      })),
      timingsMs: timings,
      elapsedS,
      memory: { startAvailableMb, minAvailableMb },
      errors: run.errors,
      scratch: args.keep ? scratchRoot : null,
    };
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (args.keep) process.stderr.write(`[issue9] scratch kept at ${scratchRoot}\n`);
  else rmSync(scratchRoot, { recursive: true, force: true });
  return pass ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`[issue9] ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
);
