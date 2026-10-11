/**
 * Decision 173 (GitHub issue #9): the request tap, a wrapper around the
 * process's `fetch` that sees each anthropic-messages request a DSH session
 * makes on its way out.
 *
 *   D   A body without `metadata` gets a stable `metadata.user_id` appended
 *       (sessionMetadata.ts), every byte of its own left as it was, so that
 *       the company gateway keeps the chat in one gateway session and the
 *       upstream on one prompt cache. A `metadata` already there is never
 *       touched.
 *   B1  Once the request is handed on, its prefix is compared with the
 *       previous request of the same session and purpose (requestPrefix.ts).
 *       One that does not merely extend it is logged in one line
 *       (`prefix-watch: ...`, no hash, no content), and the verdict on each
 *       agent-loop request is kept for the bridge (`RequestScope`).
 *   U   Decision 182 (DA-3): every user message whose content is a string
 *       goes out as the one text block it stands for (userContentBlocks.ts),
 *       on every anthropic-messages request, in a session or not, so that a
 *       message keeps one form from step to step. Only then are D and B1
 *       applied: B1 compares what is sent.
 *
 * The session is the request scope's (requestScope.ts). A request outside
 * every scope and a one-shot one get U alone; every other `fetch` (an MCP
 * server's, a plugin's, another API's) goes through with its very own
 * arguments. Whatever goes wrong, the request goes as it came, and each kind
 * of failure is warned about once, never with the body's text or an error's
 * message (a JSON parse error quotes its input).
 *
 * On the request's path: one `JSON.parse` of the body, one `JSON.stringify`
 * of it when U rewrites a message, and, for the first request that needs it,
 * DSH's anonymous install id (`deviceId`). The hashing runs after the request
 * is handed on (`schedule`). U writes the body anew with `JSON.stringify`,
 * which is how the Anthropic SDK wrote it: every byte but the rewritten
 * contents comes out as it went in.
 *
 * Its switches (src/shared/types/requestScope.ts) are read once, at install:
 * AICLIENT_RUNTIME_SESSION_METADATA=0 turns D off,
 * AICLIENT_RUNTIME_PREFIX_WATCH=0 turns B1 off,
 * AICLIENT_RUNTIME_USER_CONTENT_BLOCKS=0 turns U off; with all three off,
 * `fetch` is not wrapped at all. host.ts installs it right after the
 * User-Agent relay, so it wraps the relay: the body is settled here, the
 * headers there.
 *
 * Loaded by Node type stripping in a source checkout: erasable syntax only.
 */

import {
  type ClientPrefixVerdict,
  isSwitchedOff,
  PREFIX_WATCH_ENV,
  type RequestPurpose,
  SESSION_METADATA_ENV,
  USER_CONTENT_BLOCKS_ENV,
} from '../../shared/types/requestScope.ts';
import {
  comparePrefix,
  type PrefixUnits,
  prefixUnitsOf,
  verdictLogFields,
} from './requestPrefix.ts';
import type { RequestScope } from './requestScope.ts';
import {
  appendMetadataUserId,
  claudeMetadataUserId,
  gatewaySessionUuid,
  isAnthropicMessagesRequest,
} from './sessionMetadata.ts';
import { withUserContentBlocks } from './userContentBlocks.ts';

type Fetch = typeof globalThis.fetch;
type FetchInput = Parameters<Fetch>[0];
type FetchInit = Parameters<Fetch>[1];
/** A request `isAnthropicMessagesRequest` took: an init with a string body. */
type MessagesInit = RequestInit & { body: string };

const MB = 1024 * 1024;

export interface RequestTapLimits {
  /** A body longer than this (in UTF-16 units, about bytes) is not parsed: it goes as it is. */
  maxParsedBody: number;
  /** A body longer than this is not hashed: its chain starts over. */
  maxWatchedBody: number;
  /** Chains (a session and a purpose) remembered; the least recently used go first. */
  chainsKept: number;
  /** A chain unused for longer than this is forgotten. */
  chainIdleMs: number;
}

export const REQUEST_TAP_LIMITS: Readonly<RequestTapLimits> = {
  maxParsedBody: 64 * MB,
  maxWatchedBody: 16 * MB,
  chainsKept: 64,
  chainIdleMs: 2 * 60 * 60 * 1000,
};

export interface RequestTapDeps {
  scope: RequestScope;
  /** Read once, for the switches. */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * The `device_id` (`deviceIdFrom` of DSH's anonymous install id), asked for
   * once, by the first request that needs it; undefined, or a failure, leaves
   * every request without metadata.
   */
  deviceId: () => Promise<string | undefined>;
  /** One diagnostic line: a divergence. */
  log: (line: string) => void;
  /** A warning, said once per `key`. */
  warnOnce: (key: string, line: string) => void;
  /** Runs `fn` off the request's path; `setImmediate` by default. */
  schedule?: (fn: () => void) => void;
  /** The clock, `Date.now` by default. */
  now?: () => number;
  /** `REQUEST_TAP_LIMITS` by default. */
  limits?: Partial<RequestTapLimits>;
}

export interface RequestTapStatus {
  /** False with every part off, or when there is no `fetch`, or it is tapped already. */
  installed: boolean;
  sessionMetadata: boolean;
  prefixWatch: boolean;
  /** Decision 182: user messages go out as text blocks. */
  userContentBlocks: boolean;
}

/** Which parts of the tap are on. */
type TapParts = Omit<RequestTapStatus, 'installed'>;

/** What B1 hashes of a request; undefined when there is nothing to compare. */
type Sample = { body: unknown; betas: string | null } | undefined;

interface Chain {
  /** The previous request's units; undefined after one that could not be hashed. */
  units?: PrefixUnits;
  /** Requests seen on the chain, this one included. */
  seq: number;
  lastAt: number;
}

/** Whether D applies to a body: a Messages request (a model, messages) with no `metadata` at all. */
function lacksMetadata(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return (
    typeof record.model === 'string' &&
    Array.isArray(record.messages) &&
    !Object.hasOwn(record, 'metadata')
  );
}

/** A session id fit for a log line: DSH's are short and plain; anything else shows as `?`. */
function logSessionId(id: string): string {
  return /^[\w.:-]{1,128}$/.test(id) ? id : '?';
}

/** A size for a warning: in MB when whole, else in UTF-16 units. */
function sizeText(units: number): string {
  return units % MB === 0 ? `${units / MB} MB` : `${units} characters`;
}

/** A failure's class, never its message: a parse error quotes its input. */
function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^\w{1,64}$/.test(name) ? name : 'Error';
}

class RequestTap {
  private readonly deps: RequestTapDeps;
  private readonly sessionMetadata: boolean;
  private readonly prefixWatch: boolean;
  private readonly userContentBlocks: boolean;
  private readonly schedule: (fn: () => void) => void;
  private readonly now: () => number;
  private readonly limits: Readonly<RequestTapLimits>;
  /** `<session>\0<purpose>` -> chain, least recently used first. */
  private readonly chains = new Map<string, Chain>();
  private deviceId: string | undefined;
  private deviceFailed = false;
  private devicePending: Promise<void> | undefined;

  constructor(deps: RequestTapDeps, parts: TapParts) {
    this.deps = deps;
    this.sessionMetadata = parts.sessionMetadata;
    this.prefixWatch = parts.prefixWatch;
    this.userContentBlocks = parts.userContentBlocks;
    this.schedule = deps.schedule ?? ((fn) => void setImmediate(fn));
    this.now = deps.now ?? Date.now;
    this.limits = { ...REQUEST_TAP_LIMITS, ...deps.limits };
  }

  /**
   * The init to send: the caller's own, or a copy with its user messages as
   * blocks and the metadata (once the device id is known, for the first
   * requests). Never throws, never rejects.
   */
  prepare(input: FetchInput, init: FetchInit): FetchInit | Promise<FetchInit> {
    try {
      return this.tap(input, init);
    } catch (error) {
      this.warn('tap', `request tap: failed (${errorName(error)}); the request went as it came`);
      return init;
    }
  }

  private tap(input: FetchInput, init: FetchInit): FetchInit | Promise<FetchInit> {
    if (!isAnthropicMessagesRequest(input, init)) return init;
    const store = this.deps.scope.current();
    if (store === undefined) {
      this.warn(
        'no-scope',
        'request tap: a model request ran outside every request scope; it went without session metadata or prefix watch'
      );
    }
    // A session's own request: D and B1 apply. Any other gets U alone.
    const session =
      store?.sessionId !== undefined && store.purpose !== 'oneshot'
        ? { sessionId: store.sessionId, purpose: store.purpose }
        : undefined;
    if (session === undefined && !this.userContentBlocks) return init;
    const request = init as MessagesInit;
    const raw = request.body;
    if (raw.length > this.limits.maxParsedBody) {
      this.warn(
        'parse-size',
        `request tap: a model request body over ${sizeText(this.limits.maxParsedBody)} went as it is, without session metadata or prefix watch`
      );
      if (session) this.watch(session.sessionId, session.purpose, undefined);
      return init;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.warn('parse', 'request tap: a model request body is not JSON; it went as it is');
      if (session) this.watch(session.sessionId, session.purpose, undefined);
      return init;
    }
    const headers = new Headers(request.headers);
    const blocks = this.userContentBlocks ? withUserContentBlocks(parsed) : undefined;
    const wantsMetadata =
      session !== undefined && this.sessionMetadata && lacksMetadata(blocks ?? parsed);
    // A body of another length would contradict the caller's own Content-Length.
    const rewrite = (blocks !== undefined || wantsMetadata) && !headers.has('content-length');
    if (!rewrite && (blocks !== undefined || wantsMetadata)) {
      this.warn(
        'content-length',
        'request tap: a model request with a Content-Length header of its own went as it is, without session metadata or user content blocks'
      );
    }
    // What goes out: B1 compares it, D appends to it.
    const body = rewrite ? (blocks ?? parsed) : parsed;
    const sent: MessagesInit =
      rewrite && blocks !== undefined ? { ...request, body: JSON.stringify(blocks) } : request;
    if (session === undefined) return sent;
    const { sessionId, purpose } = session;
    if (sent.body.length > this.limits.maxWatchedBody && this.prefixWatch) {
      this.warn(
        'watch-size',
        `request tap: the prefix watch skips model request bodies over ${sizeText(this.limits.maxWatchedBody)}`
      );
      this.watch(sessionId, purpose, undefined);
    } else {
      this.watch(sessionId, purpose, { body, betas: headers.get('anthropic-beta') });
    }

    if (!rewrite || !wantsMetadata) return sent;
    if (this.deviceId !== undefined) return this.withMetadata(sent, sessionId, this.deviceId);
    if (this.deviceFailed) return sent;
    return this.resolveDevice().then(() => {
      try {
        return this.deviceId === undefined
          ? sent
          : this.withMetadata(sent, sessionId, this.deviceId);
      } catch (error) {
        this.warn('tap', `request tap: failed (${errorName(error)}); the request went as it came`);
        return init;
      }
    });
  }

  private withMetadata(request: MessagesInit, sessionId: string, deviceId: string): FetchInit {
    const userId = claudeMetadataUserId(deviceId, gatewaySessionUuid(sessionId));
    const body = appendMetadataUserId(request.body, userId);
    if (body === undefined) {
      this.warn(
        'append',
        'request tap: session metadata could not be added to a model request body; it went as it is'
      );
      return request;
    }
    return { ...request, body };
  }

  /** Asks for the device id once; settles when it is known or known to be missing. */
  private resolveDevice(): Promise<void> {
    this.devicePending ??= (async () => {
      let id: unknown;
      try {
        id = await this.deps.deviceId();
      } catch {
        id = undefined;
      }
      if (typeof id === 'string' && id !== '') {
        this.deviceId = id;
        return;
      }
      this.deviceFailed = true;
      this.warn(
        'device-id',
        'request tap: no anonymous install id could be read or made; model requests go without session metadata'
      );
    })();
    return this.devicePending;
  }

  /** Compares the request with its chain's previous one, after it is handed on. */
  private watch(sessionId: string, purpose: RequestPurpose, sample: Sample): void {
    if (!this.prefixWatch) return;
    try {
      const at = this.now();
      this.schedule(() => {
        try {
          this.compare(sessionId, purpose, sample, at);
        } catch (error) {
          this.warn(
            'prefix-watch',
            `request tap: the prefix watch failed (${errorName(error)}); requests are not affected`
          );
        }
      });
    } catch (error) {
      this.warn(
        'prefix-watch',
        `request tap: the prefix watch failed (${errorName(error)}); requests are not affected`
      );
    }
  }

  private compare(sessionId: string, purpose: RequestPurpose, sample: Sample, at: number): void {
    const key = `${sessionId}\u0000${purpose}`;
    // Least recently used first: the idle ones lead.
    for (const [other, { lastAt }] of this.chains) {
      if (at - lastAt <= this.limits.chainIdleMs) break;
      this.chains.delete(other);
    }
    let chain = this.chains.get(key);
    this.chains.delete(key);
    if (chain === undefined || at - chain.lastAt > this.limits.chainIdleMs) {
      chain = { seq: 0, lastAt: at };
    }
    this.chains.set(key, chain);
    for (const oldest of this.chains.keys()) {
      if (this.chains.size <= this.limits.chainsKept) break;
      this.chains.delete(oldest);
    }
    chain.seq += 1;
    chain.lastAt = at;

    const units = sample === undefined ? undefined : prefixUnitsOf(sample.body, sample.betas);
    if (units === undefined) {
      chain.units = undefined;
      return;
    }
    const verdict = comparePrefix(chain.units, units);
    chain.units = units;
    if (purpose === 'agent') this.record(sessionId, verdict, chain.seq, at);
    if (verdict.kind === 'diverged') {
      this.deps.log(
        `prefix-watch: session=${logSessionId(sessionId)} purpose=${purpose} req=${chain.seq} ${verdictLogFields(verdict)}`
      );
    }
  }

  private record(
    sessionId: string,
    verdict: ClientPrefixVerdict,
    requestSeq: number,
    at: number
  ): void {
    if (verdict.kind === 'same') {
      // A retry sends the request again: what was found on the request it repeats stands.
      const earlier = this.deps.scope.evidenceFor(sessionId);
      if (earlier !== undefined && earlier.verdict.kind !== 'same') return;
    }
    this.deps.scope.recordEvidence(sessionId, { verdict, requestSeq, at });
  }

  private warn(key: string, line: string): void {
    try {
      this.deps.warnOnce(key, line);
    } catch {
      // A warning must not cost the request.
    }
  }
}

/** Marks a tapped `fetch`, so a second install cannot wrap it twice. */
const TAP_MARK = Symbol.for('aiclient.dsh.requestTap');

/** Wraps `target.fetch` with the request tap, unless every part is switched off. */
export function installRequestTap(
  target: { fetch: Fetch } = globalThis,
  deps: RequestTapDeps
): RequestTapStatus {
  const parts: TapParts = {
    sessionMetadata: !isSwitchedOff(deps.env, SESSION_METADATA_ENV),
    prefixWatch: !isSwitchedOff(deps.env, PREFIX_WATCH_ENV),
    userContentBlocks: !isSwitchedOff(deps.env, USER_CONTENT_BLOCKS_ENV),
  };
  const anyOn = parts.sessionMetadata || parts.prefixWatch || parts.userContentBlocks;
  const original = target.fetch;
  if (!anyOn || typeof original !== 'function' || TAP_MARK in original) {
    return { installed: false, ...parts };
  }
  const tap = new RequestTap(deps, parts);
  const tapped = ((input: FetchInput, init?: FetchInit) => {
    const next = tap.prepare(input, init);
    return next instanceof Promise
      ? next.then((ready) => original(input, ready))
      : original(input, next);
  }) as Fetch;
  Object.defineProperty(tapped, TAP_MARK, { value: true });
  target.fetch = tapped;
  return { installed: true, ...parts };
}

/**
 * The line host.ts logs at start: `request tap: session metadata on, prefix
 * watch on, user content blocks on`, each part `on` or `off` by its switch.
 */
export function describeRequestTap(status: RequestTapStatus): string {
  const state = (on: boolean) => (on ? 'on' : 'off');
  if (
    !status.installed &&
    (status.sessionMetadata || status.prefixWatch || status.userContentBlocks)
  ) {
    return 'request tap: not installed (no fetch to wrap, or it is wrapped already)';
  }
  return `request tap: session metadata ${state(status.sessionMetadata)}, prefix watch ${state(status.prefixWatch)}, user content blocks ${state(status.userContentBlocks)}`;
}
