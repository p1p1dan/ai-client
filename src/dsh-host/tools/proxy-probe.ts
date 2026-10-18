/**
 * Decision 195 on a real DSH host: the product proxy Main hands over carries
 * the host's model requests (with its credentials, and nowhere else), a
 * change applies at once without a restart, a SOCKS proxy is refused and the
 * requests go direct, and the tools the model runs see the product proxy.
 *
 *   node src/dsh-host/tools/proxy-probe.ts [--out report.json] [--keep]
 *
 * Windows and Linux, on the Node that runs it (24+, as perm-pwsh-probe). Needs
 * `npm ci` in src/dsh-host. Not in CI: one real host (200-350 MB).
 *
 * One local fake gateway (plan dsh-p0-2) that the plan names
 * `gateway.invalid:<port>`: only the local test proxy (tools/lib/testProxy.ts)
 * resolves that name (to loopback), so a request that reaches the gateway was
 * proxied, whatever this machine does with a direct connection. One host,
 * whose environment carries no proxy variable, and one session; in order:
 *
 *   on        `configure` carries the test proxy with credentials: a P0-STREAM
 *             turn completes; every model request came through the proxy,
 *             authorised; the host logged `outbound proxy: on`
 *   tools     P1-ENVDUMP (bash `env`; P1-ENVDUMP-PWSH on Windows): the tool sees the product proxy in
 *             HTTPS_PROXY and NODE_USE_ENV_PROXY=1
 *   off       `{ host: 'proxy', proxy: null }`: the next turn's model requests
 *             do not reach the proxy (they go direct, which cannot reach
 *             `gateway.invalid`, so that turn fails)
 *   socks     a `socks5://` setting: the host warns, and the next turn's
 *             requests do not reach the proxy either
 *   on again  the proxy back, no restart: a turn completes through it
 *
 * and no stderr line, nor the report, carries the proxy password. Every model
 * request goes to the fake gateway; signals only ever go to children this
 * script spawned. Exit 0 when every check passes, 1 when one fails.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ExperimentHost,
  type ExperimentSession,
  gatewayRequests,
  openSession,
  readyOrFatal,
  sendTurn,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
  stopFakeGateway,
} from './lib/experiment-host.ts';
import { fakeGatewayPlan, type Message } from './lib/hostClient.ts';
import { sandbox } from './lib/kit.ts';
import { startTestProxy } from './lib/testProxy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const argv = process.argv.slice(2);
const outFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : '';
const keep = argv.includes('--keep');
const PASSWORD = `probe-${randomBytes(9).toString('hex')}`;
/** Names the host must not inherit from this shell: credentials, app knobs, and any proxy. */
const SCRUB = /KEY|PASSWORD|SECRET|TOKEN|^(DSH_|NARB_|AICLIENT_)|^(http|https|all|no)_proxy$/i;

interface Check {
  name: string;
  ok: boolean;
  detail?: unknown;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  process.stdout.write(`[check] ${ok ? 'PASS' : 'FAIL'} ${name}\n`);
}

function hostEnv(box: ReturnType<typeof sandbox>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SCRUB.test(name)) env[name] = value;
  }
  return {
    ...env,
    ...(process.platform === 'win32' ? {} : { HOME: box.home }),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
  };
}

function payloadOf(event: Message): Message {
  return (event.payload ?? {}) as Message;
}

/** What each tool of a turn printed. */
function toolOutputs(events: readonly Message[]): string[] {
  return events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => {
      const payload = payloadOf(event);
      return String(payload.output ?? payload.error ?? '');
    });
}

/** `NAME=value` lines of an `env` dump, as a record (the last spelling wins). */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

async function main(): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'aiclient-dsh-proxy-probe-'));
  const box = sandbox(root, 'host');
  const gateway = await startFakeGateway(process.execPath, join(here, 'fake-gateway.mjs'), root);
  const proxy = await startTestProxy({
    credentials: { username: 'pilab probe', password: PASSWORD },
  });
  const proxySetting = { url: proxy.urlWithCredentials, noProxy: 'localhost,127.0.0.1' };
  const gatewayHost = `gateway.invalid:${gateway.port}`;
  let host: ExperimentHost | undefined;
  const report: Record<string, unknown> = { gateway: gatewayHost, platform: process.platform };
  try {
    host = startExperimentHost({
      label: 'proxy',
      nodeBin: process.execPath,
      entry: join(hostDir, 'host.ts'),
      cwd: box.root,
      env: hostEnv(box),
      plan: fakeGatewayPlan({ baseUrl: `http://${gatewayHost}` }),
      key: 'proxy-probe-fake-key',
      configure: { proxy: proxySetting },
    });
    const ready = await readyOrFatal(host);
    check('the host boots with the proxy in configure', ready?.type === 'ready', ready?.message);
    if (ready?.type !== 'ready') return 1;
    const session: ExperimentSession = await openSession(host, {
      logicalSessionId: 'proxy-probe',
      cwd: box.workspace,
    });
    const viaProxy = () =>
      proxy.records.filter((record) => record.target === gatewayHost && record.kind === 'forward');
    const turn = (requestId: string, text: string) =>
      sendTurn(host as ExperimentHost, session, { requestId, text, timeoutMs: 150_000 });

    // on
    const on = await turn('on', 'P0-STREAM');
    const onRequests = viaProxy();
    check('on: the turn completes', on.idle && on.reply.length > 0, on.reply.slice(0, 80));
    check(
      'on: every model request came through the proxy, authorised',
      onRequests.length > 0 &&
        onRequests.every((record) => record.authorized && record.status === 200) &&
        onRequests.length === gatewayRequests(gateway.log).length,
      { proxied: onRequests.length, gateway: gatewayRequests(gateway.log).length }
    );
    check(
      'on: the host logged the proxy as on',
      host
        .stderrLines()
        .some((line) => /outbound proxy: on \(http proxy; \d+ bypass entries\)/.test(line))
    );

    // tools
    // DSH mounts `pwsh` on Windows and `bash` elsewhere.
    const tools = await turn(
      'tools',
      process.platform === 'win32' ? 'P1-ENVDUMP-PWSH' : 'P1-ENVDUMP'
    );
    const dump = parseEnv(toolOutputs(tools.events).join('\n'));
    if (Object.keys(dump).length === 0) {
      report.toolEvents = tools.events
        .filter((event) => String(event.type).startsWith('tool.'))
        .map((event) => JSON.stringify(event).replaceAll(PASSWORD, '[redacted]').slice(0, 1500));
    }
    report.toolProxyNames = Object.keys(dump)
      .filter((name) => /proxy/i.test(name))
      .sort();
    check(
      'tools: the shell tool sees the product proxy and NODE_USE_ENV_PROXY=1',
      (dump.HTTPS_PROXY ?? dump.https_proxy) === proxySetting.url &&
        dump.NODE_USE_ENV_PROXY === '1',
      { names: report.toolProxyNames, toolOutputs: toolOutputs(tools.events).length }
    );

    // off
    host.client.send({ host: 'proxy', proxy: null });
    const beforeOff = viaProxy().length;
    const off = await turn('off', 'P0-STREAM');
    check('off: no model request reaches the proxy', viaProxy().length === beforeOff, {
      proxied: viaProxy().length - beforeOff,
      idle: off.idle,
    });
    check(
      'off: the host logged the proxy as off',
      host.stderrLines().some((line) => line.includes('outbound proxy: off'))
    );

    // socks
    host.client.send({
      host: 'proxy',
      proxy: { url: `socks5://127.0.0.1:${proxy.port}`, noProxy: '' },
    });
    const beforeSocks = proxy.records.length;
    await turn('socks', 'P0-STREAM');
    check('socks: nothing reaches the proxy', proxy.records.length === beforeSocks, {
      records: proxy.records.length - beforeSocks,
    });
    check(
      'socks: the host warned that model requests go direct',
      host.stderrLines().some((line) => /outbound proxy: not used: .*SOCKS/.test(line))
    );

    // on again
    host.client.send({ host: 'proxy', proxy: proxySetting });
    const beforeAgain = viaProxy().length;
    const again = await turn('again', 'P0-STREAM');
    check(
      'on again: the turn completes through the proxy, without a restart',
      again.idle && again.reply.length > 0 && viaProxy().length > beforeAgain,
      { proxied: viaProxy().length - beforeAgain, pid: ready.pid }
    );

    const stderr = host.stderrLines().join('\n');
    check('no stderr line carries the proxy password', !stderr.includes(PASSWORD));
    report.proxyLines = host
      .stderrLines()
      .filter((line) => line.includes('outbound proxy'))
      .map((line) => line.replaceAll(PASSWORD, '[redacted]'));
    return checks.every((each) => each.ok) ? 0 : 1;
  } finally {
    if (host) report.stop = await stopExperimentHost(host);
    await stopFakeGateway(gateway);
    report.proxyRecords = proxy.records.length;
    await proxy.close();
    report.checks = checks;
    const raw = JSON.stringify(report, null, 2);
    if (raw.includes(PASSWORD)) {
      // A leak is a failure; the file still never holds the password.
      process.stdout.write('[check] FAIL the report carried the proxy password\n');
      process.exitCode = 1;
    }
    const text = raw.replaceAll(PASSWORD, '[redacted]');
    if (outFile) writeFileSync(outFile, `${text}\n`);
    if (keep) process.stdout.write(`kept ${root}\n`);
    else rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  // The report's own leak check (in `finally`) may have failed the run after `main` decided.
  (code) => process.exit(process.exitCode === 1 ? 1 : code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(1);
  }
);
