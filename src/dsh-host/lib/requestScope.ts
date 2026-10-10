/**
 * Decision 173 (GitHub issue #9): which session a model request is made for,
 * carried from DSH's `llm/stream` waterfall down to the host's `fetch`.
 *
 * DSH stamps every agent-loop request with its session id
 * (`GenerateOptions.sessionId`) and marks a compaction or session-title
 * request (`purpose`), but none of it reaches the HTTP request pi-ai's
 * Anthropic SDK makes. `installRequestScope` adds an `llm/stream` listener
 * that runs the rest of the chain, and every step of the stream it returns,
 * inside an AsyncLocalStorage store; the request tap (`requestTap.ts`) reads
 * the store when the SDK calls `fetch`.
 *
 * The adapter (`dsh-llm-pi-ai`) starts the request inside the stream's first
 * `next()`, after awaiting its key, and pi-ai sends it from an async task
 * started there. Both keep the store: an `await` resumes in the context it was
 * entered in, whoever settles the promise. A DSH upgrade that handed the
 * request to a queue running in another context would lose it; the tap then
 * warns once and sends such requests as they are (decision 173 §6 risk 1).
 *
 * The scope also keeps the tap's latest finding on each session's agent-loop
 * requests (`evidenceFor`), which host.ts offers to the rows as the
 * `aiclientRequestScope` service.
 *
 * Loaded by Node type stripping in a source checkout: erasable syntax only.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ClientPrefixEvidence,
  RequestScopeStore,
  RequestScopeView,
} from '../../shared/types/requestScope.ts';

/** Sessions whose latest evidence is kept; the least recently recorded go first. */
export const EVIDENCE_SESSIONS_KEPT = 256;

export class RequestScope implements RequestScopeView {
  private readonly storage = new AsyncLocalStorage<RequestScopeStore>();
  private readonly evidence = new Map<string, ClientPrefixEvidence>();
  private readonly maxSessions: number;

  constructor(options: { maxSessions?: number } = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? EVIDENCE_SESSIONS_KEPT);
  }

  /** The store of the model request the caller works for; undefined outside every one. */
  current(): RequestScopeStore | undefined {
    return this.storage.getStore();
  }

  /** Runs `fn` with `store` current, for it and everything it starts. */
  run<R>(store: RequestScopeStore, fn: () => R): R {
    return this.storage.run(store, fn);
  }

  recordEvidence(dshSessionId: string, evidence: ClientPrefixEvidence): void {
    this.evidence.delete(dshSessionId);
    this.evidence.set(dshSessionId, evidence);
    for (const oldest of this.evidence.keys()) {
      if (this.evidence.size <= this.maxSessions) break;
      this.evidence.delete(oldest);
    }
  }

  evidenceFor(dshSessionId: string): ClientPrefixEvidence | undefined {
    return this.evidence.get(dshSessionId);
  }
}

/**
 * The store of a model request, from its `GenerateOptions`: a session's
 * request is an agent-loop step unless DSH marks it a compaction or a session
 * title; one without a session is one-shot (the bridge's completions). A
 * purpose this file does not know is treated as one-shot, so that it can
 * neither take a session's metadata nor count as one of its agent steps.
 */
export function storeOf(options: unknown): RequestScopeStore {
  const { sessionId, purpose } = (options ?? {}) as { sessionId?: unknown; purpose?: unknown };
  if (typeof sessionId !== 'string' || sessionId === '') return { purpose: 'oneshot' };
  if (purpose === undefined) return { sessionId, purpose: 'agent' };
  if (purpose === 'compaction' || purpose === 'session-title') return { sessionId, purpose };
  return { purpose: 'oneshot' };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * `source`, iterated inside `store`: its iterator is made, and each of its
 * `next`, `return` and `throw` calls runs, with `store` current, so whatever
 * they start keeps it. `return` and `throw` exist when the source's iterator
 * has them, and every result and error is the source's own.
 */
export function scopedStream<T>(
  scope: RequestScope,
  store: RequestScopeStore,
  source: AsyncIterable<T>
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = scope.run(store, () => source[Symbol.asyncIterator]());
      const scoped: AsyncIterableIterator<T> = {
        next: (...args) => scope.run(store, () => iterator.next(...args)),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      const close = iterator.return;
      if (typeof close === 'function') {
        scoped.return = (...args) => scope.run(store, () => close.apply(iterator, args));
      }
      const fail = iterator.throw;
      if (typeof fail === 'function') {
        scoped.throw = (...args) => scope.run(store, () => fail.apply(iterator, args));
      }
      return scoped;
    },
  };
}

/** The `llm/stream` listener's shape (dsh-llm's `Events`), as far as it is used here. */
export type LlmStreamListener = (
  options: unknown,
  next: () => AsyncIterable<unknown>
) => AsyncIterable<unknown>;

/**
 * The slice of the host's Cordis context `installRequestScope` uses. Its
 * listener takes `any` where dsh-llm has `GenerateOptions` and `StreamChunk`,
 * so that the context, typed with them, can be passed as it is, while DSH's
 * types stay out of lib/.
 */
export interface RequestScopeHostContext {
  on(
    name: 'llm/stream',
    listener: (options: any, next: () => AsyncIterable<any>) => AsyncIterable<any>,
    options?: { global?: boolean; prepend?: boolean }
  ): unknown;
}

/**
 * Registers the `llm/stream` listener that runs each model request's chain in
 * its store (`storeOf`). Prepended and global, so that it wraps every listener
 * registered before it (host.ts installs it before any row loads) and sees
 * every LLM service; a DSH listener prepended later still runs outside it,
 * which is harmless as long as none of them starts the request. Options it
 * cannot read leave the chain as it is.
 */
export function installRequestScope(ctx: RequestScopeHostContext, scope: RequestScope): void {
  ctx.on(
    'llm/stream',
    (options, next) => {
      let store: RequestScopeStore;
      try {
        store = storeOf(options);
      } catch {
        return next();
      }
      const stream = scope.run(store, next);
      return isAsyncIterable(stream) ? scopedStream(scope, store, stream) : stream;
    },
    { global: true, prepend: true }
  );
}
