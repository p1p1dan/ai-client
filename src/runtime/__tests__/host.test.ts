import type { spawn } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from 'cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeExecRequest, RuntimeHostConfig } from '../contracts.ts';
import { standaloneHost, validateHost } from '../host/config.ts';
import {
  createTreeKiller,
  ExecPlugin,
  execRunnerPath,
  resolveWindowsCommand,
  runPipe,
  spawnPersistent,
} from '../host/exec.ts';
import { HostIoPlugin } from '../host/io.ts';

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
function caught(work: () => unknown): unknown {
  try {
    work();
    return undefined;
  } catch (error) {
    return error;
  }
}

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
  it('reads plaintext through a helper whose Node greets stderr (core-host-05)', async () => {
    const encrypted = join(dir, 'encrypted');
    await writeFile(encrypted, '%TSD-Header-###%opaque');
    const maxBytes = 64;
    // Enough plaintext to fill the helper's whole window, which is the case the
    // shared budget used to lose: a full stdout plus any stderr overflowed it.
    let script = `process.stderr.write('w'.repeat(8192));process.stdout.write('p'.repeat(${maxBytes + 1}))`;
    const seen: RuntimeExecRequest[] = [];
    const alternate = new Context();
    const noisy: RuntimeHostConfig = {
      ...config,
      tsdReadFallback: 'configured-node',
      exec: {
        mode: 'host-adapter',
        adapter: {
          id: 'tsd-noisy-fixture-v1',
          dispose: async () => {},
          // Stands in for the bundled Node of an encrypted box: the real pipe
          // collection and the budgets HostIo asked for, but a startup that
          // prints warnings (NODE_OPTIONS, an injected preload) before the
          // plaintext. The real helper cannot be exercised here — it refuses a
          // file whose header is still TSD.
          run: (request) => {
            seen.push(request);
            return exec.run({ ...request, command: process.execPath, args: ['-e', script] });
          },
        },
      },
    };
    await alternate.plugin(ExecPlugin, noisy);
    const fiber = await alternate.plugin(HostIoPlugin, noisy);
    await fiber.await();
    try {
      const data = await alternate.runtimeHostIo.readFile(encrypted, {
        maxBytes,
        overflow: 'truncate',
      });
      expect(data.source).toBe('node-fallback');
      expect(text(data.bytes)).toBe('p'.repeat(maxBytes));
      expect(data.truncated).toBe(true);
      expect(seen[0]?.maxOutputBytes).toBe(maxBytes + 1);
      expect(seen[0]?.maxStderrBytes).toBeGreaterThan(0);
      // A helper that genuinely fails still reads as an unreadable file.
      script = "process.stderr.write('driver refused');process.exitCode=1";
      await expect(
        alternate.runtimeHostIo.readFile(encrypted, { maxBytes, overflow: 'truncate' })
      ).rejects.toMatchObject({ code: 'io_tsd_unreadable' });
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
  /** T008 added `rmdir` for interrupted-import cleanup without covering it. */
  it('removes an empty directory and refuses one that still has entries', async () => {
    const empty = join(dir, 'empty');
    await io.mkdir(empty);
    await io.rmdir(empty);
    await expect(io.stat(empty)).rejects.toMatchObject({ code: 'ENOENT' });
    const staging = join(dir, 'staging');
    await io.mkdir(staging);
    await io.writeFile(join(staging, 'leftover.jsonl'), Buffer.from('{}'));
    await expect(io.rmdir(staging)).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    expect(await io.stat(staging)).toMatchObject({ kind: 'directory' });
    await expect(io.rmdir(join(dir, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(io.rmdir('staging')).rejects.toMatchObject({ code: 'invalid_host_request' });
    await io.shutdown();
    await expect(io.rmdir(staging)).rejects.toMatchObject({ code: 'runtime_disposed' });
  });
  it('rejects a relative path instead of throwing out of the call', async () => {
    const seen: unknown[] = [];
    const settle = (work: Promise<unknown>) => {
      void work.catch((error: unknown) => seen.push(error));
    };
    // Built with `.catch` rather than `await` on purpose: a synchronous throw
    // escapes a batch like this one and surfaces far from its cause.
    expect(
      caught(() => {
        settle(io.readFile('a', { maxBytes: 1, overflow: 'error' }));
        settle(io.writeFile('a', Buffer.from('x')));
        settle(io.appendFile('a', Buffer.from('x')));
        settle(io.stat('a'));
        settle(io.realpath('a'));
        settle(io.mkdir('a'));
        settle(io.unlink('a'));
        settle(io.rmdir('a'));
        settle(io.rename(join(dir, 'from'), 'to'));
      })
    ).toBeUndefined();
    await sleep(0);
    expect(seen).toHaveLength(9);
    expect(seen.map((error) => (error as { code: string }).code)).toEqual(
      Array(9).fill('invalid_host_request')
    );
  });
  it('reports a bad directory path at the call, not at the first pull', async () => {
    expect(caught(() => io.readDirectory('relative'))).toMatchObject({
      code: 'invalid_host_request',
    });
    await io.shutdown();
    expect(caught(() => io.readDirectory(dir))).toMatchObject({ code: 'runtime_disposed' });
  });
  it('shuts down while a directory iteration is parked on a yield', async () => {
    await io.writeFile(join(dir, 'a'), Buffer.from('x'));
    const iterator = io.readDirectory(dir)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ name: 'a' });
    // Shutdown waits for the read in flight, never for a consumer that stopped
    // pulling: tracking the whole iteration would park teardown forever.
    await expect(
      Promise.race([io.shutdown().then(() => 'done'), sleep(2000).then(() => 'hung')])
    ).resolves.toBe('done');
    await expect(iterator.next()).rejects.toMatchObject({ code: 'runtime_disposed' });
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
  it('spends a dedicated stderr budget instead of the stdout quota (core-host-05)', async () => {
    // stderr first, and far past its own window: a child that greets the run
    // with warnings must not cost the byte-exact stdout protocol a single byte.
    const result = await command(
      "process.stderr.write('y'.repeat(8192));process.stdout.write('x'.repeat(32))",
      { maxOutputBytes: 32, maxStderrBytes: 4096, overflow: 'terminate' }
    );
    expect(result.termination).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
    expect(text(result.stdout)).toBe('x'.repeat(32));
    expect(result.stderr.length).toBe(4096);
    expect(result.stderrBytes).toBe(8192);
    await expect(command('', { maxStderrBytes: 0 })).rejects.toMatchObject({
      code: 'invalid_host_request',
    });
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
  it('cancels a command that is already running and stops its tree', async () => {
    const controller = new AbortController();
    const marker = join(dir, 'tick');
    const script = `const fs=require('fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},String(Date.now())),10)`;
    const work = command(script, { signal: controller.signal, timeoutMs: 5000 });
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt++) await sleep(10);
    expect(existsSync(marker)).toBe(true);
    controller.abort();
    expect((await work).termination).toBe('aborted');
    const last = await readFile(marker, 'utf8');
    await sleep(150);
    // Cancelling the run has to stop the tree, not just stop reading from it.
    expect(await readFile(marker, 'utf8')).toBe(last);
  }, 20_000);
  it('resolves the runner helper once and reuses it for every later command', async () => {
    expect((await command("process.stdout.write('ok')")).exitCode).toBe(0);
    // The command above resolved the helper; the production path shares this
    // cache, so nothing may probe the filesystem for it a second time.
    expect(
      execRunnerPath(() => {
        throw new Error('probed again');
      })
    ).toContain('exec-runner.mjs');
    vi.resetModules();
    const fresh = await import('../host/exec.ts');
    const probed: string[] = [];
    const exists = (path: string) => {
      probed.push(path);
      return existsSync(path);
    };
    expect(fresh.execRunnerPath(exists)).toContain('exec-runner.mjs');
    expect(fresh.execRunnerPath(exists)).toContain('exec-runner.mjs');
    expect(probed).toHaveLength(1);
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

  async function persistent(script: string, hostConfig = config, signal?: AbortSignal) {
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
      ...(signal ? { signal } : {}),
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
      // Swallowed here only: a case that asserts on a cleanup failure would
      // otherwise fail again in teardown, where `shutdown` replays it.
      await entry.exec.shutdown().catch(() => undefined);
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

  it('kills a long-lived child when the caller aborts mid-run', async () => {
    const controller = new AbortController();
    const { child } = await persistent(ECHO_LOOP, config, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort();
    await expect(
      Promise.race([child.exited.then(() => 'exited'), sleep(5000).then(() => 'orphaned')])
    ).resolves.toBe('exited');
  }, 20_000);

  it('drops the abort listener once the child is gone', async () => {
    const controller = new AbortController();
    const { child } = await persistent(ECHO_LOOP, config, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    await child.write(Buffer.from('quit\n'));
    await child.exited;
    await sleep(0);
    // A session-lived signal would otherwise keep one listener — and one dead
    // child's closure — per server restart.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  }, 20_000);

  it('does not lose a child that finishes starting during shutdown', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let killed = 0;
    const late: RuntimeHostConfig = {
      ...config,
      exec: {
        mode: 'host-adapter',
        adapter: {
          id: 'late-spawn-v1',
          run: async () => {
            throw new Error('not used');
          },
          dispose: async () => undefined,
          spawn: async () => {
            await gate;
            return {
              exited: new Promise<{ exitCode: number | null; signal: string | null }>(
                () => undefined
              ),
              write: async () => undefined,
              kill: async () => {
                killed++;
              },
            };
          },
        },
      },
    };
    const service = await freshExec(late);
    const pending = service.spawn({
      command: process.execPath,
      args: ['-e', ''],
      cwd: dir,
      onStdout: () => undefined,
      onStderr: () => undefined,
    });
    // `stop` snapshots the tracked children; one that lands after the snapshot
    // is in a set nobody reads again, so it has to be reaped on the spot.
    await service.shutdown();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'runtime_disposed' });
    expect(killed).toBe(1);
  }, 20_000);

  it('reports a child that outlived the kill grace instead of claiming it exited', async () => {
    const impatient: RuntimeHostConfig = { ...config, cleanupTimeoutMs: 1 };
    const service = await freshExec(impatient);
    const out = collect();
    const child = await service.spawn({
      command: process.execPath,
      args: [
        '-e',
        "process.on('SIGTERM',()=>{});process.stdout.write('armed');setInterval(()=>{},1000)",
      ],
      cwd: dir,
      onStdout: out.sink,
      onStderr: out.sink,
    });
    // `spawn` resolves when the process exists, not when its script has run:
    // a SIGTERM that lands before the handler is installed kills the child by
    // default action, and the grace never runs out. Wait for the handler.
    for (let attempt = 0; attempt < 250 && !out.text().includes('armed'); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(out.text()).toContain('armed');
    // Nobody killed it first: reaping a long-lived child is what shutdown is
    // for, and a tree still unaccounted for when the grace runs out must be
    // reported, not counted as collected.
    await expect(service.shutdown()).rejects.toMatchObject({ code: 'exec_cleanup_failed' });
    await expect(child.kill()).rejects.toMatchObject({ code: 'exec_cleanup_failed' });
    // `exited` still settles, or every caller waiting on the server is parked.
    await expect(child.exited).resolves.toMatchObject({ exitCode: null, signal: null });
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

/**
 * The Windows half of process-tree cleanup, on a machine that is not Windows.
 *
 * `taskkill` is the only way a tree dies there, and the long-lived path never
 * ran on Windows at all: `spawn` support landed after the last field session.
 * So the platform and the spawner are injected, and the cases pin the three
 * properties the one-shot path already had — one taskkill per child, every
 * taskkill tracked, and its failure recorded rather than dropped.
 */
describe('exec tree killer', () => {
  function fakeSpawner() {
    const calls: { command: string; args: readonly string[] }[] = [];
    const started: {
      emit: (event: string, value?: unknown) => void;
      killed: number;
    }[] = [];
    const spawnProcess = ((command: string, args: readonly string[]) => {
      calls.push({ command, args });
      const handlers = new Map<string, (value?: unknown) => void>();
      const entry = {
        emit: (event: string, value?: unknown) => handlers.get(event)?.(value),
        killed: 0,
      };
      started.push(entry);
      const child = {
        on(event: string, handler: (value?: unknown) => void) {
          handlers.set(event, handler);
          return child;
        },
        kill() {
          entry.killed++;
          return true;
        },
      };
      return child;
    }) as unknown as typeof spawn;
    return { calls, started, spawnProcess };
  }
  function fakeChild() {
    const signals: (string | number | undefined)[] = [];
    return {
      pid: 4242,
      signals,
      kill(signal?: string | number) {
        signals.push(signal);
        return true;
      },
    };
  }

  it('starts one taskkill per child however often kill is called', () => {
    const spawner = fakeSpawner();
    const killer = createTreeKiller(fakeChild(), {
      platform: 'win32',
      spawnProcess: spawner.spawnProcess,
    });
    killer.kill(false);
    killer.kill(true);
    killer.kill(true);
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0].command.endsWith('taskkill.exe')).toBe(true);
    expect(spawner.calls[0].args).toEqual(['/PID', '4242', '/T', '/F']);
    expect(killer.error).toBeUndefined();
  });

  it('records a taskkill that could not start, and falls back to the child', () => {
    const spawner = fakeSpawner();
    const child = fakeChild();
    const killer = createTreeKiller(child, {
      platform: 'win32',
      spawnProcess: spawner.spawnProcess,
    });
    killer.kill(true);
    spawner.started[0].emit('error', new Error('EPERM'));
    expect(killer.error).toMatchObject({ code: 'exec_cleanup_failed' });
    expect(child.signals).toHaveLength(1);
  });

  it('records a nonzero taskkill exit and accepts a clean one', () => {
    const failing = fakeSpawner();
    const failed = createTreeKiller(fakeChild(), {
      platform: 'win32',
      spawnProcess: failing.spawnProcess,
    });
    failed.kill(true);
    failing.started[0].emit('close', 1);
    expect(failed.error).toMatchObject({ code: 'exec_cleanup_failed' });
    expect((failed.error as Error).message).toContain('1');
    const clean = fakeSpawner();
    const reaped = createTreeKiller(fakeChild(), {
      platform: 'win32',
      spawnProcess: clean.spawnProcess,
    });
    reaped.kill(true);
    clean.started[0].emit('close', 0);
    expect(reaped.error).toBeUndefined();
  });

  it('reaps a taskkill still running at dispose without calling that a failure', () => {
    const spawner = fakeSpawner();
    const killer = createTreeKiller(fakeChild(), {
      platform: 'win32',
      spawnProcess: spawner.spawnProcess,
    });
    killer.kill(true);
    killer.dispose();
    expect(spawner.started[0].killed).toBe(1);
    spawner.started[0].emit('close', null);
    expect(killer.error).toBeUndefined();
  });

  it('reports a POSIX group that could not be signalled', () => {
    // Never signal a real process from here. `process.kill(-1, …)` broadcasts
    // to every process this user owns, and a fake pid can collide with a live
    // group; the group signal is injected so the failure paths are exercised
    // against a stub only.
    const errno = (code: string) => Object.assign(new Error(code), { code });
    const sent: { pgid: number; signal: string }[] = [];
    const child = fakeChild();
    const denied = createTreeKiller(child, {
      platform: 'linux',
      killGroup: (pgid, signal) => {
        sent.push({ pgid, signal });
        throw errno('EPERM');
      },
    });
    denied.kill(true);
    expect(sent).toEqual([{ pgid: -4242, signal: 'SIGKILL' }]);
    expect(denied.error).toMatchObject({ code: 'exec_cleanup_failed' });
    // The child itself is still signalled directly as the fallback.
    expect(child.signals).toEqual(['SIGKILL']);

    // A tree that is already gone is the expected second kill, not a failure.
    const gone = createTreeKiller(fakeChild(), {
      platform: 'linux',
      killGroup: () => {
        throw errno('ESRCH');
      },
    });
    gone.kill(true);
    expect(gone.error).toBeUndefined();

    // A group that accepted the signal is clean, and escalates on repeat.
    const signals: string[] = [];
    const clean = createTreeKiller(fakeChild(), {
      platform: 'linux',
      killGroup: (_pgid, signal) => {
        signals.push(signal);
      },
    });
    clean.kill(false);
    clean.kill(true);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(clean.error).toBeUndefined();
  });

  it('never sends a group signal from the tests in this file', () => {
    // Guard against a regression of the pid-1 incident: with no `killGroup`
    // injected, the default reaches `process.kill`, so a stub must be installed
    // before any tree killer here is exercised on a fake pid.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      createTreeKiller(fakeChild(), { platform: 'linux' }).kill(true);
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });
});

/**
 * The Windows carrier, on a machine that is not Windows (T039).
 *
 * Both halves here are Windows-only by construction: every command there runs
 * through the node runner and is reaped by an external `taskkill.exe`, and a
 * bare `npx` is really `npx.cmd`. The platform, the spawner and the file
 * existence check are injected; no real process is spawned and no real signal
 * is ever sent — the POSIX cases pass their own `killGroup`, per appendix B1.
 */
describe('windows carrier', () => {
  function fakeStream() {
    const stream = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      end: (value?: unknown) => void;
      write: (value?: unknown, callback?: (error: Error | null) => void) => boolean;
      destroyed: boolean;
    };
    stream.destroyed = false;
    stream.destroy = () => {
      stream.destroyed = true;
    };
    stream.end = () => undefined;
    stream.write = (_value, callback) => {
      callback?.(null);
      return true;
    };
    return stream;
  }
  interface Reaper {
    args: readonly string[];
    killed: number;
    emit: (event: string, value?: unknown) => void;
  }
  function stage() {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: ReturnType<typeof fakeStream>;
      stderr: ReturnType<typeof fakeStream>;
      stdin: ReturnType<typeof fakeStream>;
      kill: (signal?: string) => boolean;
      send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
      signals: (string | undefined)[];
      sent: { command: string; args: readonly string[] }[];
    };
    child.pid = 4242;
    child.stdout = fakeStream();
    child.stderr = fakeStream();
    child.stdin = fakeStream();
    child.signals = [];
    child.sent = [];
    child.kill = (signal?: string) => {
      child.signals.push(signal);
      return true;
    };
    child.send = (message, callback) => {
      child.sent.push(message as { command: string; args: readonly string[] });
      callback?.(null);
      return true;
    };
    const started: { command: string; args: readonly string[] }[] = [];
    const reapers: Reaper[] = [];
    const spawnProcess = ((command: string, args: readonly string[]) => {
      started.push({ command, args });
      // The first spawn is the carrier itself; everything after it is a reaper.
      if (started.length === 1) return child;
      const handlers = new Map<string, (value?: unknown) => void>();
      const reaper: Reaper = {
        args,
        killed: 0,
        emit: (event, value) => handlers.get(event)?.(value),
      };
      reapers.push(reaper);
      const process = {
        on(event: string, handler: (value?: unknown) => void) {
          handlers.set(event, handler);
          return process;
        },
        kill() {
          reaper.killed++;
          return true;
        },
      };
      return process;
    }) as unknown as typeof spawn;
    return { child, started, reapers, spawnProcess };
  }
  const request = {
    command: 'C:\\Program Files\\Git\\bin\\bash.exe',
    args: ['-c', 'git status'],
    cwd: 'C:\\work',
    env: { Path: 'C:\\Windows\\System32' },
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    overflow: 'truncate' as const,
  };

  it('reports a command that already finished when taskkill will not come back (windows-02)', async () => {
    const carrier = stage();
    // 30 ms stands in for the product's 2 s cleanup budget.
    const run = runPipe(request, 30, 'C:\\node.exe', {
      platform: 'win32',
      spawnProcess: carrier.spawnProcess,
    });
    carrier.child.stdout.emit('data', Buffer.from('on branch main'));
    // The runner reports the command's own exit over IPC; the runner itself
    // stays up until taskkill reaches it, which here it never does.
    carrier.child.emit('message', { type: 'exit', code: 0, signal: null });
    expect(carrier.reapers).toHaveLength(1);
    expect(carrier.reapers[0].args).toEqual(['/PID', '4242', '/T', '/F']);
    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString('utf8')).toBe('on branch main');
    expect(result.cleanupError).toContain('not confirmed terminated');
    // The reaper we gave up on is reaped rather than left running.
    expect(carrier.reapers[0].killed).toBe(1);
  });

  it('reports a command whose taskkill could not start at all (windows-02)', async () => {
    const carrier = stage();
    const run = runPipe(request, 5_000, 'C:\\node.exe', {
      platform: 'win32',
      spawnProcess: carrier.spawnProcess,
    });
    carrier.child.emit('message', { type: 'exit', code: 3, signal: null });
    carrier.reapers[0].emit('error', new Error('EPERM'));
    // taskkill failing makes the tree killer signal the leader directly, and
    // that is what ends the run.
    expect(carrier.child.signals).toHaveLength(1);
    carrier.child.emit('close', null, null);
    const result = await run;
    expect(result.exitCode).toBe(3);
    expect(result.cleanupError).toContain('taskkill could not start');
  });

  it('still fails a run whose command never reported an outcome', async () => {
    const carrier = stage();
    const run = runPipe({ ...request, timeoutMs: 20 }, 20, 'C:\\node.exe', {
      platform: 'win32',
      spawnProcess: carrier.spawnProcess,
    });
    // No IPC exit and no close: the command is unaccounted for, so the cleanup
    // deadline is still a failure.
    await expect(run).rejects.toMatchObject({ code: 'exec_cleanup_failed' });
  });

  it('leaves the POSIX path signalling the injected group only', async () => {
    const clean = stage();
    const sent: { pgid: number; signal: string }[] = [];
    const run = runPipe(request, 50, undefined, {
      platform: 'linux',
      spawnProcess: clean.spawnProcess,
      killGroup: (pgid, signal) => {
        sent.push({ pgid, signal });
      },
    });
    clean.child.stdout.emit('data', Buffer.from('ok'));
    clean.child.emit('close', 0, null);
    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.cleanupError).toBeUndefined();
    expect(sent).toEqual([{ pgid: -4242, signal: 'SIGKILL' }]);
    expect(clean.reapers).toHaveLength(0);

    // A group we could not signal is recorded, not turned into the run's
    // failure: the command exited and its output is complete.
    const denied = stage();
    const second = runPipe(request, 50, undefined, {
      platform: 'linux',
      spawnProcess: denied.spawnProcess,
      killGroup: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
    });
    denied.child.emit('close', 0, null);
    await expect(second).resolves.toMatchObject({
      exitCode: 0,
      cleanupError: expect.stringContaining('could not terminate child group'),
    });
  });

  it('starts npx and friends through cmd.exe, not as a missing .exe (windows-03)', () => {
    const env = { Path: 'C:\\npm;C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    // npm writes `npx.cmd` while `PATHEXT` is upper-case, and the Windows file
    // system does not care — so the probe matches case-insensitively here too,
    // and the resolved name carries the casing the lookup used.
    const present = new Set(['c:\\npm\\npx.cmd', 'c:\\npm\\node.exe', 'c:\\tools\\uvx.exe']);
    const exists = (path: string) => present.has(path.toLowerCase());
    const npx = resolveWindowsCommand('npx', ['-y', 'server'], env, {
      platform: 'win32',
      exists,
    });
    expect(npx.command.toLowerCase().endsWith('cmd.exe')).toBe(true);
    expect(npx.args).toEqual(['/d', '/s', '/c', 'C:\\npm\\npx.CMD', '-y', 'server']);
    // A real executable is used as it is — no shell, no re-quoting.
    expect(resolveWindowsCommand('node', ['x.js'], env, { platform: 'win32', exists })).toEqual({
      command: 'C:\\npm\\node.EXE',
      args: ['x.js'],
    });
    // An absolute .cmd (what a user writes after hitting the bare-name failure)
    // is wrapped too, rather than being rejected by node outright.
    expect(
      resolveWindowsCommand('C:\\npm\\npx.cmd', [], env, { platform: 'win32', exists }).args
    ).toEqual(['/d', '/s', '/c', 'C:\\npm\\npx.cmd']);
    // Nothing on PATH: unchanged, so the spawn failure still names the command.
    expect(resolveWindowsCommand('uvx', [], env, { platform: 'win32', exists })).toEqual({
      command: 'uvx',
      args: [],
    });
    // POSIX never rewrites anything.
    expect(
      resolveWindowsCommand('npx', ['-y'], { PATH: '/usr/bin' }, { platform: 'linux', exists })
    ).toEqual({ command: 'npx', args: ['-y'] });
  });

  it('sends the resolved command to the runner for a long-lived child (windows-03)', async () => {
    const carrier = stage();
    const handle = await spawnPersistent(
      {
        command: 'npx',
        args: ['-y', 'server'],
        cwd: 'C:\\work',
        env: { Path: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        onStdout: () => undefined,
        onStderr: () => undefined,
      },
      1_000,
      'C:\\node.exe',
      {
        platform: 'win32',
        spawnProcess: carrier.spawnProcess,
        exists: (path) => path.toLowerCase() === 'c:\\npm\\npx.cmd',
      }
    );
    expect(handle).toBeDefined();
    expect(carrier.child.sent).toHaveLength(1);
    expect(carrier.child.sent[0].command.toLowerCase().endsWith('cmd.exe')).toBe(true);
    expect(carrier.child.sent[0].args).toEqual([
      '/d',
      '/s',
      '/c',
      'C:\\npm\\npx.CMD',
      '-y',
      'server',
    ]);
  });
});
