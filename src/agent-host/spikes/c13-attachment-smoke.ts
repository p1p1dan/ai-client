/**
 * C-13 gateway smoke: session.send attachments[] → model sees the content.
 * Drives the full Host process over stdio NDJSON.
 *
 * Scenarios (one fresh session each, same Host process):
 *   image — attachments:[{kind:'image', mediaType:'image/png', data:<red 8x8>}]
 *           → assistant names the color red.
 *   text  — attachments:[{kind:'text', mediaType:'text/plain', data:<notes>,
 *           name:'notes.txt'}] → assistant recalls the magic word.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c13-attachment-smoke.ts
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { AGENT_HOST_PROTOCOL_VERSION } from '../../shared/types/agentHost.ts';
import { testCredentialEnv } from './testCredentials.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(hostRoot, '..', '..');
const hostEntry = process.env.AICLIENT_SMOKE_HOST_ENTRY ?? path.join(hostRoot, 'index.ts');

const NODE24 = process.env.AICLIENT_NODE24 ?? process.execPath;
const WORKDIR = process.env.AICLIENT_SMOKE_WORKDIR ?? repoRoot;
const SCENARIO_TIMEOUT_MS = Number(process.env.AICLIENT_C13_TIMEOUT_MS ?? 150000);

// --- Tiny PNG generator (same as c13-attachment-probe) ----------------------

function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = (table[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makeSolidPng(r: number, g: number, b: number, size = 8): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    const off = y * stride;
    raw[off] = 0;
    for (let x = 0; x < size; x += 1) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

interface Attachment {
  kind: 'image' | 'text';
  mediaType: string;
  data: string;
  name?: string;
}

interface ScenarioSpec {
  name: 'image' | 'text';
  text: string;
  attachments: Attachment[];
  expect: (assistant: string) => boolean;
}

interface ScenarioReport {
  scenario: string;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  terminal?: string;
  assistantPreview: string;
  error?: string;
}

interface HostEvent {
  type?: string;
  sessionId?: string;
  payload?: {
    text?: string;
    error?: string;
    message?: string;
    fatal?: boolean;
  };
}

function send(child: ReturnType<typeof spawn>, cmd: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(cmd)}\n`);
}

function runScenario(
  child: ReturnType<typeof spawn>,
  rl: ReturnType<typeof createInterface>,
  spec: ScenarioSpec
): Promise<ScenarioReport> {
  return new Promise((resolve) => {
    const report: ScenarioReport = {
      scenario: spec.name,
      ok: false,
      timedOut: false,
      durationMs: 0,
      assistantPreview: '',
    };
    const sessionId = `c13-${spec.name}-${Date.now()}`;
    const started = Date.now();
    let settled = false;

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      rl.off('line', onLine);
      clearTimeout(timer);
      report.durationMs = Date.now() - started;
      if (error) report.error = error;
      report.ok =
        !report.timedOut &&
        report.terminal === 'session.completed' &&
        spec.expect(report.assistantPreview.toLowerCase());
      send(child, {
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: `close-${sessionId}`,
        type: 'session.close',
        payload: { sessionId },
      });
      resolve(report);
    };

    const timer = setTimeout(() => {
      report.timedOut = true;
      finish(`timeout after ${SCENARIO_TIMEOUT_MS}ms`);
    }, SCENARIO_TIMEOUT_MS);

    const onLine = (line: string) => {
      let event: HostEvent;
      try {
        event = JSON.parse(line) as HostEvent;
      } catch {
        return;
      }
      if (event.sessionId !== sessionId) return;
      const type = String(event.type ?? '');
      if (type === 'message.delta' && typeof event.payload?.text === 'string') {
        const text = event.payload.text;
        if (text !== spec.text) {
          report.assistantPreview = (report.assistantPreview + text).slice(0, 300);
        }
      }
      if (type === 'session.failed') {
        report.error = String(event.payload?.error ?? 'session.failed');
      }
      if (type === 'session.completed' || type === 'session.failed' || type === 'session.stopped') {
        report.terminal = type;
        finish();
      }
    };
    rl.on('line', onLine);

    send(child, {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: `create-${sessionId}`,
      type: 'session.create',
      payload: { sessionId, workspacePath: WORKDIR },
    });
    send(child, {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: `send-${sessionId}`,
      type: 'session.send',
      payload: { sessionId, text: spec.text, attachments: spec.attachments },
    });
  });
}

async function main(): Promise<void> {
  const child = spawn(NODE24, ['--experimental-strip-types', hostEntry], {
    cwd: hostRoot,
    env: {
      ...process.env,
      ...testCredentialEnv(WORKDIR),
      AICLIENT_AGENT_HOST_DRIVER: 'agent-sdk',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderrChunks: string[] = [];
  child.stderr?.on('data', (buf: Buffer) => {
    stderrChunks.push(buf.toString('utf8'));
  });
  const rl = createInterface({ input: child.stdout! });

  await new Promise<void>((resolve, reject) => {
    const onLine = (line: string) => {
      try {
        const event = JSON.parse(line) as HostEvent;
        if (event.type === 'host.ready') {
          rl.off('line', onLine);
          resolve();
        }
        if (event.type === 'host.error' && event.payload?.fatal) {
          rl.off('line', onLine);
          reject(new Error(event.payload.message ?? 'fatal host.error'));
        }
      } catch {
        // ignore non-JSON
      }
    };
    rl.on('line', onLine);
    send(child, {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: 'init-1',
      type: 'host.initialize',
      payload: { driver: 'agent-sdk' },
    });
    setTimeout(() => reject(new Error('host.ready timeout (60s)')), 60000);
  });
  console.error('[c13] host ready');

  const scenarios: ScenarioSpec[] = [
    {
      name: 'image',
      text: 'What color is the attached image? Reply with just the color, one word.',
      attachments: [
        {
          kind: 'image',
          mediaType: 'image/png',
          data: makeSolidPng(255, 0, 0).toString('base64'),
          name: 'red.png',
        },
      ],
      expect: (t) => t.includes('red'),
    },
    {
      name: 'text',
      text: 'What is the magic word in the attached document? Reply with just the word.',
      attachments: [
        {
          kind: 'text',
          mediaType: 'text/plain',
          data: 'Meeting notes.\nThe magic word is: kumquat\nEnd of notes.\n',
          name: 'notes.txt',
        },
      ],
      expect: (t) => t.includes('kumquat'),
    },
  ];

  const reports: ScenarioReport[] = [];
  for (const spec of scenarios) {
    console.error(`[c13] running scenario: ${spec.name}`);
    const report = await runScenario(child, rl, spec);
    console.error(
      `[c13] ${spec.name}: ok=${report.ok} terminal=${report.terminal} ` +
        `durationMs=${report.durationMs} preview=${report.assistantPreview.slice(0, 60)}`
    );
    reports.push(report);
  }

  const summary = {
    ok: reports.every((r) => r.ok),
    reports,
    stderrTail: stderrChunks.join('').slice(-600),
  };
  console.log(JSON.stringify(summary, null, 2));

  send(child, {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    requestId: 'shutdown-1',
    type: 'host.shutdown',
  });
  setTimeout(() => {
    if (child.exitCode === null) child.kill();
    process.exit(summary.ok ? 0 : 2);
  }, 800);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
