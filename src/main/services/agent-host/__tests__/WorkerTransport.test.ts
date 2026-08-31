import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { WorkerRpcRequest } from '@shared/types/workerRpc';
import type { UtilityProcess } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createUtilityProcessWorkerTransport } from '../WorkerTransport';

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 4321;
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
