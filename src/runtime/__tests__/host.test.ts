import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from 'cordis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeExecRequest, RuntimeHostConfig } from '../contracts.ts';
import { standaloneHost, validateHost } from '../host/config.ts';
import { ExecPlugin } from '../host/exec.ts';
import { HostIoPlugin } from '../host/io.ts';

let dir: string;
let ctx: Context;
let exec: ExecPlugin;
let io: HostIoPlugin;
let config: RuntimeHostConfig;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-host-'));
  config = standaloneHost({ PATH: process.env.PATH });
  ctx = new Context();
  await ctx.plugin(ExecPlugin, config);
  const fiber = await ctx.plugin(HostIoPlugin, config);
  await fiber.await();
  exec = ctx.runtimeExec as ExecPlugin;
  io = ctx.runtimeHostIo as HostIoPlugin;
});
afterEach(async () => {
  await exec.shutdown();
  await io.shutdown();
  await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
});
const text = (value: Uint8Array) => Buffer.from(value).toString('utf8');
function command(script: string, extra: Partial<RuntimeExecRequest> = {}) {
  return exec.run({
    command: process.execPath,
    args: ['-e', script],
    cwd: dir,
    timeoutMs: 2000,
    maxOutputBytes: 4096,
    overflow: 'truncate',
    ...extra,
  });
}

describe('host IO', () => {
  it('writes, appends in order, bounds reads and preserves errors', async () => {
    const path = join(dir, 'a');
    await io.writeFile(path, Buffer.from('start'));
    await Promise.all(['A', 'B', 'C'].map((part) => io.appendFile(path, Buffer.from(part))));
    expect(text((await io.readFile(path, { maxBytes: 8, overflow: 'error' })).bytes)).toBe(
      'startABC'
    );
    const window = await io.readFile(path, { offset: 5, maxBytes: 2, overflow: 'truncate' });
    expect(text(window.bytes)).toBe('AB');
    expect(window.truncated).toBe(true);
    await expect(io.readFile(path, { maxBytes: 7, overflow: 'error' })).rejects.toMatchObject({
      code: 'io_limit',
    });
    expect(
      (await io.readFile(path, { offset: 20, maxBytes: 2, overflow: 'error' })).bytes.length
    ).toBe(0);
    await expect(io.writeFile(path, Buffer.from('no'), { createOnly: true })).rejects.toMatchObject(
      { code: 'EEXIST' }
    );
    await expect(
      io.readFile(join(dir, 'missing'), { maxBytes: 4, overflow: 'error' })
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects ciphertext without fallback and checks the header before an offset', async () => {
    const path = join(dir, 'encrypted');
    await writeFile(path, '%TSD-Header-###%secret');
    await expect(
      io.readFile(path, { offset: 17, maxBytes: 2, overflow: 'truncate' })
    ).rejects.toMatchObject({ code: 'io_tsd_unavailable' });
    config.tsdReadFallback = 'configured-node';
    await expect(
      io.readFile(path, { offset: 17, maxBytes: 2, overflow: 'truncate' })
    ).rejects.toMatchObject({ code: 'io_tsd_unreadable' });
  });
  it('runs the fixed helper with a bounded plaintext window and literal path', async () => {
    const path = join(dir, 'a $literal ; file');
    await writeFile(path, '0123456789');
    const helper = fileURLToPath(new URL('../host/tsd-read.mjs', import.meta.url));
    const result = await command('', { args: [helper, path, '3', '4'] });
    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toBe('3456');
  });
  it('routes TSD reads through an injected adapter exactly once', async () => {
    const encrypted = join(dir, 'encrypted');
    await writeFile(encrypted, '%TSD-Header-###%opaque');
    let calls = 0;
    const alternate = new Context();
    const adapted: RuntimeHostConfig = {
      ...config,
      tsdReadFallback: 'configured-node',
      exec: {
        mode: 'host-adapter',
        adapter: {
          id: 'tsd-fixture-v1',
          dispose: async () => {},
          run: async (request) => {
            calls++;
            expect(request.args[1]).toBe(encrypted);
            expect(request.command).toBe(process.execPath);
            return {
              exitCode: 0,
              signal: null,
              termination: 'exit',
              stdout: Buffer.from('plain'),
              stderr: new Uint8Array(),
              stdoutBytes: 5,
              stderrBytes: 0,
              truncated: false,
            };
          },
        },
      },
    };
    await alternate.plugin(ExecPlugin, adapted);
    const fiber = await alternate.plugin(HostIoPlugin, adapted);
    await fiber.await();
    try {
      const data = await alternate.runtimeHostIo.readFile(encrypted, {
        maxBytes: 8,
        overflow: 'error',
      });
      expect(text(data.bytes)).toBe('plain');
      expect(data.source).toBe('node-fallback');
      expect(calls).toBe(1);
    } finally {
      await alternate.fiber.dispose();
    }
  });
  it('rejects pre-aborted IO and closes early directory iteration', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      io.readFile(join(dir, 'missing'), {
        maxBytes: 1,
        overflow: 'error',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'io_aborted' });
    await io.writeFile(join(dir, 'a'), Buffer.from('x'));
    for await (const entry of io.readDirectory(dir)) {
      expect(entry.name).toBe('a');
      break;
    }
    await io.unlink(join(dir, 'a'));
    expect(await io.stat(dir)).toMatchObject({ kind: 'directory' });
  });
});

describe('host exec', () => {
  it('collects both streams, closes stdin and preserves nonzero exit', async () => {
    const result = await command(
      "process.stdin.on('data',d=>process.stdout.write(d));process.stdin.on('end',()=>{process.stderr.write('err');process.exitCode=7})",
      { stdin: Buffer.from('hello') }
    );
    expect(text(result.stdout)).toBe('hello');
    expect(text(result.stderr)).toBe('err');
    expect(result.exitCode).toBe(7);
  });
  it('drains after truncation and limits combined retained output', async () => {
    const result = await command(
      "process.stdout.write('x'.repeat(200000));process.stderr.write('y'.repeat(200000))",
      { maxOutputBytes: 32 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length + result.stderr.length).toBe(32);
    expect(result.stdoutBytes + result.stderrBytes).toBe(400000);
  });
  it('terminates on protocol output overflow', async () => {
    const result = await command("setInterval(()=>process.stdout.write('x'.repeat(4096)),1)", {
      maxOutputBytes: 16,
      overflow: 'terminate',
    });
    expect(result.termination).toBe('output-limit');
    expect(result.truncated).toBe(true);
  });
  it('times out, aborts before spawn, and rejects missing executables', async () => {
    expect((await command('setInterval(()=>{},1000)', { timeoutMs: 100 })).termination).toBe(
      'timeout'
    );
    const controller = new AbortController();
    controller.abort();
    const path = join(dir, 'should-not-exist');
    expect(
      (
        await command(`require('fs').writeFileSync(${JSON.stringify(path)}, 'no')`, {
          signal: controller.signal,
        })
      ).termination
    ).toBe('aborted');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(command('', { command: join(dir, 'absent') })).rejects.toMatchObject({
      code: 'exec_spawn_failed',
    });
  });
  it('prepends Node PATH and does not mutate the parent environment', async () => {
    const previous = process.env.PATH;
    const result = await command('process.stdout.write(process.env.PATH)', {
      env: { PATH: '/tail' },
    });
    expect(text(result.stdout).startsWith(dirname(process.execPath))).toBe(true);
    expect(process.env.PATH).toBe(previous);
  });
  it('settles active commands on dispose and rejects further requests', async () => {
    const work = command('setInterval(()=>{},1000)');
    await exec.shutdown();
    expect((await work).termination).toBe('disposed');
    await expect(command('')).rejects.toMatchObject({ code: 'runtime_disposed' });
    await exec.shutdown();
  });
  it('retains a runner leader and cleans descendants after the command exits', async () => {
    const marker = join(dir, 'heartbeat');
    const childCode = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},'ready');process.stdout.write('ready');setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},String(Date.now())),10)`;
    const script = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','inherit']});child.stdout.once('data',()=>process.exit(0));`;
    const result = await command(script, { timeoutMs: 2000 });
    expect(result.termination).toBe('exit');
    const afterExit = await readFile(marker, 'utf8');
    await new Promise((done) => setTimeout(done, 100));
    expect(await readFile(marker, 'utf8')).toBe(afterExit);
  });
  it('never discovers a replacement for a missing bundled Node', async () => {
    await expect(
      validateHost({
        ...config,
        carrier: 'bundled-node',
        node: { path: join(dir, 'missing'), source: 'bundled' },
      })
    ).rejects.toMatchObject({ code: 'invalid_host_config' });
  });
});

/**
 * P5-3 — the long-lived child the MCP bridge runs on.
 *
 * Covered here rather than only through `mcp.test.ts` because the two carriers
 * behave differently in exactly one way that matters, and it is not visible
 * from the protocol: with a configured Node runner the leader is the RUNNER,
 * which outlives the command it started, so the leader's own `close` is not the
 * child going away. Getting that wrong parks every in-flight request until its
 * timeout instead of failing it — which is how this was actually found.
 */
describe('host exec spawn', () => {
  const collect = () => {
    const chunks: Buffer[] = [];
    return {
      chunks,
      sink: (chunk: Uint8Array) => {
        chunks.push(Buffer.from(chunk));
      },
      text: () => Buffer.concat(chunks).toString('utf8'),
    };
  };

  async function persistent(script: string, hostConfig = config) {
    const out = collect();
    const err = collect();
    const plugin = hostConfig === config ? exec : undefined;
    const service = plugin ?? (await freshExec(hostConfig));
    const child = await service.spawn({
      command: process.execPath,
      args: ['-e', script],
      cwd: dir,
      onStdout: out.sink,
      onStderr: err.sink,
    });
    return { child, out, err, service };
  }

  async function freshExec(hostConfig: RuntimeHostConfig) {
    const local = new Context();
    await local.plugin(ExecPlugin, hostConfig);
    const service = local.runtimeExec as ExecPlugin;
    extraContexts.push({ ctx: local, exec: service });
    return service;
  }

  const extraContexts: { ctx: Context; exec: ExecPlugin }[] = [];
  afterEach(async () => {
    for (const entry of extraContexts.splice(0)) {
      await entry.exec.shutdown();
      await entry.ctx.fiber.dispose();
    }
  });

  const ECHO_LOOP = `
    let buffer = '';
    process.stdin.on('data', (chunk) => {
      buffer += chunk.toString();
      let i = buffer.indexOf('\\n');
      while (i >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line === 'quit') process.exit(7);
        process.stdout.write('got:' + line + '\\n');
        i = buffer.indexOf('\\n');
      }
    });
    process.stderr.write('ready\\n');
  `;

  it('keeps a child alive across several writes and reads its replies', async () => {
    const { child, out, err } = await persistent(ECHO_LOOP);
    await child.write(Buffer.from('one\n'));
    await child.write(Buffer.from('two\n'));
    for (let attempt = 0; attempt < 100 && !out.text().includes('got:two'); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(out.text()).toBe('got:one\ngot:two\n');
    // D11 point 5: stderr is drained, not dropped, or the child blocks on it.
    expect(err.text()).toContain('ready');
    await child.kill();
  }, 20_000);

  it('reports the command exiting on its own, not the carrier leader closing', async () => {
    const { child } = await persistent(ECHO_LOOP);
    await child.write(Buffer.from('quit\n'));
    // With a Node runner in front, this resolves only because the runner's IPC
    // exit message is honoured. Without that it hangs until the caller's own
    // timeout, and a dead server looks merely slow.
    await expect(
      Promise.race([
        child.exited.then((value) => value.exitCode),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 5000)),
      ])
    ).resolves.toBe(7);
  }, 20_000);

  it('runs on a carrier with no configured Node runner too', async () => {
    if (process.platform === 'win32') return; // Windows requires the runner.
    const direct: RuntimeHostConfig = { ...config, node: undefined };
    const { child, out } = await persistent(ECHO_LOOP, direct);
    await child.write(Buffer.from('hi\n'));
    for (let attempt = 0; attempt < 100 && !out.text().includes('got:hi'); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(out.text()).toBe('got:hi\n');
    await child.write(Buffer.from('quit\n'));
    await expect(child.exited).resolves.toMatchObject({ exitCode: 7 });
  }, 20_000);

  it('kill is idempotent and safe after the child already exited', async () => {
    const { child } = await persistent(ECHO_LOOP);
    await child.write(Buffer.from('quit\n'));
    await child.exited;
    await expect(child.kill()).resolves.toBeUndefined();
    await expect(child.kill()).resolves.toBeUndefined();
  }, 20_000);

  it('shutdown reaps a child nobody killed', async () => {
    const service = await freshExec(config);
    const out = collect();
    const child = await service.spawn({
      command: process.execPath,
      args: ['-e', ECHO_LOOP],
      cwd: dir,
      onStdout: out.sink,
      onStderr: out.sink,
    });
    await service.shutdown();
    // An orphan here keeps the whole worker process alive after the session
    // that started it is gone.
    await expect(
      Promise.race([
        child.exited.then(() => 'exited'),
        new Promise((resolve) => setTimeout(() => resolve('orphaned'), 5000)),
      ])
    ).resolves.toBe('exited');
  }, 20_000);

  it('refuses a disposed exec and a command with a relative path', async () => {
    const service = await freshExec(config);
    await expect(
      service.spawn({
        command: './relative/thing',
        args: [],
        cwd: dir,
        onStdout: () => undefined,
        onStderr: () => undefined,
      })
    ).rejects.toMatchObject({ code: 'invalid_host_request' });
    await service.shutdown();
    await expect(
      service.spawn({
        command: process.execPath,
        args: ['-e', ''],
        cwd: dir,
        onStdout: () => undefined,
        onStderr: () => undefined,
      })
    ).rejects.toMatchObject({ code: 'runtime_disposed' });
  }, 20_000);

  it('says so when the carrier cannot host a long-lived child', async () => {
    const adapterOnly: RuntimeHostConfig = {
      ...config,
      exec: {
        mode: 'host-adapter',
        adapter: {
          id: 'no-spawn-v1',
          run: async () => {
            throw new Error('not used');
          },
          dispose: async () => undefined,
        },
      },
    };
    const service = await freshExec(adapterOnly);
    // Stated, not emulated: a bridge that quietly fell back to one-shot calls
    // would look connected and lose every server-side session.
    await expect(
      service.spawn({
        command: process.execPath,
        args: ['-e', ''],
        cwd: dir,
        onStdout: () => undefined,
        onStderr: () => undefined,
      })
    ).rejects.toMatchObject({ code: 'exec_spawn_unsupported' });
  }, 20_000);
});
