/**
 * One virtual slot on the shared DSH host (dsh-rebase P1-3, decision 019).
 *
 * Implements the `WorkerTransport` a WorkerSlot already drives, over one
 * channel of the supervisor's single IPC link, so the slot's dispose and crash
 * paths stay as they are:
 *
 *   postMessage  sends `{ch, rpc}`
 *   kill()       asks the host to close this channel (`{host:'close', ch}`);
 *                never signals a process
 *   onExit       fires once: `closed` from the host gives
 *                `{code: 0, signal: null, cause: 'channel-closed'}`; the host
 *                process exiting gives its code and signal with
 *                `cause: 'host-exit'`, on every channel at once
 *   onStderr     never fires: the host's stderr belongs to the supervisor
 *
 * "The old process has exited" thus becomes "the host confirmed the channel
 * closed". A host that never confirms leaves the slot in `dispose-failed`,
 * which P1-3c escalates to a host restart.
 */

import type { DshChannelId } from '@shared/types/dshHostProtocol';
import type { WorkerRpcRequest } from '@shared/types/workerRpc';
import type { WorkerTransport, WorkerTransportExit } from './WorkerTransport';

/** The supervisor side of a channel. */
export interface DshChannelLink {
  /** Sends `{ch, rpc}`; throws when the host cannot take it. Async send failures go to `onError`. */
  send(ch: DshChannelId, rpc: WorkerRpcRequest, onError: (error: Error) => void): void;
  /** Sends `{host:'close', ch}` if the host is still reachable; its exit closes the channel otherwise. */
  close(ch: DshChannelId): void;
}

/** Thrown by `postMessage` once the channel is closing or gone. */
export const DSH_CHANNEL_CLOSED = 'DSH_CHANNEL_CLOSED';

function notify<T>(listeners: Iterable<(value: T) => void>, value: T, what: string): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      // One slot's listener must not keep the rest of the host's channels from hearing it.
      console.error(`[dsh-channel] ${what} listener threw`, error);
    }
  }
}

export class DshChannelTransport implements WorkerTransport {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly exitListeners = new Set<(exit: WorkerTransportExit) => void>();
  private exitInfo: WorkerTransportExit | null = null;
  private closeRequested = false;

  constructor(
    readonly ch: DshChannelId,
    private readonly hostPid: number | undefined,
    private readonly link: DshChannelLink
  ) {}

  /** The shared host's pid; diagnostics only, never a kill target. */
  get pid(): number | undefined {
    return this.hostPid;
  }

  get exited(): boolean {
    return this.exitInfo !== null;
  }

  postMessage(message: WorkerRpcRequest): void {
    if (this.exitInfo || this.closeRequested) {
      throw new Error(
        `${DSH_CHANNEL_CLOSED}: DSH channel ${this.ch} is ${this.exitInfo ? 'closed' : 'closing'}`
      );
    }
    this.link.send(this.ch, message, (error) => this.dispatchError(error));
  }

  onMessage(listener: (message: unknown) => void): () => void {
    if (this.exitInfo) return () => {};
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    if (this.exitInfo) return () => {};
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** A listener added after the exit still hears it once, on a microtask. */
  onExit(listener: (exit: WorkerTransportExit) => void): () => void {
    const exit = this.exitInfo;
    if (exit) {
      let active = true;
      queueMicrotask(() => {
        if (active) notify([listener], exit, 'exit');
      });
      return () => {
        active = false;
      };
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onStderr(_listener: (chunk: string) => void): () => void {
    return () => {};
  }

  /** Requests the close once; the exit arrives with `closed` or with the host's own exit. */
  kill(): boolean {
    if (this.exitInfo) return true;
    if (!this.closeRequested) {
      this.closeRequested = true;
      this.link.close(this.ch);
    }
    return true;
  }

  // ---- supervisor side ------------------------------------------------------

  /** A worker RPC response or event the host addressed to this channel. */
  dispatchMessage(rpc: unknown): void {
    if (this.exitInfo) return;
    notify([...this.messageListeners], rpc, 'message');
  }

  dispatchError(error: Error): void {
    if (this.exitInfo) return;
    notify([...this.errorListeners], error, 'error');
  }

  /** Ends the channel exactly once and drops every listener. */
  dispatchExit(exit: WorkerTransportExit): void {
    if (this.exitInfo) return;
    this.exitInfo = exit;
    const listeners = [...this.exitListeners];
    this.messageListeners.clear();
    this.errorListeners.clear();
    this.exitListeners.clear();
    notify(listeners, exit, 'exit');
  }
}
