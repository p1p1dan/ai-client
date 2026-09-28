/**
 * dsh-rebase P1-4c2 pre-work experiment (rescope §8 item 2; decisions 096 and
 * 097), against a real DSH host (source checkout) and the local fake gateway:
 *
 *   out-node-runtime/node src/dsh-host/tools/attachment-experiments.ts [--keep] [--out report.json]
 *
 * Every session is the product bridge's own, opened on a channel with
 * worker.bootstrap as Main opens it. The attachments go in through a test-only
 * row (tools/lib/attachment-experiment-row.mjs) that calls DSH's own
 * `ctx.attachments` and follows a user message up on the bridge's agent, so the
 * experiment does not depend on the bridge carrying attachments. DSH_HOME sits
 * where the product puts it, under `~/.pilab/<profile>/dsh-home` of the host's
 * HOME, so the bundled policy's `~/.pilab/*` rule applies as it does for users.
 *
 *   E1  admitPromptContent: a small PNG admitted (the reference's shape); the
 *       refusals — a side over 8192 px, bytes that are not the declared type,
 *       a type DSH does not take, non-canonical base64 — with their error
 *       shape; a batch with one bad member stores nothing; file blocks pass
 *   E2  saveFile: where the file lands, the path the model is told, its mode
 *   E3  bypass: the model reads the handle's path with `read` (sandbox off)
 *   E4  ask: the same read raises no approval card (a trusted path)
 *   E5  ask: an attached `secrets.env` is refused by the bundled deny rule,
 *       without a card
 *   E6  ask, an image-capable model: the image reaches the model as an image
 *       block, and `read_image` of the normalized copy raises no card
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
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FAKE_MODEL,
  FAKE_ROUTE,
  fakeGatewayPlan,
  HostClient,
  isRecord,
  type Message,
} from './lib/hostClient.ts';
import { baseEnv, captureStderr, exitOf, type Sandbox, sleep } from './lib/kit.ts';
import { solidPng } from './lib/png.ts';
import { installProbeBundle, probeBundleSource } from './lib/probe-bundle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const rowSource = join(here, 'lib', 'attachment-experiment-row.mjs');
const MIN_AVAILABLE_MB = 900;
const keep = process.argv.includes('--keep');
const outIndex = process.argv.indexOf('--out');
const outFile = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;

const BYPASS = { mode: 'agent', gear: 'bypass' } as const;
const ASK = { mode: 'agent', gear: 'ask' } as const;
const VISION_MODEL = 'fake-vision';

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
  copyFileSync(rowSource, join(dir, 'lib', 'attachment-experiment.js'));
  const manifestFile = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    exports: Record<string, string>;
  };
  manifest.exports['./attachment-experiment'] = './lib/attachment-experiment.js';
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  // The patch file ends inside its `insert:` list.
  appendFileSync(
    join(dir, 'cordis.patch.yml'),
    "\n    - id: aiclient-attachment-experiment\n      name: '@aiclient/dsh-probe/attachment-experiment'\n"
  );
  return dir;
}

async function startGateway(root: string, nodeBin: string) {
  const child = spawn(
    nodeBin,
    [gatewayEntry, '--port', '0', '--plan', 'dsh-p0-2', '--reset'].concat([
      '--state',
      join(root, 'gateway.state.json'),
      '--log',
      join(root, 'gateway.jsonl'),
      '--model-id',
      FAKE_MODEL,
    ]),
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const port = await new Promise<number>((done, fail) => {
    let text = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) done(Number(match[1]));
    });
    setTimeout(() => fail(new Error('fake gateway did not start')), 15_000);
  });
  child.stderr?.resume();
  return { child, port };
}

/** The experiment row's ops over the host's IPC channel. */
class Row {
  private seq = 0;
  private readonly replies: Message[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly child: ChildProcess;
  constructor(child: ChildProcess) {
    this.child = child;
    child.on('message', (message: unknown) => {
      if (!isRecord(message) || typeof message.rx42Reply !== 'string') return;
      this.replies.push(message);
      for (const wake of [...this.waiters]) wake();
    });
  }

  async op(op: string, payload: Message = {}, timeoutMs = 120_000): Promise<Message> {
    const requestId = `rx42-${++this.seq}`;
    this.child.send({ rx42: op, requestId, ...payload });
    const find = () => this.replies.find((item) => item.requestId === requestId);
    const reply =
      find() ??
      (await new Promise<Message | undefined>((done) => {
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          done(undefined);
        }, timeoutMs);
        const wake = () => {
          const value = find();
          if (!value) return;
          clearTimeout(timer);
          this.waiters.delete(wake);
          done(value);
        };
        this.waiters.add(wake);
      }));
    if (!reply) throw new Error(`${op} timed out`);
    if (reply.error) throw new Error(`${op}: ${String(reply.error)}`);
    const { rx42Reply: _op, requestId: _id, ...rest } = reply;
    return rest;
  }
}

const b64 = (bytes: Buffer) => bytes.toString('base64');
const payloadOf = (event: Message) => (event.payload ?? {}) as Message;

/** What a turn showed on the channel: the cards, the tool rows, the reply. */
function turnFacts(events: readonly Message[]) {
  const names = new Map<unknown, unknown>();
  for (const event of events) {
    if (event.type === 'tool.started') {
      const payload = payloadOf(event);
      names.set(payload.toolCallId, payload.name ?? payload.toolName);
    }
  }
  const assistant = new Set(
    events
      .filter((event) => event.type === 'message.started' && payloadOf(event).role === 'assistant')
      .map((event) => payloadOf(event).messageId)
  );
  return {
    cards: events
      .filter((event) => event.type === 'permission.requested')
      .map((event) => {
        const payload = payloadOf(event);
        return {
          toolName: payload.toolName,
          title: payload.title,
          reason: payload.reason,
          path: payload.path,
          input: payload.input,
        };
      }),
    tools: events
      .filter((event) => event.type === 'tool.completed')
      .map((event) => {
        const payload = payloadOf(event);
        const output = payload.output ?? payload.result ?? payload.error ?? '';
        return {
          name: names.get(payload.toolCallId),
          ok: payload.ok,
          output: (typeof output === 'string' ? output : JSON.stringify(output)).slice(0, 300),
        };
      }),
    reply: events
      .filter(
        (event) => event.type === 'message.delta' && assistant.has(payloadOf(event).messageId)
      )
      .map((event) => String(payloadOf(event).text ?? ''))
      .join(''),
  };
}

async function main(): Promise<number> {
  const available = availableMb();
  if (available < MIN_AVAILABLE_MB) {
    process.stderr.write(
      `[rx42] only ${Math.round(available)} MB available (< ${MIN_AVAILABLE_MB}); not starting a host\n`
    );
    return 2;
  }
  const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
  const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;
  const scratchRoot = join('/var/tmp', `aiclient-dsh-p1-4c2-exp-${randomBytes(6).toString('hex')}`);
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const root = join(scratchRoot, 'run');
  const home = join(root, 'home');
  // Where Main puts it for users: `~/.pilab/<profile>/dsh-home` (decision 008).
  const dshHome = join(home, '.pilab', 'aiclient', 'dsh-home');
  const box: Sandbox = {
    root,
    home,
    tmp: join(root, 'tmp'),
    dshHome,
    workspace: join(root, 'workspace'),
    hookLog: join(root, 'hooks.jsonl'),
  };
  for (const dir of [box.home, box.tmp, box.dshHome, box.workspace])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hostCwd = join(box.root, 'host-cwd');
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  installProbeBundle(box.dshHome, experimentBundle(scratchRoot));
  const gateway = await startGateway(box.root, nodeBin);
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    // The probe bundle's auto-approving row would answer the bridge's approvals.
    AICLIENT_DSH_PROBE_ROW: '0',
  };
  const child = spawn(nodeBin, ['--expose-internals', '--import', hooksEntry, hostEntry], {
    cwd: hostCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const client = new HostClient(child, { requestPrefix: 'rx42' });
  client.configure(
    fakeGatewayPlan({
      routes: [
        {
          provider: FAKE_ROUTE,
          baseUrl: `http://127.0.0.1:${gateway.port}`,
          models: [
            { id: FAKE_MODEL, name: 'P0 fake model', contextWindow: 200_000, maxTokens: 8192 },
            {
              id: VISION_MODEL,
              name: 'P1-4c2 fake vision model',
              contextWindow: 200_000,
              maxTokens: 8192,
              input: ['text', 'image'],
            },
          ],
        },
      ],
    }),
    'p1-4c2-key'
  );
  const stderr = captureStderr(child);
  const exited = exitOf(child);
  const row = new Row(child);
  const report: Message = {};
  const verdict: Record<string, boolean> = {};
  let failed = false;

  const open = async (name: string, permissions: Message, model?: string) => {
    const ch = client.openChannel();
    const logicalSessionId = `x42-${name}`;
    const boot = await client.request(ch, 'worker.bootstrap', {
      logicalSessionId,
      cwd: box.workspace,
      permissions,
      ...(model ? { model } : {}),
    });
    return { ch, logicalSessionId, dsh: String(boot.piSessionId) };
  };
  type Open = Awaited<ReturnType<typeof open>>;
  const close = (s: Open) =>
    client.request(s.ch, 'worker.dispose', { reason: 'slot-dispose' }).catch(() => undefined);
  /**
   * Follows `text` + `attachments` up on the session's agent and waits for the
   * turn to end, denying every card that comes up so the turn cannot hang.
   */
  const run = async (s: Open, text: string, attachments: Message[]) => {
    const from = client.events(s.ch).length;
    const sent = await row.op('send', { sessionId: s.dsh, text, attachments });
    const answered = new Set<unknown>();
    for (;;) {
      const pending = client
        .events(s.ch)
        .slice(from)
        .filter(
          (event) =>
            event.type === 'permission.requested' && !answered.has(payloadOf(event).permissionId)
        );
      for (const card of pending) {
        const permissionId = payloadOf(card).permissionId;
        answered.add(permissionId);
        await client.request(s.ch, 'worker.permission.respond', {
          logicalSessionId: s.logicalSessionId,
          permissionId,
          decision: 'deny',
        });
      }
      const turns = await row.op('turns', { sessionId: s.dsh, ends: 1, timeoutMs: 300 });
      if (!turns.timedOut) break;
    }
    return { sent, ...turnFacts(client.events(s.ch).slice(from)) };
  };
  const underAttachments = (path: unknown) =>
    typeof path === 'string' &&
    !relative(join(box.dshHome, 'attachments', 'v1'), path).startsWith('..');

  try {
    const ready = await client.control(
      (message) => message.type === 'ready' || message.type === 'fatal',
      180_000
    );
    if (ready?.type !== 'ready') throw new Error(`no ready: ${stderr().slice(-800)}`);

    // ---- E1: admitPromptContent, admitted and refused ------------------------------------
    {
      const image = (bytes: Buffer, mediaType: string, name: string, data = b64(bytes)) => ({
        type: 'image',
        mediaType,
        data,
        name,
      });
      const text = { type: 'text', text: 'look' };
      const small = solidPng(2, 2);
      const admitted = await row.op('admit', {
        parts: [text, image(small, 'image/png', 'dot.png')],
      });
      const cases: Record<string, Message> = {
        tooWide: await row.op('admit', {
          parts: [text, image(solidPng(8193, 1), 'image/png', 'wide.png')],
        }),
        typeMismatch: await row.op('admit', {
          parts: [text, image(solidPng(2, 2, [10, 200, 10]), 'image/jpeg', 'fake.jpg')],
        }),
        unsupportedType: await row.op('admit', {
          parts: [text, image(small, 'image/bmp', 'dot.bmp')],
        }),
        badBase64: await row.op('admit', {
          parts: [text, image(small, 'image/png', 'dot.png', `${b64(small)}\n`)],
        }),
        badSecondOfTwo: await row.op('admit', {
          parts: [
            text,
            image(solidPng(3, 3, [1, 2, 3]), 'image/png', 'first.png'),
            image(solidPng(8193, 1, [4, 5, 6]), 'image/png', 'second.png'),
          ],
        }),
      };
      const saved = await row.op('save-file', { name: 'passthrough.txt', text: 'passthrough\n' });
      const fileOnly = await row.op('admit', {
        parts: [text, { type: 'file', attachment: saved.ref }],
      });
      report.E1 = { admitted, refused: cases, fileOnly };
      const refusalOf = (result: Message) => (result.refusal ?? {}) as Message;
      verdict.E1_admittedImageRef =
        admitted.ok === true &&
        isRecord((admitted.parts as Message[])[1]?.attachment) &&
        (admitted.parts as Message[])[1]?.type === 'image';
      verdict.E1_refusalsCarryStableCodes = Object.values(cases).every(
        (result) =>
          result.ok === false &&
          typeof refusalOf(result).code === 'string' &&
          refusalOf(result).isAttachmentError === true
      );
      verdict.E1_failedBatchStoresNothing =
        cases.badSecondOfTwo.objectsBefore === cases.badSecondOfTwo.objectsAfter;
      verdict.E1_fileBlocksPassThrough =
        fileOnly.ok === true &&
        JSON.stringify((fileOnly.parts as Message[])[1]) ===
          JSON.stringify({ type: 'file', attachment: saved.ref });
    }

    // ---- E2: where a saved file lands, and what the model is told -------------------------
    const saved = await row.op('save-file', {
      name: 'notes.txt',
      text: 'FILE-MARKER-E2 first line\nsecond line\n',
    });
    report.E2 = saved;
    verdict.E2_underAttachmentsV1Files =
      underAttachments(saved.hostPath) &&
      String(saved.hostPath).includes(`${join('attachments', 'v1', 'files')}`);
    verdict.E2_processPathIsHostPath = saved.processPath === saved.hostPath;
    verdict.E2_handleNamesThePath =
      typeof saved.handle === 'string' &&
      saved.handle.includes(JSON.stringify(String(saved.processPath)));

    const fileBlock = async (name: string, marker: string) => {
      const file = await row.op('save-file', {
        name,
        text: `${marker} is the only line that matters\n`,
      });
      return { type: 'file', attachment: file.ref };
    };

    // ---- E3: bypass, the model reads the handle's path ---------------------------------------
    {
      const s = await open('e3', BYPASS);
      const facts = await run(s, 'P1-FILEREAD: read the attached file. (E3)', [
        await fileBlock('e3.txt', 'FILE-MARKER-E3'),
      ]);
      report.E3 = facts;
      verdict.E3_readSucceeded =
        facts.tools.length === 1 && facts.tools[0]?.name === 'read' && facts.tools[0]?.ok === true;
      verdict.E3_modelSawContent = facts.reply.includes('read: FILE-MARKER-E3');
      await close(s);
    }

    // ---- E4: ask, no card for the trusted path ----------------------------------------------
    {
      const s = await open('e4', ASK);
      const facts = await run(s, 'P1-FILEREAD: read the attached file. (E4)', [
        await fileBlock('e4.txt', 'FILE-MARKER-E4'),
      ]);
      report.E4 = facts;
      verdict.E4_noCard = facts.cards.length === 0;
      verdict.E4_readSucceeded = facts.tools[0]?.ok === true;
      verdict.E4_modelSawContent = facts.reply.includes('read: FILE-MARKER-E4');
      await close(s);
    }

    // ---- E5: ask, an explicit deny still holds ----------------------------------------------
    {
      const s = await open('e5', ASK);
      const facts = await run(s, 'P1-FILEREAD: read the attached file. (E5)', [
        await fileBlock('secrets.env', 'FILE-MARKER-E5'),
      ]);
      report.E5 = facts;
      verdict.E5_noCard = facts.cards.length === 0;
      verdict.E5_refused = facts.tools[0]?.ok === false && !facts.reply.includes('FILE-MARKER-E5');
      await close(s);
    }

    // ---- E6: ask, an image-capable model, read_image of the normalized copy -------------------
    {
      const admitted = await row.op('admit', {
        parts: [
          { type: 'text', text: 'x' },
          { type: 'image', mediaType: 'image/png', data: b64(solidPng(4, 4)), name: 'e6.png' },
        ],
      });
      const image = (admitted.parts as Message[])[1] as Message;
      const where = await row.op('image-path', { ref: image.attachment });
      const s = await open('e6', ASK, `${FAKE_ROUTE}/${VISION_MODEL}`);
      const facts = await run(s, 'P1-IMAGEREAD: look at the attached image. (E6)', [image]);
      report.E6 = { admitted: image, where, ...facts };
      verdict.E6_imagePathUnderAttachmentsV1 = underAttachments(where.hostPath);
      verdict.E6_modelGotImageBlock = facts.reply.includes('1 image block(s)');
      verdict.E6_noCard = facts.cards.length === 0;
      verdict.E6_readImageSucceeded =
        facts.tools[0]?.name === 'read_image' && facts.tools[0]?.ok === true;
      await close(s);
    }

    report.verdict = verdict;
    failed = Object.values(verdict).some((value) => !value);
  } catch (error) {
    failed = true;
    report.verdict = verdict;
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
    else report.scratch = '<kept>';
  }
  // Scratch paths, the user and the machine never leave this process: the
  // report is evidence for a public repo.
  let text = `${JSON.stringify(report, null, 2)}\n`;
  for (const [value, placeholder] of [
    [box.dshHome, '<dsh-home>'],
    [scratchRoot, '<scratch>'],
    [os.homedir(), '<home>'],
    [os.hostname(), '<host>'],
    [os.userInfo().username, '<user>'],
  ] as const) {
    if (value.length > 2) text = text.split(value).join(placeholder);
  }
  if (outFile) writeFileSync(outFile, text);
  process.stdout.write(text);
  return failed ? 1 : 0;
}

process.exitCode = await main();
