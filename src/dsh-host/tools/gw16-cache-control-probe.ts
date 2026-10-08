/**
 * GW-16 temporary switch (dsh-rebase decisions 146 rules 23-27, 149 rule 19,
 * 159): how many `cache_control` breakpoints a real host's anthropic-messages
 * requests carry with the switch off (the default) and on.
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/gw16-cache-control-probe.ts
 *      [--out file.json] [--keep])
 *
 * Not run in CI: it starts real hosts (200-350 MB each). Run it alone on the
 * dev box, with no Electron or Vitest run beside it; it refuses to start
 * below 800 MB available.
 *
 * One local fake gateway (plan dsh-p0-2), two checkout hosts one after the
 * other, each configured with a plan built by the product's own rules
 * (`fakeGatewayPlan`, one anthropic-messages route):
 *   off  the user's settings say nothing (the default): the route carries
 *        `compat.supportsCacheControlOnTools: false`
 *   on   `cacheControlOnTools: true`: no such compat, as before the switch
 * Each runs one P0-TOOL turn (a bash call, then text; bypass posture), so
 * every model request offers tools. The gateway's request log
 * (`cacheControl`, counts only) is split per host by `X-Pilab-Client`.
 * Expected: off = system 1 + messages 1 = 2 and tools 0 on every request;
 * on = 3 with tools 1 on every request that offers tools.
 *
 * Every model request goes to the fake gateway; signals only ever go to a
 * ChildProcess this script spawned. Remove this file with the switch.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DshModelPlan } from '../../shared/dshModelPlan/types.ts';
import {
  gatewayRequests,
  oneTurn,
  readyOrFatal,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
} from './lib/experiment-host.ts';
import { FAKE_ROUTE, fakeGatewayPlan, type Message } from './lib/hostClient.ts';
import { baseEnv, sandbox } from './lib/kit.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const nodeBin = join(repoRoot, 'out-node-runtime', 'node');
const argv = process.argv.slice(2);
const outFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : '';
const keep = argv.includes('--keep');
const scratchRoot = join('/var/tmp', `aiclient-dsh-gw16-${Date.now()}`);

type Mode = 'off' | 'on';

interface CacheControlCount {
  total: number;
  top: number;
  system: number;
  tools: number;
  messages: number;
}

function availableMb(): number {
  const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
  return match ? Math.round(Number(match[1]) / 1024) : Math.round(os.freemem() / 1048576);
}

function planFor(mode: Mode, port: number): DshModelPlan {
  return fakeGatewayPlan({
    baseUrl: `http://127.0.0.1:${port}`,
    clientVersion: `gw16-${mode}`,
    ...(mode === 'on' ? { settings: { cacheControlOnTools: true } } : {}),
  });
}

async function runHost(mode: Mode, port: number) {
  const box = sandbox(scratchRoot, mode);
  const cwd = join(box.root, 'host-cwd');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const plan = planFor(mode, port);
  const host = startExperimentHost({
    label: `gw16-${mode}`,
    nodeBin,
    entry: join(hostDir, 'host.ts'),
    cwd,
    env: { ...baseEnv(box), DSH_HOME: box.dshHome, DSH_TELEMETRY_DISABLED: '1' },
    plan,
    key: 'gw16-fake-key',
  });
  try {
    const ready = await readyOrFatal(host);
    const turn =
      ready?.type === 'ready'
        ? await oneTurn(host, {
            sessionId: `gw16-${mode}`,
            cwd: box.workspace,
            text: 'P0-TOOL: list the workspace.',
          })
        : undefined;
    const stop = await stopExperimentHost(host);
    return {
      ready: ready?.type === 'ready',
      fatal: ready?.type === 'fatal' ? ready.message : undefined,
      revision: plan.revision,
      routeCompat: plan.routes[FAKE_ROUTE]?.compat ?? null,
      turn,
      stop,
      stderrTail: host.stderr().slice(-2000),
    };
  } catch (error) {
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
    throw error;
  }
}

function countsFor(requests: Message[], mode: Mode) {
  return requests
    .filter((request) => request.clientHeader === `gw16-${mode}`)
    .map((request) => ({
      seq: request.seq,
      tools: typeof request.tools === 'number' ? request.tools : 0,
      cacheControl: (request.cacheControl ?? {
        total: 0,
        top: 0,
        system: 0,
        tools: 0,
        messages: 0,
      }) as CacheControlCount,
    }));
}

async function main() {
  const available = availableMb();
  if (available < 800) {
    throw new Error(`only ${available} MB available; the probe needs 800 MB (wait for other runs)`);
  }
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const gateway = await startFakeGateway(nodeBin, join(here, 'fake-gateway.mjs'), scratchRoot);
  const results: Partial<Record<Mode, Awaited<ReturnType<typeof runHost>>>> = {};
  try {
    results.off = await runHost('off', gateway.port);
    results.on = await runHost('on', gateway.port);
  } finally {
    gateway.child.kill();
  }
  const off = results.off as Awaited<ReturnType<typeof runHost>>;
  const on = results.on as Awaited<ReturnType<typeof runHost>>;
  const requests = gatewayRequests(gateway.log);
  const counts = { off: countsFor(requests, 'off'), on: countsFor(requests, 'on') };
  const withTools = (mode: Mode) => counts[mode].filter((row) => row.tools > 0);
  const turnOk = (run: typeof off) =>
    run.turn?.idle === true &&
    run.turn.tools.some((tool) => tool.name === 'bash' && tool.ok === true);
  const checks = {
    bothReady: off.ready && on.ready,
    toolTurns: turnOk(off) && turnOk(on),
    planOffSaysFalse: (off.routeCompat as Message | null)?.supportsCacheControlOnTools === false,
    planOnSaysNothing:
      (on.routeCompat as Message | null)?.supportsCacheControlOnTools === undefined,
    revisionsDiffer: off.revision !== on.revision,
    requestsOfferTools: withTools('off').length >= 2 && withTools('on').length >= 2,
    offIsTwo: withTools('off').every(
      (row) =>
        row.cacheControl.total === 2 &&
        row.cacheControl.system === 1 &&
        row.cacheControl.messages === 1 &&
        row.cacheControl.tools === 0
    ),
    offNeverAboveTwo: counts.off.every((row) => row.cacheControl.total <= 2),
    onIsThree: withTools('on').every(
      (row) =>
        row.cacheControl.total === 3 &&
        row.cacheControl.system === 1 &&
        row.cacheControl.messages === 1 &&
        row.cacheControl.tools === 1
    ),
    cleanStops:
      off.stop.stopped && on.stop.stopped && off.stop.exit.code === 0 && on.stop.exit.code === 0,
  };
  const pass = Object.values(checks).every(Boolean);
  const report = { probe: 'GW-16', pass, checks, counts, results, scratch: scratchRoot };
  if (outFile) writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ probe: 'GW-16', pass, checks, counts }, null, 2)}\n`);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  process.exitCode = pass ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`[gw16] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
