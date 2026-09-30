/**
 * dsh-rebase P1-13c real-host regression for the `aiclient-encrypted-read`
 * row (decision 091): proves, in the packaged host with the product bundle,
 * that the model-facing `read` tool really goes through the fallback.
 *
 *   (repo root) out-node-runtime/node src/dsh-host/tools/encrypted-read-smoke.ts \
 *       --host-dir out-dsh-host [--out report.json] [--real] [--keep] [--workspace dir]
 *
 * Every model request is answered by the local fake gateway (its P0-FS script
 * drives `read`, `edit`, `write`, `grep`, `glob` and the shell over the
 * workspace), the host is the packaged artifact with the product composition,
 * and the session runs over the same worker RPC Main uses.
 *
 * Fake mode (default): `cipher-not-editable.txt` carries the 16-byte
 * ciphertext marker over binary bytes, and `marker.txt` wears the marker over
 * readable text. PowerShell reads either back verbatim, so the first file's
 * expected outcome is the model seeing the clear FS_ENCRYPTED refusal — proof
 * the read went node → prefix check → PowerShell → refusal, never ciphertext —
 * and the second's is a completed edit plus a re-read carrying it, with the
 * file's own bytes back at the marker. The edit half of the encrypted path
 * (decision 135) is therefore exercised in both modes, while the policy's own
 * decryption needs a policy machine and is only real in --real.
 *
 * Real mode (--real): `marker.yml` is written BY Windows PowerShell 5.1 (the
 * process the policy decrypts for), then the tool waits for the policy to
 * encrypt it (P1-13b: about 260 s) before the turn. The expected outcome is
 * the marker's plaintext in the read result — the full fallback round trip on
 * a machine behind the policy — plus, since P1-13d, a real edit of that file
 * and a re-read that carries the edit. `--workspace` overrides where (default:
 * the user profile, not the sandboxed temp tree). Whether the policy then
 * re-encrypts the edited file is recorded, not required: node's own atomic
 * write is not re-encrypted on this machine within minutes, and the durable
 * check is that the edited plaintext is what reads back.
 *
 * Windows-safe by design: the scratch tree sits under os.tmpdir(), the host
 * entry and the probe hooks load through file:// URLs, and nothing reads
 * /proc or relies on POSIX paths. Signals only ever go to a ChildProcess this
 * script spawned; the fallback's PowerShell children are the row's own, killed
 * by the row itself.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDshHostEnvironment } from '../../main/services/agent-host/dshHostEnvironment.ts';
import { fakeGatewayPlan, serveModelPlan } from './lib/hostClient.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const isWindows = process.platform === 'win32';

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const hostDir = resolve(option('host-dir', 'out-dsh-host'));
const outFile = option('out', '');
const realMode = argv.includes('--real');
const keep = argv.includes('--keep');
const workspaceArg = option('workspace', '');
const nodeBin = resolve(
  option('node', join(repoRoot, 'out-node-runtime', isWindows ? 'node.exe' : 'node'))
);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const log = (message: string) => process.stderr.write(`[enc-smoke] ${message}\n`);

/** The 16-byte ciphertext marker, as node sees it on an encrypted file. */
const TSD_HEADER = Buffer.from('%TSD-Header-###%', 'latin1');

/** Set `name`, first dropping any spelling Windows would treat as the same variable. */
function setEnvVar(env: Record<string, string | undefined>, name: string, value: string): void {
  if (isWindows) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === name.toUpperCase()) delete env[key];
    }
  }
  env[name] = value;
}

/** The first bytes node can read of `path`; null when it cannot open the file. */
function nodePrefix(path: string, bytes: number): Buffer | null {
  try {
    return Buffer.from(readFileSync(path).subarray(0, bytes));
  } catch {
    return null;
  }
}

/** Write a file through Windows PowerShell 5.1 — the writer the policy trusts. */
function writeViaPowerShell(path: string, content: string): void {
  const exe = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  [System.IO.File]::WriteAllText($env:ENC_SMOKE_PATH, $env:ENC_SMOKE_CONTENT)',
    '  exit 0',
    '} catch {',
    '  [Console]::Error.Write($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\r\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const run = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, ENC_SMOKE_PATH: path, ENC_SMOKE_CONTENT: content },
    windowsHide: true,
  });
  if (run.status !== 0) {
    throw new Error(
      `powershell write failed (${run.status}): ${run.stderr?.toString('utf8').slice(0, 300)}`
    );
  }
}

interface HostProcess {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: string | null }>;
  stderr: () => string;
  started: number;
}

function startHost(
  env: Record<string, string | undefined>,
  plan: ReturnType<typeof fakeGatewayPlan>,
  key: string
): HostProcess {
  const child = spawn(
    nodeBin,
    ['--expose-internals', '--import', pathToFileURL(hooksEntry).href, join(hostDir, 'host.js')],
    { cwd: hostDir, env: { ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }
  );
  serveModelPlan(child, plan, key);
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-100_000);
  });
  child.stdout?.resume();
  const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
    child.once('exit', (code, signal) => done({ code, signal }))
  );
  return { child, exited, stderr: () => stderr, started: Date.now() };
}

function waitIpc(
  host: HostProcess,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs: number,
  what: string
): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      cleanup();
      fail(new Error(`host: timed out after ${timeoutMs} ms waiting for ${what}`));
    }, timeoutMs);
    const onMessage = (message: Record<string, unknown>) => {
      if (message?.type === 'fatal') {
        cleanup();
        fail(new Error(`host fatal: ${String(message.message)}`));
      } else if (predicate(message)) {
        cleanup();
        done(message);
      }
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      fail(new Error(`host exited (${code}, ${signal}) waiting for ${what}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      host.child.off('message', onMessage);
      host.child.off('exit', onExit);
    };
    host.child.on('message', onMessage);
    host.child.on('exit', onExit);
  });
}

interface RuntimeEvent {
  type: string;
  payload: Record<string, unknown>;
  requestId?: string;
}

/** One chat session: worker RPC inside `{ch, rpc}` envelopes of one channel. */
class WorkerClient {
  readonly events: RuntimeEvent[] = [];
  readonly arrivals: number[] = [];
  private readonly waiters = new Set<() => void>();
  private seq = 0;
  private readonly child: ChildProcess;
  private readonly ch: string;
  private readonly session: string;

  constructor(child: ChildProcess, ch: string, session: string) {
    this.child = child;
    this.ch = ch;
    this.session = session;
    child.on('message', (message: Record<string, unknown>) => {
      const rpc = message?.ch === this.ch ? (message.rpc as Record<string, unknown>) : undefined;
      if (rpc?.kind === 'event' && rpc.type === 'runtime.event') {
        const payload = rpc.payload as RuntimeEvent;
        this.events.push(payload);
        this.arrivals.push(performance.now());
        // As the packaged smoke does: the harness answers every permission
        // card, so the turn never blocks on an approval it cannot show.
        const inner = (payload.payload ?? {}) as Record<string, unknown>;
        if (payload.type === 'permission.requested' && inner.permissionId !== undefined) {
          void this.call('worker.permission.respond', {
            logicalSessionId: this.session,
            permissionId: inner.permissionId,
            decision: 'allow',
          });
        }
      }
      for (const wake of [...this.waiters]) wake();
    });
  }

  call(type: string, payload: Record<string, unknown>, timeoutMs = 120_000) {
    const requestId = `enc-smoke-${++this.seq}`;
    return new Promise<Record<string, unknown>>((done, fail) => {
      const timer = setTimeout(() => {
        this.child.off('message', onMessage);
        fail(new Error(`${type} timed out`));
      }, timeoutMs);
      const onMessage = (message: Record<string, unknown>) => {
        const rpc = message?.ch === this.ch ? (message.rpc as Record<string, unknown>) : undefined;
        if (rpc?.kind !== 'response' || rpc.requestId !== requestId) return;
        clearTimeout(timer);
        this.child.off('message', onMessage);
        done(rpc);
      };
      this.child.on('message', onMessage);
      this.child.send({
        ch: this.ch,
        rpc: { protocolVersion: 1, kind: 'request', generation: 1, requestId, type, payload },
      });
    });
  }

  until(predicate: (events: RuntimeEvent[]) => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate(this.events)) return Promise.resolve(true);
    return new Promise<boolean>((done) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        done(false);
      }, timeoutMs);
      const check = () => {
        if (!predicate(this.events)) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        done(true);
      };
      this.waiters.add(check);
    });
  }
}

const payloadOf = (event: RuntimeEvent): Record<string, unknown> => event.payload ?? {};

interface ToolOutcome {
  name: string;
  ok: boolean;
  text: string;
  ms: number | null;
}

/** Tool outcomes of the events collected since `from`, with per-tool wall time. */
function toolOutcomes(events: RuntimeEvent[], arrivals: number[], from: number): ToolOutcome[] {
  const slice = events.slice(from);
  const times = arrivals.slice(from);
  const names = new Map<string, string>();
  const startedAt = new Map<string, number>();
  const completedAt = new Map<string, number>();
  slice.forEach((event, index) => {
    const payload = payloadOf(event);
    const id = String(payload.toolCallId);
    if (event.type === 'tool.started') {
      names.set(id, String(payload.name));
      startedAt.set(id, times[index]);
    } else if (event.type === 'tool.completed') {
      completedAt.set(id, times[index]);
    }
  });
  return slice
    .filter((event) => event.type === 'tool.completed')
    .map((event) => {
      const payload = payloadOf(event);
      const id = String(payload.toolCallId);
      const started = startedAt.get(id);
      const completed = completedAt.get(id);
      return {
        name: names.get(id) ?? '?',
        ok: payload.ok === true,
        text: String(payload.output ?? payload.error ?? ''),
        ms:
          started !== undefined && completed !== undefined ? Math.round(completed - started) : null,
      };
    });
}

async function main(): Promise<void> {
  if (!existsSync(join(hostDir, 'host.js'))) {
    throw new Error(`no packaged host at ${hostDir}; run node scripts/build-dsh-host.mjs first`);
  }
  if (!existsSync(nodeBin)) throw new Error(`no node runtime at ${nodeBin}`);

  const stamp = `${Date.now()}`;
  const scratch = join(tmpdir(), `aiclient-enc-smoke-${stamp}`);
  const dirs = {
    home: join(scratch, 'home'),
    tmp: join(scratch, 'tmp'),
    appdata: join(scratch, 'appdata'),
    localappdata: join(scratch, 'localappdata'),
    dshHome: join(scratch, 'dsh-home'),
    narb: join(scratch, 'narb-cache'),
    hostCwd: join(scratch, 'host-cwd'),
    logs: join(scratch, 'logs'),
  };
  const workspace = realMode
    ? resolve(
        workspaceArg || join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'enc-smoke-ws')
      )
    : resolve(workspaceArg || join(scratch, 'workspace'));
  for (const dir of [...Object.values(dirs), workspace]) mkdirSync(dir, { recursive: true });

  // Main's environment rule (decision 022), with the profile moved into the
  // scratch tree first — the workspace stays outside it on purpose in --real.
  const inherited: Record<string, string | undefined> = { ...process.env };
  const sandboxed: Record<string, string> = {
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    ...(isWindows
      ? { USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata }
      : {}),
  };
  for (const [name, value] of Object.entries(sandboxed)) setEnvVar(inherited, name, value);
  const env = buildDshHostEnvironment({
    dshHome: dirs.dshHome,
    nativeCacheDir: dirs.narb,
    isPackaged: true,
    env: inherited,
  });
  const hookLog = join(dirs.logs, 'hooks.jsonl');
  Object.assign(env, { AICLIENT_PROBE_HOOK_LOG: hookLog });

  const checks: Record<string, unknown> = {};
  const report: Record<string, unknown> = {
    mode: realMode ? 'real' : 'fake',
    workspace,
    node: nodeBin,
    hostDir,
    checks,
  };

  // The marker the fake gateway's FS script reads, edits and greps for.
  const marker = `ENC-SMOKE-${stamp}`;
  const token = stamp.slice(-6);
  const markerName = realMode ? 'marker.yml' : 'marker.txt';

  if (realMode) {
    // Written by PowerShell, so the policy encrypts it (P1-13b procedure).
    writeViaPowerShell(
      join(workspace, markerName),
      `${marker} real encrypted content\nsecond line\n`
    );
    log('wrote marker.yml via PowerShell; waiting for the policy to encrypt it');
    const startedWaiting = Date.now();
    let polls = 0;
    const deadline = startedWaiting + 10 * 60_000;
    for (;;) {
      polls += 1;
      const prefix = nodePrefix(join(workspace, markerName), 16);
      if (prefix?.equals(TSD_HEADER)) break;
      if (Date.now() > deadline) {
        checks.policyEncrypted = false;
        throw new Error(
          'the policy did not encrypt marker.yml within 10 min; run with a --workspace the policy covers'
        );
      }
      await sleep(15_000);
    }
    checks.policyEncrypted = true;
    checks.policyWaitMs = Date.now() - startedWaiting;
    checks.policyPolls = polls;
    log(`policy encrypted ${markerName} after ${String(checks.policyWaitMs)} ms`);
  } else {
    // The synthetic ciphertext: the marker over a body no reader can mistake
    // for plaintext. PowerShell reads it back verbatim, so the fallback must
    // refuse it as still-ciphertext. Two files, because one covers each half
    // of the range (decision 135): a marker file PowerShell CAN decrypt — the
    // fake stands in for the policy here, since PowerShell reads a plain file
    // back verbatim — is edited end to end, and a marker file it cannot is
    // left alone with a refusal.
    writeFileSync(
      join(workspace, 'cipher-not-editable.txt'),
      Buffer.concat([TSD_HEADER, Buffer.from('fake ciphertext body \u0000 bytes', 'latin1')])
    );
    writeFileSync(join(workspace, markerName), `${marker} fake decryptable content\nsecond line\n`);
    writeFileSync(join(workspace, 'plain.txt'), `${marker} plaintext control\n`);
  }

  // The edit target stays plaintext in both modes: the turn must still work.
  writeFileSync(join(workspace, 'edit-target.txt'), `${marker} edit target\n`);

  // The local fake gateway answers every model request.
  const gateway = spawn(
    process.execPath,
    [
      gatewayEntry,
      '--port',
      '0',
      '--plan',
      'dsh-p0-2',
      '--reset',
      '--state',
      join(dirs.logs, 'gateway.state.json'),
      '--log',
      join(dirs.logs, 'gateway.jsonl'),
      '--model-id',
      'fake-1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  const gatewayPort = await new Promise<number>((done, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error('fake gateway did not start in 15 s')), 15_000);
    gateway.stdout?.setEncoding('utf8');
    gateway.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
    gateway.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`fake gateway exited early (${code})`));
    });
  });

  const plan = fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gatewayPort}` });
  const host = startHost(env, plan, 'enc-smoke-fake-key');
  const session = 'enc-smoke';
  const client = new WorkerClient(host.child, 'c1-1', session);

  try {
    await waitIpc(host, (m) => m?.type === 'ready', 180_000, 'ready');
    report.readyMs = Date.now() - host.started;

    const boot = await client.call(
      'worker.bootstrap',
      { logicalSessionId: session, cwd: workspace },
      180_000
    );
    if (boot.ok !== true) throw new Error(`worker.bootstrap: ${JSON.stringify(boot.error)}`);

    const prompt = `P0-FS ${JSON.stringify({
      tag: 'enc',
      dir: workspace,
      marker,
      token,
      shell: isWindows ? 'pwsh' : 'bash',
      markerName,
      // P1-13d: the script reads a file the fallback cannot decrypt (the
      // still-ciphertext refusal), then edits the marker file and re-reads it.
      ...(realMode ? {} : { refuseName: 'cipher-not-editable.txt' }),
      editInMarker: true,
    })}`;
    const turnStarted = performance.now();
    const eventsBefore = client.events.length;
    const sent = await client.call('worker.send', {
      logicalSessionId: session,
      requestId: 'turn-enc',
      attemptId: 'attempt-enc',
      text: prompt,
    });
    if (sent.ok !== true) throw new Error(`worker.send: ${JSON.stringify(sent.error)}`);
    const idle = await client.until(
      (events) =>
        events
          .slice(eventsBefore)
          .some(
            (e) =>
              e.type === 'session.status' &&
              e.requestId === 'turn-enc' &&
              payloadOf(e).status === 'idle'
          ),
      300_000
    );
    if (!idle) throw new Error('the turn did not go idle in 300 s');
    report.turnMs = Math.round(performance.now() - turnStarted);

    const tools = toolOutcomes(client.events, client.arrivals, eventsBefore);
    report.tools = tools.map((tool) => ({ ...tool, text: tool.text.slice(0, 400) }));

    // The judgement: the read of the encrypted marker behaved as decided.
    // The marker string also lives in the plaintext fixtures, so the checks
    // name what only the encrypted file's own bytes could produce.
    const reads = tools.filter((tool) => tool.name === 'read');
    const edits = tools.filter((tool) => tool.name === 'edit');
    const policyRefusals = reads.filter((tool) => /disk-encryption policy/.test(tool.text));
    checks.plaintextEditStillWorks = reads.some((tool) => tool.text.includes(`EDITED-${token}`));
    // P1-13d: the marker file's own edit, and the re-read that follows it.
    // `ENC-EDITED-<token>` exists nowhere else in the fixtures, so a read
    // result carrying it can only come from the edited marker file. This is
    // the encrypted-edit round trip in both modes: in --real the file is
    // policy-encrypted and the fallback really decrypts it; fake mode's marker
    // file is PowerShell-readable plaintext wearing the marker, which is the
    // same node-sees-the-marker shape (the policy's decryption itself needs
    // the machine, so only --real can pin that half).
    //
    // The edit's own result text names no path, so the marker edit is found by
    // order: the first edit after a successful read of the marker file.
    const markerReads = reads.filter((tool) => tool.text.includes(markerName));
    const markerEdit = markerReads.length > 0 ? edits[0] : undefined;
    const markerReread = reads.filter(
      (tool) => tool.ok && tool.text.includes(`ENC-EDITED-${token}`)
    );
    checks.markerEditAttempted = markerEdit !== undefined;
    checks.markerEditOk = markerEdit?.ok === true;
    checks.markerEditMs = markerEdit?.ms ?? null;
    checks.markerRereadSeesEdit = markerReread.length > 0;
    if (realMode) {
      // Only marker.yml carries this line: finding it in a read result is the
      // full fallback round trip on a policy-encrypted file.
      const markerRead = reads.find(
        (tool) => tool.ok && tool.text.includes('real encrypted content')
      );
      checks.markerReadAsPlaintext = markerRead !== undefined;
      checks.readDurationMs = markerRead?.ms ?? null;
      checks.noReadRefused = policyRefusals.length === 0;
      // The write-back went through the fs service. Whether the policy then
      // re-encrypts the file is the policy's business and is NOT required for
      // correctness: node's own write path (staging dir + rename, as
      // dsh-fs-local writes) is not re-encrypted on this machine within
      // minutes, so the durable, load-bearing check is that a node-side read
      // still yields the edited plaintext — which the re-read above pinned.
      // This records which state the file was left in, for the evidence.
      const reEncryptDeadline = Date.now() + 30_000;
      let reEncrypted = false;
      for (;;) {
        reEncrypted = nodePrefix(join(workspace, markerName), 16)?.equals(TSD_HEADER) === true;
        if (reEncrypted || Date.now() > reEncryptDeadline) break;
        await sleep(3000);
      }
      checks.markerReEncryptedAfterEdit = reEncrypted;
      checks.markerNodePrefix = nodePrefix(join(workspace, markerName), 16)
        ?.toString('latin1')
        .slice(0, 16);
      // And the plaintext is on disk, node-readable, exactly as read back.
      try {
        checks.markerOnDiskHasEdit = readFileSync(join(workspace, markerName), 'utf8').includes(
          `ENC-EDITED-${token}`
        );
      } catch {
        checks.markerOnDiskHasEdit = false;
      }
    } else {
      // A marker file the fallback cannot decrypt keeps the clear refusal and
      // is never edited: decision 135's out-of-range case.
      const refusal = policyRefusals.find((tool) => tool.text.includes('cipher-not-editable'));
      checks.uneditableRefused = refusal !== undefined;
      checks.uneditableRefusalMs = refusal?.ms ?? null;
      // The ciphertext body never reached the model through any read.
      checks.ciphertextNeverServed = !reads.some((tool) =>
        tool.text.includes('fake ciphertext body')
      );
    }

    // The probe hook log vouches for every spawn, PowerShell included.
    if (existsSync(hookLog)) {
      const hookLines = readFileSync(hookLog, 'utf8').split('\n').filter(Boolean);
      const powershellSpawns = hookLines.filter(
        (line) => line.includes('WindowsPowerShell') || line.includes('powershell.exe')
      );
      checks.powershellSpawns = powershellSpawns.length;
      checks.powershellSpawnSample = powershellSpawns[0]?.slice(0, 300) ?? null;
    }

    const stopped = waitIpc(host, (m) => m?.type === 'stopped', 30_000, 'stopped').catch(
      (error: unknown) => ({ error: String(error) })
    );
    host.child.send({ type: 'shutdown' });
    report.stopped = await stopped;
    report.hostStderrTail = host.stderr().slice(-2000);
  } finally {
    const exit = await Promise.race([host.exited, sleep(30_000).then(() => null)]);
    if (exit === null) host.child.kill('SIGKILL');
    gateway.kill();
    if (outFile !== '') {
      mkdirSync(dirname(resolve(outFile)), { recursive: true });
      writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
      log(`report: ${resolve(outFile)}`);
    }
    // Windows keeps scratch handles briefly after the children exit; a failed
    // cleanup must never mask the verdict, so it retries once and then leaves
    // the tree behind with a note.
    if (keep) {
      log(`scratch kept: ${scratch}`);
    } else {
      try {
        await sleep(1500);
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        try {
          await sleep(3000);
          rmSync(scratch, { recursive: true, force: true });
        } catch {
          log(`scratch could not be removed (handles still open): ${scratch}`);
        }
      }
    }
  }

  log(`checks: ${JSON.stringify(checks)}`);
  const pass = realMode
    ? checks.markerReadAsPlaintext === true &&
      checks.noReadRefused === true &&
      checks.markerEditOk === true &&
      checks.markerRereadSeesEdit === true &&
      checks.markerOnDiskHasEdit === true
    : checks.markerEditOk === true &&
      checks.markerRereadSeesEdit === true &&
      checks.uneditableRefused === true &&
      checks.ciphertextNeverServed === true;
  process.exit(pass ? 0 : 1);
}

await main();
