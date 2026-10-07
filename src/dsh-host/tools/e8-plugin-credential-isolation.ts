/**
 * Experiment E8 (dsh-rebase P1-10/P1-16 plan §3; serves P1-5, decisions 034
 * and 085): what can a same-process third-party plugin reach of the host's
 * credentials?
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/e8-plugin-credential-isolation.ts
 *      [--host-dir ../../out-dsh-host] [--out file.json] [--keep])
 *
 * Two questions:
 *   Q1  can the `aiclient-credentials` row tell who is calling, so it could
 *       answer the llm route and refuse every plugin?
 *   Q2  can a plugin read the credential answers Main sends over the host's
 *       own IPC channel (decision 034 rule 4 only covered tool subprocesses)?
 *
 * One packaged host (a copy of a built `out-dsh-host`) with the test-only
 * plugin `@aiclient-test/dsh-credential-probe` (tools/credential-probe-plugin)
 * preinstalled the way the product ships one — its own directory under
 * node_modules, a dependency of the host's package.json, an entry in the
 * manifest's `plugins` section (tools/lib/plugin-install.ts) — and enabled
 * through Main's own environment rule. The plugin row, while the host boots:
 * asks `ctx.credentials` for one reference of the model plan and one that is
 * not in it, tries the write half, reads the raw provider out of the cordis
 * proxy, wraps the provider's `resolve` to record the caller identity a
 * provider can see, listens on the IPC channel, and forges one credential
 * request with the nonce the outgoing traffic carried. Then one turn runs
 * through the local fake gateway, which makes the host pull a key the plugin
 * never asked for.
 *
 * The key is a `sk-e8-canary-…` the driver invents and serves itself; the
 * plugin never writes a value, only sha256 digests, which this driver compares
 * with the digest of what it served. Refuses to start below 800 MB available.
 * Every model request goes to the fake gateway; signals only ever go to a
 * ChildProcess this script spawned.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Main's own environment rule, loaded by Node's type stripping (no imports there).
import { buildDshHostEnvironment } from '../../main/services/agent-host/dshHostEnvironment.ts';
import { keyRefFor } from '../../shared/dshModelPlan/build.ts';
import {
  gatewayRequests,
  oneTurn,
  readyOrFatal,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
} from './lib/experiment-host.ts';
import { FAKE_ROUTE, fakeGatewayPlan, type Message } from './lib/hostClient.ts';
import { sandbox, sleep } from './lib/kit.ts';
import { assembleInstall, type ManifestPlugin } from './lib/plugin-install.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostSource = resolve(here, '..');
const repoRoot = resolve(hostSource, '..', '..');
const nodeBin = join(repoRoot, 'out-node-runtime', 'node');
const argv = process.argv.slice(2);
const option = (name: string, fallback: string) =>
  argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback;
const artifactDir = resolve(option('host-dir', join(repoRoot, 'out-dsh-host')));
const outFile = option('out', '');
const keep = argv.includes('--keep');
const scratchRoot = join('/var/tmp', `aiclient-dsh-e8-${Date.now()}`);

const PROBE_PLUGIN = '@aiclient-test/dsh-credential-probe';
const PROBE_VERSION = '0.0.1';
const PROBE_ROW = 'credential-probe';
const PROBE_SOURCE = join(here, 'credential-probe-plugin');
/** Our own credentials row, and DSH's llm row: the two other callers expected. */
const CREDENTIALS_ROW = 'aiclient-credentials';
const LLM_ROW = 'llm-pi-ai';
/** A reference no plan of this experiment holds. */
const BOGUS_REF = 'E8_REF_NOT_IN_THE_PLAN';

function availableMb(): number {
  const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
  return match ? Math.round(Number(match[1]) / 1024) : Math.round(os.freemem() / 1048576);
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The plugin's JSONL log, as far as it has been written. */
function probeRecords(file: string): Message[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Message);
}

/** Wait until the plugin wrote its `probe-done` line (it probes while the host boots). */
async function probeSettled(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = probeRecords(file);
    if (records.some((record) => record.step === 'probe-done' || record.step === 'probe-failed')) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

function manifestEntry(): ManifestPlugin {
  return {
    name: PROBE_PLUGIN,
    version: PROBE_VERSION,
    kind: 'internal',
    defaultEnabled: false,
    description: 'Test-only credential probe plugin (E8)',
    rows: [PROBE_ROW],
    tools: {},
    replaces: [],
  };
}

async function main() {
  const available = availableMb();
  if (available < 800) {
    throw new Error(`only ${available} MB available; E8 needs 800 MB (wait for other runs)`);
  }
  if (!existsSync(join(artifactDir, 'host.js'))) {
    throw new Error(`${artifactDir} holds no built host; run node scripts/build-dsh-host.mjs`);
  }
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const install = await assembleInstall({
    into: join(scratchRoot, 'install'),
    base: { artifact: artifactDir },
    plugins: [{ dir: PROBE_SOURCE, entry: manifestEntry() }],
  });
  const gateway = await startFakeGateway(nodeBin, join(here, 'fake-gateway.mjs'), scratchRoot);
  const box = sandbox(scratchRoot, 'probe');
  const cwd = join(box.root, 'host-cwd');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const probeLog = join(box.root, 'probe.jsonl');
  const canary = `sk-e8-canary-${randomBytes(12).toString('hex')}`;
  const planRef = keyRefFor(FAKE_ROUTE);
  const env = {
    ...buildDshHostEnvironment({
      dshHome: box.dshHome,
      nativeCacheDir: join(box.root, 'native-cache'),
      isPackaged: true,
      pluginOverrides: { [PROBE_PLUGIN]: true },
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        HOME: box.home,
        TMPDIR: box.tmp,
        USER: os.userInfo().username,
        SHELL: '/bin/bash',
      },
    }),
    // The probe's own switches; no `AICLIENT_` name, so Main's rule keeps them.
    E8_PROBE_LOG: probeLog,
    E8_PLAN_REF: planRef,
    E8_BOGUS_REF: BOGUS_REF,
    E8_FORGE: '1',
  };
  const host = startExperimentHost({
    label: 'e8',
    nodeBin,
    entry: install.entry,
    cwd,
    env,
    plan: fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gateway.port}`, clientVersion: 'e8' }),
    key: canary,
  });
  let ready: Message | undefined;
  let turn: Awaited<ReturnType<typeof oneTurn>> | undefined;
  let settled = false;
  let stop: Awaited<ReturnType<typeof stopExperimentHost>> = {
    stopped: false,
    exit: { code: null, signal: null },
  };
  let requests: Message[] = [];
  try {
    ready = await readyOrFatal(host);
    settled = await probeSettled(probeLog, 30_000);
    const before = gatewayRequests(gateway.log).length;
    if (ready?.type === 'ready') {
      turn = await oneTurn(host, {
        sessionId: 'e8-probe',
        cwd: box.workspace,
        text: 'P0-STREAM: stream a short answer.',
      });
    }
    requests = gatewayRequests(gateway.log).slice(before);
    stop = await stopExperimentHost(host);
  } finally {
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
    gateway.child.kill();
  }

  const records = probeRecords(probeLog);
  const step = (name: string) => records.filter((record) => record.step === name);
  const one = (name: string) => step(name)[0];
  const canaryDigest = digestOf(canary);
  const served = (record: Message | undefined) => record?.digest === canaryDigest;
  const plugins = (ready?.plugins as { plugins?: Message[] } | undefined)?.plugins ?? [];
  const probeState = plugins.find((item) => item.name === PROBE_PLUGIN);
  const providerCalls = step('provider-saw-call');
  const rowOf = (record: Message | undefined) =>
    String(((record?.caller ?? {}) as Message).rowId ?? '');
  // The row's own call, the raw-provider call, and the host's llm row during the turn.
  const ownCall = providerCalls.find((record) => rowOf(record) === PROBE_ROW);
  const bypassCall = providerCalls.find((record) => rowOf(record) === CREDENTIALS_ROW);
  const llmCall = providerCalls.find((record) => rowOf(record) === LLM_ROW);
  const inbound = step('ipc-inbound');
  const credentialResults = inbound.filter((record) => record.host === 'credential-result');
  const unaskedResult = credentialResults.find(
    (record) => record.duringProbe === false && served(record.value as Message | undefined)
  );
  const forged = one('forged-request');
  const outbound = step('ipc-outbound');

  const checks = {
    // The scratch host ran the plugin the way the product would.
    pluginLoaded:
      ready?.type === 'ready' &&
      probeState?.state === 'loaded' &&
      (ready?.bundles as string[] | undefined)?.includes(PROBE_PLUGIN) === true &&
      ((ready?.census as Message | undefined)?.inactive as string[] | undefined)?.length === 0,
    probeSettled: settled,
    // Q1: today the row answers any caller that names a reference of the plan.
    planRefServedToThePlugin: served(one('resolve-plan-ref')),
    bogusRefUnserved:
      one('resolve-bogus-ref')?.value === null &&
      host.served.requests.every((request) => request.ref !== BOGUS_REF),
    writeHalfRefused: step('write-half')
      .filter((record) =>
        ['set', 'unset', 'modifyRecord', 'deleteRecord'].includes(String(record.operation))
      )
      .every((record) => record.refused === true && record.code === 'CREDENTIALS_READ_ONLY'),
    // Q1: a provider can read the caller's own row, and the llm row differs from the plugin's.
    providerSeesCallerRow:
      ownCall !== undefined &&
      llmCall !== undefined &&
      step('row-active')[0] !== undefined &&
      rowOf(step('row-active')[0]) === PROBE_ROW,
    // Q1: and the raw provider is reachable, which hides the caller again.
    originalReached: one('original')?.reached === true,
    callerHiddenViaOriginal: served(one('resolve-via-original')) && bypassCall !== undefined,
    // Q2: the plugin saw an answer to a request it never made, in plain text.
    unaskedAnswerVisible: unaskedResult !== undefined,
    prependedListenerRunsFirst: one('ipc-listeners')?.oursFirst === true,
    nonceReadOffTheChannel: outbound.some((record) => Number(record.nonceLength) > 0),
    forgedRequestServed: forged?.answered === true && served(forged),
    // The host was unharmed by all of it.
    turnFinished: turn?.idle === true && requests.length > 0,
    cleanStop: stop.stopped && stop.exit.code === 0,
  };
  const pass = Object.values(checks).every(Boolean);
  const report = {
    experiment: 'E8',
    pass,
    checks,
    questions: {
      q1: {
        question: 'can aiclient-credentials tell who is calling?',
        callerIdentityAvailable: checks.providerSeesCallerRow,
        callers: providerCalls.map((record) => ({ ref: record.ref, caller: record.caller })),
        servedToThePluginToday: checks.planRefServedToThePlugin,
        bypassable: checks.callerHiddenViaOriginal,
      },
      q2: {
        question: 'can a plugin read the credential answers on the IPC channel?',
        answersSeen: credentialResults.length,
        unaskedAnswerSeen: checks.unaskedAnswerVisible,
        canPullByItself: checks.forgedRequestServed,
      },
    },
    host: {
      artifact: (ready?.artifact as Message | undefined)?.form,
      bundles: ready?.bundles,
      plugins: probeState,
      census: ready?.census,
      planRef,
      credentialRequestsMainAnswered: host.served.requests,
      gatewayRequests: requests.length,
      turn: turn
        ? { idle: turn.idle, tools: turn.tools, reply: turn.reply.slice(0, 120) }
        : undefined,
      stop,
      stderrTail: host.stderr().slice(-2000),
    },
    probe: { log: probeLog, canaryDigest, records },
    scratch: scratchRoot,
  };
  if (outFile) writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ experiment: 'E8', pass, checks }, null, 2)}\n`);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  process.exitCode = pass ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`[e8] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
