/**
 * dsh-rebase P1-9c pre-work experiments (plan P1-9 shard 05 §1, decisions
 * 053 and 054), against a real DSH host (source checkout) and the local fake
 * gateway. One host, one scratch DSH_HOME:
 *
 *   out-node-runtime/node src/dsh-host/tools/seed-experiments.ts [--keep] [--out report.json]
 *
 * Every source is the committed synthetic corpus
 * (src/shared/__tests__/fixtures/legacy-pi, P1-9g), converted by the P1-9b
 * converter in this process; nothing is read from a user directory.
 *
 *   E1  every corpus file that converts: images admitted through
 *       `ctx.attachments` one by one and bound, `agents.create({seed})` without
 *       `isSeeded` (a replayed history, not a fork), `sessions.flush`,
 *       dispose, a cold `observeSession` compared with the seed event by
 *       event, `agents.resume` at once, one turn on the fake gateway
 *       (P0-RECALL: text the model surface holds must reach the model, text a
 *       compaction masked and display-only rows must not), and what that turn
 *       logged: `request/header` (`initial`), the empty system head replaced
 *       in place, the turn's end, and pi-ai's replay-degrade warnings.
 *       Also: the same seed created twice (same log, same image references),
 *       a create under an id DSH already has, a cwd that does not exist.
 *       The first round (converter version 1) found DSH's reader refuses a
 *       replacing checkpoint outside a compaction transaction, after `create`
 *       and `flush` took it; a prototype here wrapped them and passed. Since
 *       version 2 the converter writes the transaction itself (decision 121),
 *       and this script runs its seeds as they are.
 *   E2  ignorable `aiclient/*` events: through flush, a cold read, a fork
 *       (the bridge's `buildDshForkSeed` against DSH's own `buildForkSeed`)
 *       at the seed's end, the first turn's end and the log's end, and the
 *       forked child's cold read; and (E1's markers) never in the model request.
 *
 * Refuses to start below 900 MB available. Signals only ever go to a
 * ChildProcess this script spawned. Every model request goes to the fake
 * gateway; the probe hooks drop any non-loopback connect.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DshLogEvent } from '../../shared/dshHistory/types.ts';
import {
  bindSeedImages,
  checkSeed,
  convertPiSessionBytes,
  type DshSeedEvent,
  seedSurface,
} from '../../shared/legacyPiSession/convert/index.ts';
import { buildDshForkSeed } from '../bridge/forkSeed.ts';
import { fakeGatewayPlan, isRecord, type Message, serveModelPlan } from './lib/hostClient.ts';
import { baseEnv, captureStderr, exitOf, sandbox, sleep } from './lib/kit.ts';
import { installProbeBundle, probeBundleSource } from './lib/probe-bundle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const rowSource = join(here, 'lib', 'seed-experiment-row.mjs');
const corpusDir = join(repoRoot, 'src', 'shared', '__tests__', 'fixtures', 'legacy-pi');
const dshSessionModule = join(
  hostDir,
  'node_modules',
  '@deepseek-ai',
  'dsh-session',
  'lib',
  'index.js'
);
const MIN_AVAILABLE_MB = 900;
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const outIndex = argv.indexOf('--out');
const outFile = outIndex >= 0 ? argv[outIndex + 1] : '';
/** Events DSH appends when it creates an agent (bridge/sessionGc.ts). */
const SETUP_EVENTS = new Set(['permission/preset', 'sandbox/mode', 'approval/policy']);

interface ManifestEntry {
  file: string;
  read: string;
  sourcePath: string;
  cwd: string;
}

function availableMb(): number {
  try {
    const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
    return match ? Number(match[1]) / 1024 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** tools/probe-bundle plus the experiment row, in a scratch directory. */
function experimentBundle(root: string): string {
  const dir = join(root, 'probe-bundle');
  cpSync(probeBundleSource, dir, { recursive: true });
  copyFileSync(rowSource, join(dir, 'lib', 'seed-experiment.js'));
  const manifestFile = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    exports: Record<string, string>;
  };
  manifest.exports['./seed-experiment'] = './lib/seed-experiment.js';
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  // The patch file ends inside its `insert:` list.
  appendFileSync(
    join(dir, 'cordis.patch.yml'),
    "\n    - id: aiclient-seed-experiment\n      name: '@aiclient/dsh-probe/seed-experiment'\n"
  );
  return dir;
}

async function startGateway(root: string, nodeBin: string) {
  const log = join(root, 'gateway.jsonl');
  const child = spawn(
    nodeBin,
    [
      gatewayEntry,
      '--port',
      '0',
      '--plan',
      'dsh-p0-2',
      '--reset',
      '--state',
      join(root, 'gateway.state.json'),
      '--log',
      log,
      '--model-id',
      'fake-1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const port = await new Promise<number>((done, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error('fake gateway did not start')), 15_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
  });
  child.stderr?.resume();
  return { child, port, log };
}

class Experiment {
  private seq = 0;
  private readonly replies: Message[] = [];
  private readonly waiters = new Set<() => void>();
  readonly controls: Message[] = [];
  private readonly child: ChildProcess;
  constructor(child: ChildProcess) {
    this.child = child;
    child.on('message', (message: unknown) => {
      if (!isRecord(message)) return;
      if (typeof message.rx9cReply === 'string') this.replies.push(message);
      else this.controls.push(message);
      for (const wake of [...this.waiters]) wake();
    });
  }

  async until<T>(find: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
    const found = find();
    if (found !== undefined) return found;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        done(undefined);
      }, timeoutMs);
      const wake = () => {
        const value = find();
        if (value === undefined) return;
        clearTimeout(timer);
        this.waiters.delete(wake);
        done(value);
      };
      this.waiters.add(wake);
    });
  }

  async op(op: string, payload: Message = {}, timeoutMs = 120_000): Promise<Message> {
    const requestId = `rx9c-${++this.seq}`;
    this.child.send({ rx9c: op, requestId, ...payload });
    const reply = await this.until(
      () => this.replies.find((item) => item.requestId === requestId),
      timeoutMs
    );
    if (!reply) throw new Error(`${op} timed out`);
    if (reply.error) throw new Error(`${op}: ${String(reply.error)}`);
    return reply;
  }
}

/** JSON with sorted keys: DSH's frozen copies need not keep our key order. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
}

/** The first event that differs, and which envelope keys differ in it. */
function firstMismatch(
  expected: readonly unknown[],
  actual: readonly unknown[]
): { index: number; keys: string[] } | null {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    const a = expected[index] as Message | undefined;
    const b = actual[index] as Message | undefined;
    if (canon(a) === canon(b)) continue;
    const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(
      (key) => canon(a?.[key]) !== canon(b?.[key])
    );
    return { index, keys };
  }
  return null;
}

function textOf(content: unknown): string {
  return Array.isArray(content)
    ? content
        .filter((block) => isRecord(block) && block.type === 'text')
        .map((block) => String((block as Message).text))
        .join('\n')
    : '';
}

function messageOf(event: DshSeedEvent): Message | undefined {
  const data = event.data as Message | undefined;
  if (!data) return undefined;
  return event.type === 'user/message' ? data : (data.message as Message | undefined);
}

/** A short, distinctive slice of `text`: its first line, at most 24 characters. */
function snippet(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length >= 6);
  return line ? line.slice(0, 24) : undefined;
}

/**
 * RECALL markers: text on the model surface (must reach the model), and text
 * that a compaction masked or only a display row holds (must not).
 */
function markersFor(seed: readonly DshSeedEvent[]): { present: string[]; absent: string[] } {
  const surface = new Set(seedSurface(seed));
  const visibleText = [...surface]
    .map((seq) => textOf(messageOf(seed[seq] as DshSeedEvent)?.content))
    .join('\n');
  const present: string[] = [];
  const firstUser = [...surface]
    .map((seq) => seed[seq] as DshSeedEvent)
    .find(
      (event) =>
        event.type === 'user/message' &&
        (messageOf(event)?.source as Message | undefined)?.kind === 'user' &&
        snippet(textOf(messageOf(event)?.content))
    );
  const lastAssistant = [...surface]
    .map((seq) => seed[seq] as DshSeedEvent)
    .reverse()
    .find(
      (event) => event.type === 'assistant/message' && snippet(textOf(messageOf(event)?.content))
    );
  for (const event of [firstUser, lastAssistant]) {
    const text = event ? snippet(textOf(messageOf(event)?.content)) : undefined;
    if (text && !present.includes(text)) present.push(text);
  }
  const absent: string[] = [];
  for (const event of seed) {
    if (absent.length >= 2) break;
    let text: string | undefined;
    if (event.ignorable) {
      const data = event.data as Message;
      const candidate = [data.text, data.summary, data.title, data.label]
        .concat(Array.isArray(data.content) ? [textOf(data.content)] : [])
        .find((item) => typeof item === 'string' && item.length >= 6);
      text = typeof candidate === 'string' ? snippet(candidate) : undefined;
    } else if (!surface.has(event.seq)) {
      text = snippet(textOf(messageOf(event)?.content));
    }
    if (text && !visibleText.includes(text) && !absent.includes(text)) absent.push(text);
  }
  return { present, absent };
}

function lastAssistantText(events: readonly DshLogEvent[]): string {
  const last = [...events].reverse().find((event) => event.type === 'assistant/message');
  return textOf(((last?.data as Message | undefined)?.message as Message | undefined)?.content);
}

function gatewayRecalls(log: string): Message[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Message)
    .filter((line) => String(line.decision ?? '').startsWith('RECALL'));
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function main(): Promise<number> {
  const available = availableMb();
  if (available < MIN_AVAILABLE_MB) {
    process.stderr.write(
      `[rx9c] only ${Math.round(available)} MB available (< ${MIN_AVAILABLE_MB}); not starting a host\n`
    );
    return 2;
  }
  const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
  const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;
  const scratchRoot = join('/var/tmp', `aiclient-dsh-p1-9c-exp-${randomBytes(6).toString('hex')}`);
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const box = sandbox(scratchRoot, 'run');
  const hostCwd = join(box.root, 'host-cwd');
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  installProbeBundle(box.dshHome, experimentBundle(scratchRoot));
  const gateway = await startGateway(box.root, nodeBin);
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_DSH_PROBE_ROW: '0',
  };
  const child = spawn(nodeBin, ['--expose-internals', '--import', hooksEntry, hostEntry], {
    cwd: hostCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  serveModelPlan(
    child,
    fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gateway.port}` }),
    'p1-9c-fake-key'
  );
  const stderr = captureStderr(child);
  const exited = exitOf(child);
  const x = new Experiment(child);
  const report: Message = {};
  let failed = false;
  try {
    const ready = await x.until(
      () => x.controls.find((message) => message.type === 'ready' || message.type === 'fatal'),
      180_000
    );
    if (ready?.type !== 'ready') throw new Error(`no ready: ${stderr().slice(-800)}`);
    const cwd = box.workspace;
    const manifest = (
      JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8')) as {
        files: ManifestEntry[];
      }
    ).files;

    // ---- E1: every convertible corpus file -------------------------------------------
    const rows: Message[] = [];
    const created = new Map<string, { id: string; seed: DshSeedEvent[]; cold: DshLogEvent[] }>();
    let index = 0;
    for (const entry of manifest) {
      index += 1;
      const row: Message = { file: entry.file };
      rows.push(row);
      const conversion = convertPiSessionBytes(readFileSync(join(corpusDir, entry.file)), {
        sourceFile: entry.sourcePath,
        cwd: entry.cwd,
      });
      if (!conversion.ok) {
        row.converted = false;
        row.failure = conversion.failure;
        continue;
      }
      row.converted = true;
      let refs: Record<string, Message | null> = {};
      if (conversion.images.length > 0) {
        const admitted = await x.op('admit', { images: conversion.images });
        refs = admitted.refs as Record<string, Message | null>;
        row.imagesRefused = admitted.refused;
      }
      const bound = bindSeedImages(conversion.seed, new Map(Object.entries(refs)));
      row.images = { distinct: conversion.images.length, bound: bound.bound, failed: bound.failed };
      row.violationsBound = checkSeed(bound.events, { images: 'bound' }).map(
        (violation) => `${violation.rule}@${violation.seq}`
      );
      row.compactions = bound.events.filter((event) => event.type === 'compaction/start').length;
      const id = `aiclient-x9c-${String(index).padStart(2, '0')}`;
      await exercise(row, id, bound.events, entry.file);
    }
    report.e1 = rows;

    /** One seed through create, flush, dispose, a cold read, resume and one recorded turn. */
    async function exercise(row: Message, id: string, seed: DshSeedEvent[], key: string) {
      row.seedEvents = seed.length;
      const create = await x.op('create', { sessionId: id, cwd, seed });
      row.create = {
        ok: create.ok,
        flushed: create.flushed,
        onDisk: isRecord(create.statAfterFlush),
        createdMs: create.createdMs,
        flushMs: create.flushMs,
        ...(create.ok ? {} : { errorName: create.errorName, message: create.message }),
      };
      if (!create.ok) return;
      await x.op('dispose', { sessionId: id });
      const cold = await x.op('observe', { sessionId: id });
      const coldEvents = (cold.events ?? []) as DshLogEvent[];
      row.cold = {
        ok: cold.ok,
        ...(cold.ok ? {} : { errorName: cold.errorName, message: cold.message }),
        source: cold.source,
        inheritedEventCount: cold.inheritedEventCount,
        events: coldEvents.length,
        seedMismatch: firstMismatch(seed, coldEvents.slice(0, seed.length)),
        tail: coldEvents.slice(seed.length).map((event) => event.type),
        tailIsEndSeedThenSetup:
          coldEvents[seed.length]?.type === 'session/end-seed' &&
          coldEvents.slice(seed.length + 1).every((event) => SETUP_EVENTS.has(event.type)),
        endSeedData: coldEvents[seed.length]?.data,
        endSeedIgnorable:
          (coldEvents[seed.length] as unknown as Message | undefined)?.ignorable ?? null,
      };
      created.set(key, { id, seed, cold: coldEvents });
      const degradeBefore = count(stderr(), 'unusable replay state');
      const resume = await x.op('resume', { sessionId: id, cwd });
      row.resume = {
        ok: resume.ok,
        ms: resume.ms,
        ...(resume.ok ? {} : { errorName: resume.errorName, message: resume.message }),
      };
      if (!resume.ok) return;
      const live = (await x.op('observe', { sessionId: id })).events as DshLogEvent[];
      row.resumeAppended = live.slice(coldEvents.length).map((event) => event.type);
      const markers = markersFor(seed);
      row.markers = markers;
      const recallsBefore = gatewayRecalls(gateway.log).length;
      const prompt = await x.op('prompt', {
        sessionId: id,
        text: `P0-RECALL ${JSON.stringify({ markers: [...markers.present, ...markers.absent] })} which markers do you see?`,
      });
      const after = (await x.op('observe', { sessionId: id })).events as DshLogEvent[];
      const added = after.slice(live.length);
      const head = seed.find((event) => event.type === 'system/message');
      const header = added.find((event) => event.type === 'request/header');
      const systems = added.filter((event) => event.type === 'system/message');
      const turnEnd = [...added].reverse().find((event) => event.type === 'turn/end');
      const reply = lastAssistantText(after);
      const recall = gatewayRecalls(gateway.log).slice(recallsBefore).at(-1);
      row.turn = {
        idle: prompt.idle,
        addedTypes: added.map((event) => event.type),
        requestHeaderReason: (header?.data as Message | undefined)?.reason ?? null,
        headSeq: head?.seq ?? null,
        systemMessages: systems.map((event) => ({
          seq: event.seq,
          surfaceOp: (event as unknown as Message).surfaceOp ?? null,
          sourceEventSeqs: (event as unknown as Message).sourceEventSeqs ?? null,
          textChars: textOf(((event.data as Message).message as Message | undefined)?.content)
            .length,
        })),
        headReplacedInPlace: systems.some((event) => {
          const op = (event as unknown as Message).surfaceOp as Message | undefined;
          return (
            isRecord(op) &&
            op.op === 'replace' &&
            op.startSeq === head?.seq &&
            op.endSeq === head?.seq
          );
        }),
        turnEnd: (turnEnd?.data as Message | undefined)?.reason ?? null,
        reply: reply.slice(0, 200),
        gatewayProbe: recall?.probe ?? null,
        degradeWarnings: count(stderr(), 'unusable replay state') - degradeBefore,
      };
      // Markers may hold spaces: split the tag at its two labels, not at whitespace.
      const tag = reply.match(/present=([\s\S]*) missing=([\s\S]*)$/);
      row.recallOk =
        tag !== null &&
        markers.present.every((marker) => (tag[1] ?? '').includes(marker)) &&
        markers.absent.every((marker) => (tag[2] ?? '').includes(marker));
      await x.op('dispose', { sessionId: id });
    }

    // ---- E1 extras --------------------------------------------------------------------
    const basic = created.get('v4-basic.jsonl');
    if (!basic) throw new Error('v4-basic.jsonl was not created');
    const extras: Message = {};
    // The same source again: the same references, and the same log under another id.
    const again = convertPiSessionBytes(readFileSync(join(corpusDir, 'v4-basic.jsonl')), {
      sourceFile: '/tmp/aiclient-legacy-pi-corpus/sessions/v4-basic.jsonl',
      cwd: '/tmp/aiclient-legacy-pi-corpus/workspace',
    });
    if (!again.ok) throw new Error('v4-basic.jsonl did not convert twice');
    const readmitted = await x.op('admit', { images: again.images });
    const rebound = bindSeedImages(
      again.seed,
      new Map(Object.entries(readmitted.refs as Record<string, Message | null>))
    );
    extras.sameSeedTwice = canon(rebound.events) === canon(basic.seed);
    const dupId = 'aiclient-x9c-dup';
    const dup = await x.op('create', { sessionId: dupId, cwd, seed: rebound.events });
    await x.op('dispose', { sessionId: dupId });
    const dupCold = (await x.op('observe', { sessionId: dupId })).events as DshLogEvent[];
    extras.sameLogUnderAnotherId = {
      created: dup.ok,
      firstMismatch: firstMismatch(
        basic.cold.slice(0, basic.seed.length),
        dupCold.slice(0, basic.seed.length)
      ),
      endSeedMismatch: firstMismatch(
        basic.cold.slice(basic.seed.length, basic.seed.length + 1),
        dupCold.slice(basic.seed.length, basic.seed.length + 1)
      ),
      tailTypesEqual:
        canon(basic.cold.slice(basic.seed.length).map((event) => event.type)) ===
        canon(dupCold.slice(basic.seed.length).map((event) => event.type)),
    };
    // A create under an id DSH already has.
    const clash = await x.op('create', { sessionId: basic.id, cwd, seed: basic.seed });
    extras.createExisting = { ok: clash.ok, errorName: clash.errorName };
    if (clash.ok) await x.op('dispose', { sessionId: basic.id });
    // A workspace that does not exist.
    const missingCwd = join(box.root, 'no-such-workspace');
    const nowhere = await x.op('create', {
      sessionId: 'aiclient-x9c-nocwd',
      cwd: missingCwd,
      seed: basic.seed,
    });
    extras.missingCwd = {
      ok: nowhere.ok,
      errorName: nowhere.errorName,
      message: typeof nowhere.message === 'string' ? nowhere.message.slice(0, 160) : undefined,
      dirCreated: existsSync(missingCwd),
    };
    if (nowhere.ok) {
      await x.op('dispose', { sessionId: 'aiclient-x9c-nocwd' });
      const reopened = await x.op('resume', { sessionId: 'aiclient-x9c-nocwd', cwd: missingCwd });
      extras.missingCwdResume = { ok: reopened.ok, errorName: reopened.errorName };
      if (reopened.ok) await x.op('dispose', { sessionId: 'aiclient-x9c-nocwd' });
    }
    report.e1Extras = extras;

    // ---- E2: ignorable events through disk, cold read and fork ----------------------------
    const e2: Message[] = [];
    for (const file of [
      'v4-import-claude.jsonl',
      'v4-subagent.jsonl',
      'v4-basic.jsonl',
      'v4-cli.jsonl',
      'v4-compaction.jsonl',
    ]) {
      const made = created.get(file);
      if (!made || made.cold.length === 0) {
        e2.push({ file, skipped: made ? 'log not readable in E1' : 'not created in E1' });
        continue;
      }
      const ignorable = made.seed.filter((event) => event.ignorable === true);
      const coldIgnorable = made.cold.filter(
        (event) => (event as unknown as Message).ignorable === true
      );
      const row: Message = {
        file,
        seedIgnorable: ignorable.map((event) => event.type),
        coldKeptAll:
          canon(ignorable) === canon(coldIgnorable.filter((event) => event.seq < made.seed.length)),
      };
      // The whole log now (the E1 turn included), read cold.
      const now = (await x.op('observe', { sessionId: made.id })).events as DshLogEvent[];
      const seedEnd = made.seed.length - 1;
      const boundaries = [
        seedEnd,
        now.findIndex((event) => event.type === 'turn/end'),
        now.length - 1,
      ].filter((value, at, all) => value >= 0 && all.indexOf(value) === at);
      const forks: Message[] = [];
      for (const boundary of boundaries) {
        const ours = buildDshForkSeed(now, boundary);
        const theirs = (
          await x.op('dsh-fork-seed', { modulePath: dshSessionModule, events: now, boundary })
        ).seed as DshLogEvent[];
        // A dotless id: DSH's projection cache refuses keys with a dot (warns, stays stale).
        const childId = `${made.id}-f${boundary}`;
        const createdChild = await x.op('create', {
          sessionId: childId,
          cwd,
          seed: ours,
          inheritedEventCount: boundary + 1,
          parentSession: made.id,
          isSeeded: true,
        });
        if (createdChild.ok) await x.op('dispose', { sessionId: childId });
        const childCold = createdChild.ok
          ? ((await x.op('observe', { sessionId: childId })).events as DshLogEvent[])
          : [];
        const expected = now
          .slice(0, boundary + 1)
          .filter((event) => (event as unknown as Message).ignorable === true);
        const kept = childCold.filter((event) => (event as unknown as Message).ignorable === true);
        forks.push({
          boundary,
          boundaryType: now[boundary]?.type,
          seedCopyMatchesDsh: canon(ours) === canon(theirs),
          childCreated: createdChild.ok,
          childError: createdChild.errorName,
          ignorableExpected: expected.length,
          ignorableKept: kept.length,
          ignorableEqual: canon(expected) === canon(kept),
        });
      }
      row.forks = forks;
      e2.push(row);
    }
    report.e2 = e2;

    const e1Rows = rows.filter((row) => row.converted === true);
    /** Each E1 check over `set`: true, or the files it failed for. */
    const checks = (set: Message[]) => {
      const failing = (pass: (row: Message) => boolean): true | string[] => {
        const bad = set.filter((row) => !pass(row)).map((row) => String(row.file));
        return bad.length === 0 ? true : bad;
      };
      return {
        created: failing((row) => (row.create as Message | undefined)?.ok === true),
        flushedOnDisk: failing((row) => (row.create as Message | undefined)?.onDisk === true),
        coldEqualsSeed: failing(
          (row) =>
            (row.cold as Message | undefined)?.ok === true &&
            (row.cold as Message).seedMismatch === null
        ),
        tailEndSeedThenSetup: failing(
          (row) => (row.cold as Message | undefined)?.tailIsEndSeedThenSetup === true
        ),
        resumeAtOnce: failing((row) => (row.resume as Message | undefined)?.ok === true),
        headerInitial: failing(
          (row) => (row.turn as Message | undefined)?.requestHeaderReason === 'initial'
        ),
        headReplacedInPlace: failing(
          (row) => (row.turn as Message | undefined)?.headReplacedInPlace === true
        ),
        turnCompleted: failing(
          (row) =>
            ((row.turn as Message | undefined)?.turnEnd as Message | undefined)?.kind ===
            'completed'
        ),
        recall: failing((row) => row.recallOk === true),
        degradeWarnings: set.reduce(
          (sum, row) => sum + Number((row.turn as Message | undefined)?.degradeWarnings ?? 0),
          0
        ),
      };
    };
    const verdict = {
      E1_converted: `${e1Rows.length}/${rows.length}`,
      E1: checks(e1Rows),
      E1_sameSeedTwice: extras.sameSeedTwice,
      E1_sameLogUnderAnotherId: (extras.sameLogUnderAnotherId as Message).firstMismatch === null,
      E1_createExistingRefused: (extras.createExisting as Message).ok === false,
      E2_coldKeepsIgnorable: e2.every(
        (row) => row.skipped !== undefined || row.coldKeptAll === true
      ),
      E2_forkKeepsIgnorable: e2.every(
        (row) =>
          row.skipped !== undefined ||
          (row.forks as Message[]).every(
            (fork) => fork.childCreated === true && fork.ignorableEqual === true
          )
      ),
      E2_seedCopyMatchesDsh: e2.every(
        (row) =>
          row.skipped !== undefined ||
          (row.forks as Message[]).every((fork) => fork.seedCopyMatchesDsh === true)
      ),
    };
    report.verdict = verdict;
    const allTrue = (value: unknown): boolean =>
      value === true ||
      typeof value === 'number' ||
      typeof value === 'string' ||
      (isRecord(value) && !Array.isArray(value) && Object.values(value).every(allTrue));
    failed = !allTrue(verdict);
  } catch (error) {
    failed = true;
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    report.stderrTail = stderr().slice(-2000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.send({ type: 'shutdown' });
      await Promise.race([exited, sleep(20_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await exited;
    gateway.child.kill('SIGTERM');
    if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
    else report.scratch = scratchRoot;
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outFile) writeFileSync(outFile, text);
  else process.stdout.write(text);
  return failed ? 1 : 0;
}

process.exitCode = await main();
