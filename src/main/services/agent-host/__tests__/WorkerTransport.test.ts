import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { WorkerRpcRequest } from '@shared/types/workerRpc';
import type { UtilityProcess } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  createNodeProcessWorkerTransport,
  createUtilityProcessWorkerTransport,
} from '../WorkerTransport';

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 4321;
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}

const request: WorkerRpcRequest = {
  protocolVersion: 1,
  kind: 'request',
  generation: 1,
  requestId: 'rpc-1',
  type: 'ping',
  payload: {},
};

describe('createNodeProcessWorkerTransport', () => {
  it('round-trips RPC over real Node IPC and observes a clean disconnect exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-node-transport-'));
    const entry = join(dir, 'worker.cjs');
    writeFileSync(
      entry,
      `
      process.on('message', message => {
        process.stderr.write('node worker log');
        process.stdout.write('ordinary output is not RPC');
        process.send({ ...message, data: { nested: true } });
      });
      process.on('disconnect', () => process.exit(0));
    `
    );
    const child = fork(entry, [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const transport = createNodeProcessWorkerTransport(child);
    try {
      const stderr: string[] = [];
      transport.onStderr((text) => stderr.push(text));
      const received = new Promise((resolve, reject) => {
        transport.onMessage(resolve);
        transport.onError(reject);
      });
      transport.postMessage(request);
      expect(await received).toEqual({ ...request, data: { nested: true } });
      expect(transport.pid).toBe(child.pid);
      const exited = new Promise((resolve) => transport.onExit(resolve));
      child.disconnect();
      expect(await exited).toEqual({ code: 0, signal: null });
      expect(stderr.join('')).toBe('node worker log');
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createUtilityProcessWorkerTransport', () => {
  it('normalizes direct and MessageEvent-like worker messages', () => {
    const process = new FakeUtilityProcess();
    const transport = createUtilityProcessWorkerTransport(process as unknown as UtilityProcess);
    const received: unknown[] = [];
    transport.onMessage((message) => received.push(message));

    process.emit('message', { direct: true });
    process.emit('message', { data: { wrapped: true } });

    expect(received).toEqual([{ direct: true }, { wrapped: true }]);
  });

  it('forwards requests, stderr, fatal errors, and exit details', () => {
    const process = new FakeUtilityProcess();
    const transport = createUtilityProcessWorkerTransport(process as unknown as UtilityProcess);
    const stderr = vi.fn();
    const errors = vi.fn();
    const exits = vi.fn();
    transport.onStderr(stderr);
    transport.onError(errors);
    transport.onExit(exits);

    transport.postMessage(request);
    process.stderr.write('worker failed\n');
    process.emit('error', 'FatalError', 'worker.ts:10', 'diagnostic report');
    process.emit('exit', 17);

    expect(process.postMessage).toHaveBeenCalledWith(request);
    expect(stderr).toHaveBeenCalledWith('worker failed\n');
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'FatalError at worker.ts:10' })
    );
    expect(exits).toHaveBeenCalledWith({ code: 17, signal: null });
    expect(transport.pid).toBe(4321);
  });

  it('returns unsubscribe functions and makes kill best-effort', () => {
    const process = new FakeUtilityProcess();
    const transport = createUtilityProcessWorkerTransport(process as unknown as UtilityProcess);
    const received = vi.fn();
    const detach = transport.onMessage(received);

    detach();
    process.emit('message', { ignored: true });
    expect(received).not.toHaveBeenCalled();

    expect(transport.kill()).toBe(true);
    process.kill.mockImplementationOnce(() => {
      throw new Error('already exited');
    });
    expect(transport.kill()).toBe(false);
    expect(process.kill).toHaveBeenCalledTimes(2);
  });
});

/**
 * ARD D11 item 5 — the worker's ordinary stdout must be drained on BOTH
 * carriers. Until tsd-03 only the child_process one was, so under Electron a
 * third-party library that logs to stdout piled its output up in the worker
 * with no reader (main-host-04 is the other side of the same branch).
 */
describe('worker stdout is drained on both carriers', () => {
  const settle = () => new Promise((done) => setImmediate(done));

  it('leaves a utility process stdout flowing', async () => {
    const proc = new FakeUtilityProcess();
    expect(proc.stdout.readableFlowing).toBe(null);
    createUtilityProcessWorkerTransport(proc as unknown as UtilityProcess);
    expect(proc.stdout.readableFlowing).toBe(true);
    proc.stdout.write('a third-party library says hello');
    await settle();
    expect(proc.stdout.readableLength).toBe(0);
  });

  it('leaves a node child stdout flowing', async () => {
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      pid: 99,
    }) as unknown as ChildProcess;
    expect(stdout.readableFlowing).toBe(null);
    createNodeProcessWorkerTransport(proc);
    expect(stdout.readableFlowing).toBe(true);
    stdout.write('ordinary output is not RPC');
    await settle();
    expect(stdout.readableLength).toBe(0);
  });
});
