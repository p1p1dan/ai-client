import type { WorkerRpcRequest } from '@shared/types/workerRpc';

/**
 * The carrier a `WorkerSlot` talks RPC over. Since dsh-rebase P1-12 step 1
 * (decision 147) the only implementation is a channel on the shared DSH host
 * (`DshChannelTransport.ts`); the native worker's process carriers are gone.
 */

/**
 * Why a shared-host channel ended: the host confirmed the channel closed, or
 * the whole host process exited and took every channel with it. Optional so
 * test transports can leave it unset.
 */
export type WorkerTransportExitCause = 'channel-closed' | 'host-exit';

export interface WorkerTransportExit {
  code: number | null;
  signal: string | null;
  cause?: WorkerTransportExitCause;
}

export interface WorkerTransport {
  readonly pid: number | undefined;
  /** The shared DSH host channel this transport is. */
  readonly channelId?: string;
  postMessage(message: WorkerRpcRequest): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onExit(listener: (exit: WorkerTransportExit) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  kill(): boolean;
}
