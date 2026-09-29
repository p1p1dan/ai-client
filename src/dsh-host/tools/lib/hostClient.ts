/**
 * One DSH host process as Main's DshHostSupervisor sees it: channel envelopes
 * around our worker RPC in both directions (src/shared/types/dshHostProtocol.ts),
 * host control messages beside them. Shared by tools/bridge-smoke.ts and
 * tools/bridge-record.ts; it only ever talks to a ChildProcess the caller spawned.
 *
 * P1-5 (decisions 033, 034): a host composes nothing before Main's model plan,
 * and asks Main for a key on every model request. `fakeGatewayPlan` builds a
 * plan with one route to the local fake gateway, through the product's own
 * translation (`buildDshModelPlan`), and `serveModelPlan` plays Main: it sends
 * `configure` and answers `credential` requests with a fake key.
 */

import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buildDshModelPlan } from '../../../shared/dshModelPlan/build.ts';
import type {
  DshModelPlan,
  DshProtocol,
  DshRetryPolicy,
} from '../../../shared/dshModelPlan/types.ts';

export type Message = Record<string, unknown>;

export function isRecord(value: unknown): value is Message {
  return typeof value === 'object' && value !== null;
}

// ---- the model plan and the keys, as Main hands them over -------------------

/** The route and model every probe used before P1-5, kept so recorded samples do not move. */
export const FAKE_ROUTE = 'aiclient-gateway';
export const FAKE_MODEL = 'fake-1';

/**
 * P1-6b: the posture a driver that is not about approvals opens its bridge
 * sessions with (`worker.bootstrap`'s `permissions`). Every bridge session has
 * a real permission gate now; `bypass` answers every question it would ask, so
 * a tool call never waits on a card, while its denies (bundled secrets, plan
 * mode) still hold. Drivers that exercise the cards leave it out.
 */
export const BYPASS_PERMISSIONS = Object.freeze({ mode: 'agent', gear: 'bypass' } as const);

/** A probe gets its answer at once: no retry, unlike the product's 3 (decision 040). */
export const NO_RETRY: DshRetryPolicy = {
  mode: 'normal',
  maxRetries: 0,
  backoff: { initialDelayMs: 1_000, maxDelayMs: 1_000 },
};

export interface FakeRoute {
  /** Our provider id, which is also the route name. */
  provider: string;
  baseUrl: string;
  api?: DshProtocol;
  models: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    input?: Array<'text' | 'image'>;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  }>;
}

/**
 * A model plan built by the product's own rules. By default one route,
 * `aiclient-gateway`, with the non-reasoning `fake-1` (200000 / 8192), on
 * `baseUrl`. `retryPolicy` replaces every route's (default: no retry; `null`
 * keeps the product's); any DSH retry policy goes, `always` included.
 */
export function fakeGatewayPlan(options: {
  baseUrl?: string;
  routes?: FakeRoute[];
  retryPolicy?: DshRetryPolicy | Record<string, unknown> | null;
  clientVersion?: string;
}): DshModelPlan {
  const routes: FakeRoute[] = options.routes ?? [
    {
      provider: FAKE_ROUTE,
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:9',
      models: [{ id: FAKE_MODEL, name: 'P0 fake model', contextWindow: 200_000, maxTokens: 8192 }],
    },
  ];
  const providers: Record<string, unknown> = {};
  const keyed: Record<string, boolean> = {};
  for (const route of routes) {
    providers[route.provider] = {
      baseUrl: route.baseUrl,
      api: route.api ?? 'anthropic-messages',
      models: route.models,
    };
    keyed[route.provider] = true;
  }
  const plan = buildDshModelPlan({
    models: { providers },
    keyed,
    ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
  });
  const retryPolicy = options.retryPolicy === undefined ? NO_RETRY : options.retryPolicy;
  if (retryPolicy) {
    for (const route of Object.values(plan.routes)) {
      route.retryPolicy = structuredClone(retryPolicy) as DshRetryPolicy;
    }
  }
  return plan;
}

/** How a credential request was answered, value excluded. */
export interface ServedCredential {
  id: number;
  ref: string;
  outcome: 'served' | 'refused' | 'unavailable';
}

export interface ServedPlan {
  readonly plan: DshModelPlan;
  readonly nonce: string;
  /** Every credential request this host sent, in order. */
  readonly requests: ServedCredential[];
  /** Changes the key behind one reference (a provider id works too); undefined answers `unavailable`. */
  setKey(refOrProvider: string, value: string | undefined): void;
  stop(): void;
}

/**
 * Plays Main for one host: `configure` right away (the host buffers it until
 * it is ready to compose), then one answer per `credential` request, checking
 * the nonce and the reference the way `DshCredentialBroker` does.
 */
export function serveModelPlan(
  child: ChildProcess,
  plan: DshModelPlan,
  keys: Readonly<Record<string, string>> | string
): ServedPlan {
  const nonce = randomBytes(18).toString('base64url');
  const values = new Map<string, string | undefined>();
  for (const [ref, provider] of Object.entries(plan.refs)) {
    values.set(ref, typeof keys === 'string' ? keys : (keys[ref] ?? keys[provider]));
  }
  const requests: ServedCredential[] = [];
  const onMessage = (message: unknown) => {
    if (!isRecord(message) || message.host !== 'credential' || typeof message.id !== 'number') {
      return;
    }
    const ref = String(message.ref);
    const value = values.get(ref);
    const refused = message.nonce !== nonce || !Object.hasOwn(plan.refs, ref);
    const outcome = refused ? 'refused' : value ? 'served' : 'unavailable';
    requests.push({ id: message.id, ref, outcome });
    if (!child.connected) return;
    child.send(
      outcome === 'served'
        ? { host: 'credential-result', id: message.id, ok: true, value }
        : { host: 'credential-result', id: message.id, ok: false, error: outcome }
    );
  };
  child.on('message', onMessage);
  child.send({
    host: 'configure',
    nonce,
    revision: plan.revision,
    routes: plan.routes,
    defaultModel: plan.defaultModel,
    index: plan.index,
    refs: plan.refs,
  });
  return {
    plan,
    nonce,
    requests,
    setKey(refOrProvider, value) {
      for (const [ref, provider] of Object.entries(plan.refs)) {
        if (ref === refOrProvider || provider === refOrProvider) values.set(ref, value);
      }
    },
    stop() {
      child.off('message', onMessage);
    },
  };
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

  /** Plays Main's model source for this host (see `serveModelPlan`). */
  configure(plan: DshModelPlan, keys: Readonly<Record<string, string>> | string): ServedPlan {
    return serveModelPlan(this.child, plan, keys);
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

  /**
   * Decision 030's read-only page (`{host:'readPage'}`), answered with the
   * host's `page` message as it came (ok or not), plus the round trip.
   */
  async readPage(
    payload: { stubFile: string; logicalSessionId: string; offset?: number; limit?: number },
    timeoutMs = 60_000
  ): Promise<Message & { roundTripMs: number }> {
    const id = 1_000_000 + ++this.requestSeq;
    const started = performance.now();
    this.child.send({ host: 'readPage', id, ...payload });
    const reply = await this.control(
      (message) => message.host === 'page' && message.id === id,
      timeoutMs
    );
    if (!reply) throw new Error(`readPage ${id} timed out`);
    return { ...reply, roundTripMs: Math.round((performance.now() - started) * 10) / 10 };
  }

  /**
   * Decision 054's migration (`{host:'seedSession'}`, P1-9c), answered with
   * the host's `seeded` message as it came (ok or not), plus the round trip.
   */
  async seedSession(
    payload: {
      sourceFile: string;
      logicalSessionId: string;
      cwd: string;
      expect?: { bytes: number; mtimeMs: number };
    },
    timeoutMs = 120_000
  ): Promise<Message & { roundTripMs: number }> {
    const id = 2_000_000 + ++this.requestSeq;
    const started = performance.now();
    this.child.send({ host: 'seedSession', id, kind: 'pi-file', ...payload });
    const reply = await this.control(
      (message) => message.host === 'seeded' && message.id === id,
      timeoutMs
    );
    if (!reply) throw new Error(`seedSession ${id} timed out`);
    return { ...reply, roundTripMs: Math.round((performance.now() - started) * 10) / 10 };
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
