/**
 * S18 (dsh-rebase P1-6d; plan P1-6 shard 04 §5): the app's permission gate on
 * DSH's `pwsh` tool, through a real DSH host and the product bridge, driven as
 * Main's supervisor drives it (Node IPC, one channel per session).
 *
 *   node.exe src\dsh-host\tools\perm-pwsh-probe.ts --out <report.json>
 *            [--work <dir>] [--shell pwsh|bash] [--keep]
 *
 * Four cases, one session each, each in a workspace of its own:
 *
 *   card    S1  ask: two `Set-Content` writes; the first card allowed once
 *               (the file is written), the second denied (it is not)
 *   grants  S3  ask: `Write-Output` answered for the session, its reach named
 *               by the cmdlet; `echo` (the alias) runs without a card;
 *               `echo …; Remove-Item …` is asked (Remove-Item never was)
 *   deny    S4  bypass: the env file and `~\.ssh\id_rsa`, refused without a card;
 *               the env file's canary never reaches a tool result
 *   auto    S7  auto: `Write-Output $S18X > …` is asked, the card saying why
 *               (`askReason: unresolved`); `Write-Output s18 > …` is not
 *
 * and, for each workspace, its ACL before the session and after it are the
 * same (P0-4's F-off-acl: the DSH sandbox is off, decision 045, so nothing
 * may grant itself into the workspace).
 *
 * `--shell pwsh` is the default on Windows, the only place DSH mounts `pwsh`.
 * `--shell bash` runs the same cases with their bash twins (the dry run on
 * Linux, where the conclusions must be the same). Every model turn comes from
 * the local fake gateway (`P1-S18`); the probe hooks drop every non-loopback
 * connect of the host. Signals only ever go to a ChildProcess this script
 * spawned. Exit 0 when every check passes, 1 when one fails, 2 when the run
 * could not be set up.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeGatewayPlan, HostClient, type Message } from './lib/hostClient.ts';
import { captureStderr, exitOf, sleep } from './lib/kit.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostEntry = join(resolve(here, '..'), 'host.ts');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const hooksUrl = pathToFileURL(join(here, 'lib', 'probe-hooks.mjs')).href;
const isWindows = process.platform === 'win32';
const MIN_AVAILABLE_MB = 800;
const TURN_TIMEOUT_MS = 150_000;
const ENV_CANARY = `S18-CANARY-${randomBytes(4).toString('hex')}`;

// ---- arguments -----------------------------------------------------------------

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const outOption = option('out');
if (!outOption) {
  process.stderr.write('[s18] --out <report.json> is required\n');
  process.exit(2);
}
const outFile = resolve(outOption);
const shell = (option('shell') ?? (isWindows ? 'pwsh' : 'bash')) as 'pwsh' | 'bash';
if (shell !== 'pwsh' && shell !== 'bash') {
  process.stderr.write('[s18] --shell must be pwsh or bash\n');
  process.exit(2);
}
const keep = argv.includes('--keep');
const workOption = option('work');
const work = workOption ? resolve(workOption) : mkdtempSync(join(tmpdir(), 'aiclient-s18-'));
mkdirSync(work, { recursive: true });

const log = (message: string) => process.stderr.write(`[s18] ${message}\n`);

// ---- report ----------------------------------------------------------------------

type Status = 'pass' | 'fail';
interface Check {
  id: string;
  title: string;
  status: Status;
  observed: string;
}
const checks: Check[] = [];
const cases: Record<string, unknown> = {};
function check(id: string, title: string, ok: boolean, observed: unknown) {
  const text = typeof observed === 'string' ? observed : JSON.stringify(observed);
  checks.push({ id, title, status: ok ? 'pass' : 'fail', observed: text.slice(0, 600) });
  log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}: ${text.slice(0, 200)}`);
}

// ---- environment ---------------------------------------------------------------

/** Linux dry run: refuse to start a host on a starved box (the dev box has 3.3 GB). */
function availableMb(): number {
  try {
    const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
    return match ? Number(match[1]) / 1024 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const SCRUB = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/**
 * The user's environment minus credentials and DSH / app knobs, plus ours.
 * Windows keeps its own profile variables (pwsh needs them); the dry run gets
 * a scratch HOME, so `~/.ssh` names nothing real even though it is refused
 * before anything opens it.
 */
function hostEnv(dshHome: string, scratchHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(DSH_|NARB_|AICLIENT_)/i.test(key) || SCRUB.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    ...(isWindows ? {} : { HOME: scratchHome }),
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_PROBE_HOOK_LOG: join(work, 'hooks.jsonl'),
  };
}

/** The workspace's access control, to compare before and after a session. */
function aclOf(dir: string): string {
  if (!isWindows) {
    const stat = statSync(dir);
    return `mode=${stat.mode.toString(8)} uid=${stat.uid} gid=${stat.gid}`;
  }
  const literal = dir.replaceAll("'", "''");
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${literal}').Sddl`],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
  );
  return (result.stdout ?? '').trim() || `error: ${(result.stderr ?? '').trim().slice(0, 200)}`;
}

// ---- gateway and host -------------------------------------------------------------

async function startGateway(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(
    process.execPath,
    [
      gatewayEntry,
      '--port',
      '0',
      '--plan',
      'dsh-p0-2',
      '--reset',
      '--state',
      join(work, 'gateway.state.json'),
      '--log',
      join(work, 'gateway.jsonl'),
      '--model-id',
      'fake-1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  const port = await new Promise<number>((done, fail) => {
    let text = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) done(Number(match[1]));
    });
    child.once('exit', (code) => fail(new Error(`fake gateway exited early (${code})`)));
    setTimeout(() => fail(new Error('fake gateway did not start in 15 s')), 15_000);
  });
  return { child, port };
}

interface Host {
  child: ChildProcess;
  client: HostClient;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

async function startHost(port: number): Promise<Host> {
  const dshHome = join(work, 'dsh-home');
  const hostCwd = join(work, 'host-cwd');
  const scratchHome = join(work, 'home');
  for (const dir of [dshHome, hostCwd, scratchHome]) mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ['--expose-internals', '--import', hooksUrl, hostEntry], {
    cwd: hostCwd,
    env: hostEnv(dshHome, scratchHome),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const host: Host = {
    child,
    client: new HostClient(child, { requestPrefix: 's18' }),
    stderr: captureStderr(child),
    exited: exitOf(child),
  };
  host.client.configure(fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${port}` }), 's18-fake-key');
  const ready = await host.client.control(
    (message) => message.type === 'ready' || message.type === 'fatal',
    180_000
  );
  if (ready?.type !== 'ready')
    throw new Error(`host not ready: ${JSON.stringify(ready)} ${host.stderr().slice(-1500)}`);
  return host;
}

async function stopHost(host: Host): Promise<{ code: number | null; signal: string | null }> {
  if (host.child.exitCode === null && host.child.signalCode === null) {
    if (host.child.connected) host.client.send({ type: 'shutdown' });
    await Promise.race([host.exited, sleep(20_000)]);
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill();
  }
  return host.exited;
}

// ---- one case ------------------------------------------------------------------------

const payloadOf = (event: Message): Message => (event.payload ?? {}) as Message;

interface CaseRun {
  cards: Message[];
  tools: Message[];
  idle: boolean;
  aclBefore: string;
  aclAfter: string;
  workspace: string;
}

async function runCase(
  host: Host,
  name: string,
  permissions: { mode: 'agent'; gear: 'ask' | 'auto' | 'bypass' },
  decide: (card: Message, index: number) => string,
  files: Record<string, string> = {}
): Promise<CaseRun> {
  const workspace = join(work, `ws-${name}`);
  mkdirSync(workspace, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(workspace, file), text);
  const canonical = realpathSync(workspace);
  const aclBefore = aclOf(canonical);
  const { client } = host;
  const ch = client.openChannel();
  const logicalSessionId = `s18-${name}`;
  await client.request(
    ch,
    'worker.bootstrap',
    { logicalSessionId, cwd: canonical, permissions },
    120_000
  );
  const requestId = `turn-${name}`;
  await client.request(ch, 'worker.send', {
    logicalSessionId,
    requestId,
    attemptId: `attempt-${name}`,
    text: `P1-S18 ${JSON.stringify({ case: name, shell })} run the steps.`,
  });
  const isIdle = (events: Message[]) =>
    events.some(
      (event) =>
        event.type === 'session.status' &&
        payloadOf(event).status === 'idle' &&
        event.requestId === requestId
    );
  const answered = new Set<unknown>();
  const cards: Message[] = [];
  let idle = false;
  for (;;) {
    const woke = await client.until(
      ch,
      (events) =>
        isIdle(events) ||
        events.some(
          (event) =>
            event.type === 'permission.requested' && !answered.has(payloadOf(event).permissionId)
        ),
      TURN_TIMEOUT_MS
    );
    for (const event of client.events(ch)) {
      if (event.type !== 'permission.requested') continue;
      const card = payloadOf(event);
      if (answered.has(card.permissionId)) continue;
      answered.add(card.permissionId);
      const decision = decide(card, cards.length);
      cards.push({ ...card, answered: decision });
      await client.request(ch, 'worker.permission.respond', {
        logicalSessionId,
        permissionId: card.permissionId,
        decision,
      });
    }
    idle = isIdle(client.events(ch));
    if (idle || !woke) break;
  }
  const tools = client
    .events(ch)
    .filter((event) => event.type === 'tool.completed')
    .map((event) => payloadOf(event));
  await client.request(ch, 'worker.dispose', { reason: 'slot-dispose' }).catch(() => undefined);
  const run = { cards, tools, idle, aclBefore, aclAfter: aclOf(canonical), workspace: canonical };
  cases[name] = {
    idle,
    cards: cards.map((card) => ({
      toolName: card.toolName,
      kind: card.kind,
      action: card.action,
      command: (card.input as Message | undefined)?.command,
      sessionGrantScope: card.sessionGrantScope,
      askReason: card.askReason,
      answered: card.answered,
    })),
    tools: tools.map((tool) => ({
      ok: tool.ok,
      error: String(tool.error ?? '').slice(0, 300),
      output: JSON.stringify(tool.output ?? '').slice(0, 300),
    })),
    acl: { before: aclBefore, after: run.aclAfter },
  };
  return run;
}

/**
 * A file's text, read as UTF-8 or, failing that, UTF-16LE: Windows
 * PowerShell 5.1 (the standard-user lane, pwsh 7 hidden) writes `>` as
 * UTF-16LE, pwsh 7 and bash as UTF-8.
 */
const readText = (file: string): string | null => {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return null;
  }
  const utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  return utf16 ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
};
const ok = (tool: Message | undefined) => tool?.ok === true;
const refused = (tool: Message | undefined, pattern: RegExp) =>
  tool?.ok === false && pattern.test(String(tool.error ?? ''));

// ---- main ----------------------------------------------------------------------------

async function main(): Promise<number> {
  if (!isWindows && availableMb() < MIN_AVAILABLE_MB) {
    log(
      `only ${Math.round(availableMb())} MB available (< ${MIN_AVAILABLE_MB}); not starting a host`
    );
    return 2;
  }
  if (!existsSync(join(resolve(here, '..'), 'node_modules', '@deepseek-ai'))) {
    log('src/dsh-host/node_modules is missing: run `npm ci` in src/dsh-host first');
    return 2;
  }
  log(`shell ${shell}, work ${work}`);
  const report: Message = {
    probe: 'dsh-rebase P1-6d S18',
    startedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    execPath: process.execPath,
    shell,
    work,
    checks,
    cases,
  };
  let gateway: { child: ChildProcess; port: number } | undefined;
  let host: Host | undefined;
  let setupFailed = false;
  try {
    gateway = await startGateway();
    host = await startHost(gateway.port);
    check('S18-host', 'the host reports ready', true, 'ready');

    // S1: two writes through the shell, the first card allowed, the second denied.
    const card = await runCase(host, 'card', { mode: 'agent', gear: 'ask' }, (_card, index) =>
      index === 0 ? 'allow' : 'deny'
    );
    check(
      'S18-S1-card',
      'ask: each shell write raises a card naming the shell, no reason line',
      card.idle &&
        card.cards.length === 2 &&
        card.cards.every(
          (c) =>
            c.toolName === shell &&
            c.kind === 'exec' &&
            c.action === 'run_command' &&
            c.askReason === undefined
        ),
      cases.card
    );
    check(
      'S18-S1-allow',
      'allowed once: the first file is written',
      ok(card.tools[0]) &&
        (readText(join(card.workspace, 's18-allowed.txt')) ?? '').includes('first'),
      { tool: card.tools[0], file: readText(join(card.workspace, 's18-allowed.txt')) }
    );
    check(
      'S18-S1-deny',
      'denied: the second file is not written',
      card.tools[1]?.ok === false && !existsSync(join(card.workspace, 's18-denied.txt')),
      { tool: card.tools[1], exists: existsSync(join(card.workspace, 's18-denied.txt')) }
    );

    // S3: a grant for the session covers the alias; a command never granted asks.
    const grants = await runCase(host, 'grants', { mode: 'agent', gear: 'ask' }, (_card, index) =>
      index === 0 ? 'allow_session' : 'deny'
    );
    const grantPrefix = shell === 'pwsh' ? 'Write-Output' : 'echo';
    check(
      'S18-S3-scope',
      `"Allow for session" names its reach by the normalized prefix (${grantPrefix})`,
      (grants.cards[0]?.sessionGrantScope as Message | undefined)?.kind === 'command' &&
        (grants.cards[0]?.sessionGrantScope as Message | undefined)?.value === grantPrefix,
      grants.cards[0]?.sessionGrantScope
    );
    check(
      'S18-S3-grant',
      'the second echo (by its alias on pwsh) runs without a card; the Remove-Item line is asked',
      grants.idle &&
        grants.cards.length === 2 &&
        grants.tools.length === 3 &&
        ok(grants.tools[0]) &&
        ok(grants.tools[1]) &&
        grants.tools[2]?.ok === false &&
        /Remove-Item|rm -f/.test(String((grants.cards[1]?.input as Message | undefined)?.command)),
      cases.grants
    );

    // S4: secrets refused before anything runs, and without a card.
    const deny = await runCase(host, 'deny', { mode: 'agent', gear: 'bypass' }, () => 'deny', {
      '.env': `S18_CANARY=${ENV_CANARY}\n`,
    });
    check(
      'S18-S4-deny',
      'bypass: the env file and a private key are refused without a card',
      deny.idle &&
        deny.cards.length === 0 &&
        deny.tools.length === 2 &&
        refused(deny.tools[0], /denied: .*\.env$/) &&
        refused(deny.tools[1], /denied: .*id_rsa$/),
      cases.deny
    );
    check(
      'S18-S4-leak',
      'the env file canary never reaches a tool result',
      !JSON.stringify(deny.tools).includes(ENV_CANARY),
      { canaryInResults: JSON.stringify(deny.tools).includes(ENV_CANARY) }
    );

    // S7: auto asks only about what it cannot read, and says so.
    const auto = await runCase(host, 'auto', { mode: 'agent', gear: 'auto' }, () => 'allow');
    check(
      'S18-S7-auto',
      'auto: the variable asks with askReason unresolved, the plain word runs without a card',
      auto.idle &&
        auto.cards.length === 1 &&
        auto.cards[0]?.askReason === 'unresolved' &&
        /\$S18X/.test(String((auto.cards[0]?.input as Message | undefined)?.command)) &&
        auto.tools.length === 2 &&
        ok(auto.tools[0]) &&
        ok(auto.tools[1]) &&
        (readText(join(auto.workspace, 's18-plain.txt')) ?? '').includes('s18'),
      { ...(cases.auto as Message), plain: readText(join(auto.workspace, 's18-plain.txt')) }
    );

    for (const [name, run] of Object.entries({ card, grants, deny, auto }))
      check(
        `S18-ACL-${name}`,
        `the ${name} workspace's ACL is unchanged (F-off-acl)`,
        run.aclBefore === run.aclAfter && !run.aclBefore.startsWith('error:'),
        { before: run.aclBefore, after: run.aclAfter }
      );
  } catch (error) {
    setupFailed = checks.length === 0;
    check(
      'S18-run',
      'the run completed',
      false,
      error instanceof Error ? error.message : String(error)
    );
    if (host) log(`host stderr tail:\n${host.stderr().slice(-2000)}`);
  } finally {
    if (host) {
      const exit = await stopHost(host);
      report.hostExit = exit;
      check('S18-shutdown', 'the host stops on shutdown with exit 0', exit.code === 0, exit);
    }
    gateway?.child.kill();
    report.finishedAt = new Date().toISOString();
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
    if (!keep && !workOption) rmSync(work, { recursive: true, force: true });
  }
  const failed = checks.filter((item) => item.status === 'fail');
  log(`${checks.length - failed.length}/${checks.length} checks passed; report ${outFile}`);
  if (setupFailed) return 2;
  return failed.length > 0 ? 1 : 0;
}

process.exitCode = await main();
