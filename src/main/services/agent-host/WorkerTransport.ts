import type { Readable } from 'node:stream';
import type { WorkerRpcRequest } from '@shared/types/workerRpc';
import type { UtilityProcess } from 'electron';

export interface WorkerTransportExit {
  code: number | null;
  signal: string | null;
}

export interface WorkerTransport {
  readonly pid: number | undefined;
  postMessage(message: WorkerRpcRequest): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onExit(listener: (exit: WorkerTransportExit) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  kill(): boolean;
}

function normalizeUtilityMessage(message: unknown): unknown {
  if (
    typeof message === 'object' &&
    message !== null &&
    !('protocolVersion' in message) &&
    'data' in message
  ) {
    return (message as { data?: unknown }).data;
  }
  return message;
}

function subscribeReadable(
  stream: NodeJS.ReadableStream | null,
  listener: (chunk: string) => void
): () => void {
  if (!stream) return () => {};
  const readable = stream as Readable;
  const onData = (chunk: Buffer | string) => listener(chunk.toString());
  const onError = () => {};
  readable.on('data', onData);
  readable.on('error', onError);
  return () => {
    readable.off('data', onData);
    readable.off('error', onError);
  };
}

/**
 * Electron utilityProcess adapter for one WorkerSlot generation.
 *
 * Electron has shipped both direct payload and MessageEvent-like `{ data }`
 * delivery shapes. Normalize both here so the slot lifecycle never depends on
 * that implementation detail.
 */
export function createUtilityProcessWorkerTransport(proc: UtilityProcess): WorkerTransport {
  return {
    get pid() {
      return proc.pid;
    },
    postMessage(message) {
      proc.postMessage(message);
    },
    onMessage(listener) {
      const onMessage = (message: unknown) => listener(normalizeUtilityMessage(message));
      proc.on('message', onMessage);
      return () => proc.off('message', onMessage);
    },
    onError(listener) {
      const onError = (type: 'FatalError', location: string, _report: string) => {
        const detail = location ? `${type} at ${location}` : type;
        listener(new Error(detail || 'Worker utility process error'));
      };
      proc.on('error', onError);
      return () => proc.off('error', onError);
    },
    onExit(listener) {
      const onExit = (code: number) => listener({ code, signal: null });
      proc.on('exit', onExit);
      return () => proc.off('exit', onExit);
    },
    onStderr(listener) {
      return subscribeReadable(proc.stderr, listener);
    },
    kill() {
      try {
        return proc.kill();
      } catch {
        // The process may already have exited. The slot still waits for exit.
        return false;
      }
    },
  };
}
