/**
 * One DSH host process as Main's DshHostSupervisor sees it: channel envelopes
 * around our worker RPC in both directions (src/shared/types/dshHostProtocol.ts),
 * host control messages beside them. Shared by tools/bridge-smoke.ts and
 * tools/bridge-record.ts; it only ever talks to a ChildProcess the caller spawned.
 */

import type { ChildProcess } from 'node:child_process';

export type Message = Record<string, unknown>;

export function isRecord(value: unknown): value is Message {
  return typeof value === 'object' && value !== null;
}

export class HostClient {
  private requestSeq = 0;
  private channelSeq = 0;
  private readonly eventsByChannel = new Map<string, Message[]>();
  /** Messages that are not channel envelopes: ready, pong, closed, stopped, fatal, probe replies. */
  readonly controls: Message[] = [];
  /** `response:<requestId>` and `closed` per channel, in arrival order. */
  readonly arrivals: Array<{ ch: string; what: string }> = [];
  private readonly waiters = new Set<() => void>();
  private readonly child: ChildProcess;
  private readonly generation: number;
  private readonly prefix: string;

  constructor(child: ChildProcess, options: { generation?: number; requestPrefix?: string } = {}) {
    this.child = child;
    this.generation = options.generation ?? 1;
    this.prefix = options.requestPrefix ?? 'smoke';
    child.on('message', (message: unknown) => {
      if (!isRecord(message)) return;
      if (typeof message.ch === 'string' && isRecord(message.rpc)) {
        const rpc = message.rpc;
        if (rpc.kind === 'event' && rpc.type === 'runtime.event') {
          this.events(message.ch).push(rpc.payload as Message);
        } else if (rpc.kind === 'response') {
          this.arrivals.push({ ch: message.ch, what: `response:${String(rpc.requestId)}` });
        }
      } else {
        this.controls.push(message);
        if (message.host === 'closed')
          this.arrivals.push({ ch: String(message.ch), what: 'closed' });
      }
      for (const wake of [...this.waiters]) wake();
    });
  }

  /** A fresh channel id: `c<host generation>-<sequence>`, never reused. */
  openChannel(): string {
    this.channelSeq += 1;
    return `c${this.generation}-${this.channelSeq}`;
  }

  events(ch: string): Message[] {
    let list = this.eventsByChannel.get(ch);
    if (!list) {
      list = [];
      this.eventsByChannel.set(ch, list);
    }
    return list;
  }

  send(message: Message): void {
    this.child.send(message);
  }

  /** One RPC on a channel, answered with the raw worker RPC response (ok or not). */
  call(ch: string, type: string, payload: Message, timeoutMs = 60_000): Promise<Message> {
    const requestId = `${this.prefix}-${++this.requestSeq}`;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.child.off('message', onMessage);
        fail(new Error(`${type} on ${ch} timed out`));
      }, timeoutMs);
      const onMessage = (message: unknown) => {
        if (!isRecord(message) || message.ch !== ch || !isRecord(message.rpc)) return;
        const rpc = message.rpc;
        if (rpc.kind !== 'response' || rpc.requestId !== requestId) return;
        clearTimeout(timer);
        this.child.off('message', onMessage);
        done(rpc);
      };
      this.child.on('message', onMessage);
      this.child.send({
        ch,
        rpc: {
          protocolVersion: 1,
          kind: 'request',
          generation: this.generation,
          requestId,
          type,
          payload,
        },
      });
    });
  }

  async request(ch: string, type: string, payload: Message, timeoutMs = 60_000): Promise<Message> {
    const record = await this.call(ch, type, payload, timeoutMs);
    if (record.ok) return record.result as Message;
    throw new Error(`${type}: ${JSON.stringify(record.error)}`);
  }

  /**
   * One operation of the test-only measurement row (tools/probe-bundle
   * `aiclient-probe-measure`), answered on the same IPC channel.
   */
  async probe(op: string, payload: Message = {}, timeoutMs = 60_000): Promise<Message> {
    const requestId = `${this.prefix}-p06-${++this.requestSeq}`;
    this.child.send({ p06: op, requestId, ...payload });
    const reply = await this.control(
      (message) => message.p06Reply === op && message.requestId === requestId,
      timeoutMs
    );
    if (!reply) throw new Error(`probe ${op} timed out`);
    if (reply.error) throw new Error(`probe ${op}: ${String(reply.error)}`);
    return reply;
  }

  /** Resolve once `predicate` holds over the channel's events so far. */
  until(
    ch: string,
    predicate: (events: Message[]) => boolean,
    timeoutMs: number
  ): Promise<boolean> {
    return this.wait(() => predicate(this.events(ch)), timeoutMs);
  }

  /** The first control message matching `predicate`, waiting up to `timeoutMs`. */
  async control(predicate: (message: Message) => boolean, timeoutMs: number) {
    const found = () => this.controls.find(predicate);
    await this.wait(() => found() !== undefined, timeoutMs);
    return found();
  }

  private wait(check: () => boolean, timeoutMs: number): Promise<boolean> {
    if (check()) return Promise.resolve(true);
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        done(false);
      }, timeoutMs);
      const wake = () => {
        if (!check()) return;
        clearTimeout(timer);
        this.waiters.delete(wake);
        done(true);
      };
      this.waiters.add(wake);
    });
  }
}
