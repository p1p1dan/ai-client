import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Context } from 'cordis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../bootstrap.ts';
import type {
  RuntimeExecRequest,
  RuntimeExecResult,
  RuntimeHostConfig,
  RuntimeHostIoService,
} from '../contracts.ts';
import { standaloneHost } from '../host/config.ts';
import { ExecPlugin } from '../host/exec.ts';
import { HostIoPlugin } from '../host/io.ts';
import { readLines } from '../plugins/tools/read-lines.ts';
import { neverAsked } from './fixtures/approval.ts';

/**
 * T047 — the TSD read fallback, pinned with doubles.
 *
 * The encrypted Windows box is the only place the real chain runs, so every
 * rule the helper contract states is fixed here with a stand-in exec adapter
 * instead of waiting for a field trip (batch-D checklist-e, tsd-utility
 * T01-T08 and T12-T14).
 */

/** Mirrors `tsd-read.mjs`: 8-byte magic + 4-byte big-endian payload length. */
const FRAME_MAGIC = Buffer.from('%TSDOUT%');
const FRAME_HEADER_BYTES = FRAME_MAGIC.length + 4;
function frame(payload: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  FRAME_MAGIC.copy(header, 0);
  header.writeUInt32BE(bytes.length, FRAME_MAGIC.length);
  return Buffer.concat([header, bytes]);
}
/** The same frame, written by a `node -e` child rather than built in process. */
function frameScript(length: number, fill: number): string {
  return `const h=Buffer.alloc(${FRAME_HEADER_BYTES});Buffer.from('%TSDOUT%').copy(h,0);h.writeUInt32BE(${length},8);process.stdout.write(Buffer.concat([h,Buffer.alloc(${length},${fill})]))`;
}
const TSD_MAGIC = '%TSD-Header-###%';
/**
 * Field containers are block-aligned: the two samples the encrypted box
 * produced are 20480 and 45056 bytes, both multiples of 4096. HostIo uses that
 * as the second criterion, so a fixture has to be aligned to be ciphertext.
 */
const CONTAINER_BLOCK = 4096;
/** `TSD_STDERR_BYTES` in io.ts — the helper's own stderr budget (core-host-05). */
const STDERR_BUDGET = 4096;

let dir: string;
let base: RuntimeHostConfig;
let realExec: ExecPlugin;
const contexts: Context[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-tsd-'));
  base = standaloneHost({ PATH: process.env.PATH });
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(ExecPlugin, base);
  realExec = ctx.runtimeExec as ExecPlugin;
});
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
});

/** A file shaped like a real container: magic head, whole number of blocks. */
async function container(name = 'encrypted', size = CONTAINER_BLOCK): Promise<string> {
  const path = join(dir, name);
  const bytes = Buffer.alloc(size, 0x2a);
  Buffer.from(TSD_MAGIC).copy(bytes, 0);
  await writeFile(path, bytes);
  return path;
}

function completed(stdout: Buffer, extra: Partial<RuntimeExecResult> = {}): RuntimeExecResult {
  return {
    exitCode: 0,
    signal: null,
    termination: 'exit',
    stdout,
    stderr: new Uint8Array(),
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    truncated: false,
    ...extra,
  };
}

/** HostIo wired to a stand-in for "spawn the configured Node on the helper". */
async function withHelper(
  run: (request: RuntimeExecRequest) => Promise<RuntimeExecResult>,
  overrides: Partial<RuntimeHostConfig> = {}
) {
  const seen: RuntimeExecRequest[] = [];
  const config: RuntimeHostConfig = {
    ...base,
    tsdReadFallback: 'configured-node',
    exec: {
      mode: 'host-adapter',
      adapter: {
        id: 'tsd-double-v1',
        dispose: async () => {},
        run: (request) => {
          seen.push(request);
          return run(request);
        },
      },
    },
    ...overrides,
  };
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(ExecPlugin, config);
  const fiber = await ctx.plugin(HostIoPlugin, config);
  await fiber.await();
  return { io: ctx.runtimeHostIo as HostIoPlugin, seen, config };
}

describe('TSD fallback contract (doubles)', () => {
  it('T01 reports a helper timeout as an unreadable file, not a partial read', async () => {
    const path = await container();
    const { io } = await withHelper(async () =>
      completed(frame('half of the plaintex'), {
        termination: 'timeout',
        exitCode: null,
        signal: 'SIGKILL',
      })
    );
    const error = await io.readFile(path, { maxBytes: 64, overflow: 'truncate' }).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toMatchObject({ code: 'io_tsd_unreadable' });
    expect((error as Error).message).toContain('timeout');
  });

  it('T02 treats a short helper read as a complete file, not a failure', async () => {
    const path = await container();
    const plain = Buffer.from('x'.repeat(32));
    const { io } = await withHelper(async () => completed(frame(plain)));
    const data = await io.readFile(path, { maxBytes: 64, overflow: 'error' });
    expect(Buffer.from(data.bytes)).toEqual(plain);
    expect(data.truncated).toBe(false);
    expect(data.source).toBe('node-fallback');
  });

  it('T03 refuses stdout noise around the plaintext instead of serving it as content', async () => {
    const path = await container();
    const plain = Buffer.from('real file content');
    const { io } = await withHelper(async () =>
      completed(Buffer.concat([Buffer.from('[corp] telemetry ready\n'), frame(plain)]))
    );
    await expect(io.readFile(path, { maxBytes: 64, overflow: 'truncate' })).rejects.toMatchObject({
      code: 'io_tsd_unreadable',
    });
    const trailing = await withHelper(async () =>
      completed(Buffer.concat([frame(plain), Buffer.from('\n[corp] done')]))
    );
    await expect(
      trailing.io.readFile(path, { maxBytes: 64, overflow: 'truncate' })
    ).rejects.toMatchObject({ code: 'io_tsd_unreadable' });
  });

  it('T04 never reports stdout past the window as a complete file', async () => {
    const path = await container();
    const maxBytes = 64;
    const { io, seen } = await withHelper((request) =>
      realExec.run({
        ...request,
        command: process.execPath,
        args: ['-e', frameScript(maxBytes + 2, 0x70)],
      })
    );
    await expect(io.readFile(path, { maxBytes, overflow: 'truncate' })).rejects.toMatchObject({
      code: 'io_tsd_unreadable',
    });
    // The frame header has its own room on top of the window, so a full read is
    // not mistaken for an overflowing one.
    expect(seen[0]?.maxOutputBytes).toBe(maxBytes + 1 + FRAME_HEADER_BYTES);
  });

  it('T05 passes binary plaintext through the fallback unchanged', async () => {
    const path = await container();
    const bytes = Buffer.from([0x41, 0x00, 0xff, 0xfe, 0x42]);
    const { io } = await withHelper(async () => completed(frame(bytes)));
    const data = await io.readFile(path, { maxBytes: 64, overflow: 'truncate' });
    expect(Buffer.from(data.bytes)).toEqual(bytes);
    // The read tool, not HostIo, is where those bytes become a text error.
    const stub = {
      readFile: async () => ({ bytes, truncated: false, source: 'node-fallback' as const }),
    } as unknown as RuntimeHostIoService;
    await expect(readLines(stub, join(dir, 'x'), 1, 10, 64)).rejects.toMatchObject({
      code: 'io_not_utf8',
    });
  });

  it('T06 reports an abort during the helper run as io_aborted', async () => {
    const path = await container();
    const controller = new AbortController();
    let adapterSignal: AbortSignal | undefined;
    const { io } = await withHelper(
      (request) =>
        new Promise<RuntimeExecResult>((resolve) => {
          adapterSignal = request.signal;
          request.signal?.addEventListener(
            'abort',
            () => resolve(completed(Buffer.alloc(0), { termination: 'aborted', exitCode: null })),
            { once: true }
          );
          setTimeout(() => controller.abort(), 0);
        })
    );
    await expect(
      io.readFile(path, { maxBytes: 64, overflow: 'truncate', signal: controller.signal })
    ).rejects.toMatchObject({ code: 'io_aborted' });
    expect(adapterSignal?.aborted).toBe(true);
  });

  it('T07 returns empty bytes for an offset past EOF on the fallback path too', async () => {
    const path = await container();
    const { io } = await withHelper(async () => completed(frame(Buffer.alloc(0))));
    const data = await io.readFile(path, { offset: 1 << 20, maxBytes: 64, overflow: 'error' });
    expect(data.bytes.length).toBe(0);
    expect(data.truncated).toBe(false);
    expect(data.source).toBe('node-fallback');
  });

  it('T08 does not hand the helper NODE_OPTIONS from the enterprise environment', async () => {
    const path = await container();
    const { io, seen } = await withHelper(async () => completed(frame('plain')), {
      childEnv: {
        ...base.childEnv,
        NODE_OPTIONS: '--import /opt/corp/telemetry.mjs',
        NODE_V8_COVERAGE: '/tmp/coverage',
        NODE_REPL_EXTERNAL_MODULE: '/opt/corp/repl.mjs',
      },
    });
    await io.readFile(path, { maxBytes: 64, overflow: 'truncate' });
    expect(seen[0]?.env?.NODE_OPTIONS).toBeUndefined();
    expect(seen[0]?.env?.NODE_V8_COVERAGE).toBeUndefined();
    expect(seen[0]?.env?.NODE_REPL_EXTERNAL_MODULE).toBeUndefined();
    // Still a usable environment: only the injection knobs are dropped.
    expect(seen[0]?.env?.PATH).toBeTruthy();
  });

  it('T12 keeps one shared budget when the caller asks for no stderr budget', async () => {
    const result = await realExec.run({
      command: process.execPath,
      args: ['-e', "process.stderr.write('e'.repeat(512));process.stdout.write('o'.repeat(512))"],
      cwd: dir,
      timeoutMs: 5000,
      maxOutputBytes: 256,
      overflow: 'truncate',
    });
    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(256);
  });

  it('T13 never sets truncated for stderr overflow alone', async () => {
    const path = await container();
    const maxBytes = 64;
    const payload = 'p'.repeat(maxBytes / 2);
    const script = `process.stderr.write('w'.repeat(${STDERR_BUDGET * 2}));${frameScript(
      maxBytes / 2,
      0x70
    )}`;
    let result: RuntimeExecResult | undefined;
    const { io } = await withHelper(async (request) => {
      result = await realExec.run({ ...request, command: process.execPath, args: ['-e', script] });
      return result;
    });
    const data = await io.readFile(path, { maxBytes, overflow: 'truncate' });
    expect(Buffer.from(data.bytes).toString('utf8')).toBe(payload);
    expect(data.truncated).toBe(false);
    expect(result?.termination).toBe('exit');
    expect(result?.truncated).toBe(false);
    expect(result?.stderrBytes).toBe(STDERR_BUDGET * 2);
    expect(result?.stderr.length).toBe(STDERR_BUDGET);
  });

  it('T14 runs the real helper for limit=1, an offset past EOF and non-UTF-8 bytes', async () => {
    const helper = fileURLToPath(new URL('../host/tsd-read.mjs', import.meta.url));
    const path = join(dir, 'plain.bin');
    const bytes = Buffer.from([0x41, 0xff, 0xfe, 0x42]);
    await writeFile(path, bytes);
    const run = (offset: number, limit: number) =>
      realExec.run({
        command: process.execPath,
        args: [helper, path, String(offset), String(limit)],
        cwd: dir,
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        overflow: 'truncate',
      });
    const unframe = (result: RuntimeExecResult) => {
      const stdout = Buffer.from(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(stdout.subarray(0, FRAME_MAGIC.length)).toEqual(FRAME_MAGIC);
      const declared = stdout.readUInt32BE(FRAME_MAGIC.length);
      const payload = stdout.subarray(FRAME_HEADER_BYTES);
      expect(payload.length).toBe(declared);
      return payload;
    };
    expect(unframe(await run(0, 1))).toEqual(bytes.subarray(0, 1));
    expect(unframe(await run(4096, 4)).length).toBe(0);
    expect(unframe(await run(0, 4))).toEqual(bytes);
  }, 20_000);

  it('reads a plaintext file that merely starts with the TSD magic (tsd-07)', async () => {
    const path = join(dir, 'tsd-sample.txt');
    const text = `${TSD_MAGIC}\nnotes taken while chasing the container format\n`;
    await writeFile(path, text);
    const { io, seen } = await withHelper(async () => {
      throw new Error('the helper must not run for a file that is not a container');
    });
    const data = await io.readFile(path, { maxBytes: 4096, overflow: 'truncate' });
    expect(Buffer.from(data.bytes).toString('utf8')).toBe(text);
    expect(data.source).toBe('direct');
    expect(seen).toHaveLength(0);
  });

  it('still treats a block-aligned container as ciphertext and names the carrier (tsd-01)', async () => {
    const path = await container('policy.bin', CONTAINER_BLOCK * 5);
    const { io } = await withHelper(async () => completed(frame('never asked')), {
      tsdReadFallback: 'disabled',
    });
    const error = await io.readFile(path, { maxBytes: 64, overflow: 'truncate' }).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toMatchObject({ code: 'io_tsd_unavailable' });
    // tsd-01(b): the field has to tell "the driver stopped whitelisting us"
    // from "this file was never readable", so the carrier and the Node that
    // would have run the helper are in the message.
    expect((error as Error).message).toContain(base.carrier);
    expect((error as Error).message).toContain(process.execPath);
    expect((error as Error).message).toContain(path);
  });
});

/**
 * T1 — the read tool's image branch over the fallback. Every HostIo read of a
 * container is one helper process, so the counts are the cost: an encrypted
 * image with an image name is one run, a text read never pays for a sniff.
 */
describe('read tool over the TSD fallback (T1)', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64'
  );
  async function withReadTool(
    plain: Record<string, Buffer>,
    body: (
      read: (path: string) => Promise<AgentToolResult<unknown>>,
      runs: string[]
    ) => Promise<void>
  ) {
    const runs: string[] = [];
    const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
    const runtime = await createRuntime({
      providers: [faux.provider],
      env: {},
      host: {
        ...base,
        tsdReadFallback: 'configured-node',
        exec: {
          mode: 'host-adapter',
          adapter: {
            id: 'tsd-read-tool-double-v1',
            dispose: async () => {},
            // Serves the requested window of the named file's plaintext.
            run: async (request) => {
              const [, path = '', offset = '0', window = '0'] = request.args;
              const bytes = plain[basename(path)];
              if (!bytes) throw new Error(`unexpected exec: ${request.args.join(' ')}`);
              runs.push(basename(path));
              const start = Number(offset);
              return completed(frame(bytes.subarray(start, start + Number(window))));
            },
          },
        },
      },
      tools: { cwd: dir },
      permissions: { approve: neverAsked },
    });
    try {
      const tool = runtime.ctx.runtimeTools.list().find((candidate) => candidate.name === 'read');
      if (!tool) throw new Error('missing read');
      await body((path) => tool.execute('tsd-read', { path }), runs);
    } finally {
      await runtime.dispose();
    }
  }

  it('reads an encrypted .png as an image in one helper run', async () => {
    await container('shot.png');
    await withReadTool({ 'shot.png': PNG }, async (read, runs) => {
      const output = await read('shot.png');
      expect(output.content[1]).toEqual({
        type: 'image',
        data: PNG.toString('base64'),
        mimeType: 'image/png',
      });
      expect(runs).toEqual(['shot.png']);
    });
  });

  it('reads encrypted text in one helper run, with no header sniff', async () => {
    await container('notes.txt');
    await withReadTool({ 'notes.txt': Buffer.from('sealed notes\n') }, async (read, runs) => {
      const output = await read('notes.txt');
      expect(output.content).toEqual([{ type: 'text', text: 'sealed notes\n' }]);
      expect(runs).toEqual(['notes.txt']);
    });
  });

  it('finds an encrypted image with no extension after the text read fails', async () => {
    await container('shot');
    await withReadTool({ shot: PNG }, async (read, runs) => {
      const output = await read('shot');
      expect(output.details).toMatchObject({ mimeType: 'image/png', image: true });
      // Text chunk, header sniff, body: the price of a name that says nothing.
      expect(runs).toEqual(['shot', 'shot', 'shot']);
    });
  });
});
