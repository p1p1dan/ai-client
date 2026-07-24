/**
 * C-13 spike: attachment protocol probe — can Agent SDK query() carry
 * images / files to the model? (User feedback F2: paste image/file in chat.)
 *
 * Scenarios:
 *   A. prompt as AsyncIterable<SDKUserMessage>, content has an image block
 *      (base64 PNG, generated in-process — no external file).
 *   B. plain string prompt referencing an on-disk PNG path; model reads it
 *      via the Read tool (auto-allowed through canUseTool).
 *   C. prompt as message stream, content has a document block
 *      (PlainTextSource) carrying a text file.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c13-attachment-probe.ts
 *   node --experimental-strip-types spikes/c13-attachment-probe.ts --only A
 *
 * Probe only — no runtime code touched. Uses shared CCH test gateway
 * (testCredentials.ts), same option shape as claudeRuntime.ts.
 */

import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { TEST_AUTH_TOKEN, TEST_BASE_URL, testCredentialEnv } from './testCredentials.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(hostRoot, '..', '..');
const require = createRequire(import.meta.url);

const TIMEOUT_MS = Number(process.env.AICLIENT_SPIKE_TIMEOUT_MS ?? 120000);
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].toUpperCase() : null;
})();

// ---------------------------------------------------------------------------
// Tiny PNG generator: 8x8 solid color, truecolor 8-bit, no external deps.
// ---------------------------------------------------------------------------

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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    const off = y * stride;
    raw[off] = 0; // filter: none
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
// SDK plumbing (aligned with claudeRuntime.ts options)
// ---------------------------------------------------------------------------

type SdkQueryFn = (params: {
  prompt: string | AsyncIterable<Record<string, unknown>>;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown> & { close?: () => void };

async function resolveCometixCli(): Promise<string> {
  const pkgJson = require.resolve('@cometix/claude-code/package.json');
  const root = path.dirname(pkgJson);
  const candidates = [
    path.join(root, 'cli.js'),
    path.join(root, 'cli.mjs'),
    path.join(root, 'bin', 'cli.js'),
    path.join(root, 'dist', 'cli.js'),
  ];
  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch {
      // try next
    }
  }
  throw new Error(`Cometix cli.js not found under ${root}`);
}

async function loadQueryFn(): Promise<SdkQueryFn> {
  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query?: SdkQueryFn;
    default?: { query?: SdkQueryFn };
  };
  const fn = sdk.query ?? sdk.default?.query;
  if (!fn) throw new Error('claude-agent-sdk has no query() export');
  return fn;
}

/** Single-message stream — the SDKUserMessage envelope query() accepts. */
async function* oneUserMessage(
  content: unknown
): AsyncGenerator<Record<string, unknown>, void, void> {
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

/** Redact base64 payloads for the report's request-shape sample. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        k === 'data' && typeof v === 'string' && v.length > 64
          ? `<base64 ${v.length} chars>`
          : redact(v);
    }
    return out;
  }
  return value;
}

interface ScenarioReport {
  scenario: string;
  ok: boolean;
  requestShape: unknown;
  assistantText: string;
  resultSubtype?: string;
  eventTypes: string[];
  toolUses: string[];
  durationMs: number;
  error?: string;
}

async function runScenario(input: {
  name: string;
  queryFn: SdkQueryFn;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string | AsyncIterable<Record<string, unknown>>;
  requestShape: unknown;
  expect: (assistantText: string) => boolean;
}): Promise<ScenarioReport> {
  const report: ScenarioReport = {
    scenario: input.name,
    ok: false,
    requestShape: input.requestShape,
    assistantText: '',
    eventTypes: [],
    toolUses: [],
    durationMs: 0,
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const started = Date.now();
  let stream: (AsyncIterable<unknown> & { close?: () => void }) | null = null;
  try {
    stream = input.queryFn({
      prompt: input.prompt,
      options: {
        cwd: input.cwd,
        pathToClaudeCodeExecutable: input.cliPath,
        executable: process.execPath,
        tools: { type: 'preset', preset: 'claude_code' },
        settingSources: [],
        thinking: { type: 'disabled' },
        permissionMode: 'default',
        // Auto-allow every tool so scenario B's Read(image) is not blocked.
        canUseTool: async (_tool: string, toolInput: Record<string, unknown>) => ({
          behavior: 'allow' as const,
          updatedInput: toolInput,
        }),
        maxTurns: 6,
        env: input.env,
        abortController: abort,
      },
    });
    for await (const event of stream) {
      if (abort.signal.aborted) break;
      const e = event as {
        type?: string;
        subtype?: string;
        result?: string;
        is_error?: boolean;
        message?: { content?: Array<{ type?: string; text?: string; name?: string }> };
      };
      const type = String(e.type ?? '');
      if (report.eventTypes.length < 30)
        report.eventTypes.push(type + (e.subtype ? `:${e.subtype}` : ''));
      if (type === 'assistant' && Array.isArray(e.message?.content)) {
        for (const block of e.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            report.assistantText = (report.assistantText + block.text).slice(0, 500);
          }
          if (block.type === 'tool_use' && block.name) report.toolUses.push(block.name);
        }
      }
      if (type === 'result') {
        report.resultSubtype = String(e.subtype ?? '');
        if (e.is_error && typeof e.result === 'string') report.error = e.result.slice(0, 800);
      }
    }
    if (abort.signal.aborted && !report.error) {
      report.error = `timeout after ${TIMEOUT_MS}ms`;
    }
    report.ok = !report.error && input.expect(report.assistantText.toLowerCase());
  } catch (err) {
    report.error = (err instanceof Error ? err.message : String(err)).slice(0, 800);
  } finally {
    clearTimeout(timer);
    try {
      stream?.close?.();
    } catch {
      // ignore
    }
    report.durationMs = Date.now() - started;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cliPath = await resolveCometixCli();
  const queryFn = await loadQueryFn();
  const cwd = process.env.AICLIENT_SPIKE_WORKDIR ?? repoRoot;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...testCredentialEnv(cwd),
    ANTHROPIC_AUTH_TOKEN: TEST_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: TEST_BASE_URL,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'aiclient-c13-attachment-probe/0.0.1',
  };

  const redPng = makeSolidPng(255, 0, 0);
  const redPngB64 = redPng.toString('base64');

  const reports: ScenarioReport[] = [];

  // --- Scenario A: message stream with base64 image block --------------------
  if (!ONLY || ONLY === 'A') {
    const contentA = [
      {
        type: 'text',
        text: 'What color is this image? Reply with just the color, one word.',
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: redPngB64 },
      },
    ];
    reports.push(
      await runScenario({
        name: 'A-stream-image-base64',
        queryFn,
        cliPath,
        env,
        cwd,
        prompt: oneUserMessage(contentA),
        requestShape: {
          prompt: 'AsyncIterable<SDKUserMessage>',
          message: { role: 'user', content: redact(contentA) },
        },
        expect: (t) => t.includes('red'),
      })
    );
  }

  // --- Scenario B: string prompt + on-disk image path (Read tool) ------------
  if (!ONLY || ONLY === 'B') {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiclient-c13-'));
    const imgPath = path.join(dir, 'probe-blue.png');
    await writeFile(imgPath, makeSolidPng(0, 0, 255));
    const promptB =
      `Read the image file at ${imgPath} using the Read tool. ` +
      'What color is it? Reply with just the color, one word.';
    reports.push(
      await runScenario({
        name: 'B-string-prompt-image-path',
        queryFn,
        cliPath,
        env,
        cwd,
        prompt: promptB,
        requestShape: { prompt: `string: "${promptB.replace(dir, '<tmpdir>')}"` },
        expect: (t) => t.includes('blue'),
      })
    );
  }

  // --- Scenario C: message stream with plain-text document block --------------
  if (!ONLY || ONLY === 'C') {
    const docText = 'Meeting notes.\nThe magic word is: kumquat\nEnd of notes.\n';
    const contentC = [
      {
        type: 'text',
        text: 'What is the magic word in the attached document? Reply with just the word.',
      },
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: docText },
        title: 'notes.txt',
      },
    ];
    reports.push(
      await runScenario({
        name: 'C-stream-document-plaintext',
        queryFn,
        cliPath,
        env,
        cwd,
        prompt: oneUserMessage(contentC),
        requestShape: {
          prompt: 'AsyncIterable<SDKUserMessage>',
          message: { role: 'user', content: contentC },
        },
        expect: (t) => t.includes('kumquat'),
      })
    );
  }

  // --- Scenario D (opt-in, --only D): large image — gateway size probe -------
  // 256x256 noisy-green PNG (~190KB, ~260KB base64): does the gateway 413 /
  // strip base64 on realistic paste sizes? Not part of the default run.
  if (ONLY === 'D') {
    const size = 256;
    const stride = 1 + size * 3;
    const raw = Buffer.alloc(size * stride);
    for (let y = 0; y < size; y += 1) {
      const off = y * stride;
      raw[off] = 0;
      for (let x = 0; x < size; x += 1) {
        // Visually green, low-bit noise keeps deflate from shrinking it.
        raw[off + 1 + x * 3] = Math.floor(Math.random() * 30);
        raw[off + 2 + x * 3] = 200 + Math.floor(Math.random() * 55);
        raw[off + 3 + x * 3] = Math.floor(Math.random() * 30);
      }
    }
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const bigPng = Buffer.concat([
      sig,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const bigB64 = bigPng.toString('base64');
    const contentD = [
      {
        type: 'text',
        text: 'What is the dominant color of this image? Reply with just the color, one word.',
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: bigB64 },
      },
    ];
    reports.push(
      await runScenario({
        name: `D-stream-large-image-${bigPng.length}B`,
        queryFn,
        cliPath,
        env,
        cwd,
        prompt: oneUserMessage(contentD),
        requestShape: {
          prompt: 'AsyncIterable<SDKUserMessage>',
          pngBytes: bigPng.length,
          base64Chars: bigB64.length,
          message: { role: 'user', content: redact(contentD) },
        },
        expect: (t) => t.includes('green'),
      })
    );
  }

  const ok = reports.every((r) => r.ok);
  console.log(
    JSON.stringify(
      {
        spike: 'c13-attachment-probe',
        ok,
        gateway: TEST_BASE_URL,
        node: process.version,
        pngBytes: redPng.length,
        scenarios: reports,
      },
      null,
      2
    )
  );
  process.exitCode = ok ? 0 : 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
