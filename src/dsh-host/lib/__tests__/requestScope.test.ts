import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientPrefixEvidence,
  RequestScopeStore,
} from '../../../shared/types/requestScope.ts';
import {
  EVIDENCE_SESSIONS_KEPT,
  installRequestScope,
  type LlmStreamListener,
  RequestScope,
  type RequestScopeHostContext,
  scopedStream,
  storeOf,
} from '../requestScope.ts';

/**
 * Decision 173 (GitHub issue #9): the request scope carries a model request's
 * session from DSH's `llm/stream` waterfall down to the `fetch` pi-ai's
 * Anthropic SDK makes. The waterfall is Cordis' (listeners in a list,
 * `prepend` unshifting, the first one outermost). The listeners stand in for
 * DSH's checkpoint policy (it builds the rest of the chain inside its first
 * step), the loop guard (it wraps the chain's iterator) and DSH's invariants
 * (prepended once their rows load, so outside ours). The adapter stands in
 * for dsh-llm-pi-ai: it awaits its key, which an emitter fired by a timer
 * made outside every scope answers (the credential relay's IPC answer), then
 * starts pi-ai's request task, which fetches, and yields what that task
 * pushes.
 *
 * Run twice: as is, and with `NODE_OPTIONS=--experimental-async-context-frame`
 * for the AsyncLocalStorage the packaged host's Node 24 uses by default.
 */

interface Options {
  sessionId?: string;
  purpose?: string;
}
interface Chunk {
  text: string;
}
type Seen = RequestScopeStore | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Settled outside every scope, before any stream: DSH's session flush, in miniature. */
const flushed = Promise.resolve();

/** The credential relay in miniature: a question waits for the answer the IPC link brings. */
function credentialLink(scope: RequestScope) {
  const link = new EventEmitter();
  const waiting = new Map<number, (key: string) => void>();
  const answeredIn: Seen[] = [];
  let ids = 0;
  link.on('answer', (id: number) => {
    answeredIn.push(scope.current());
    waiting.get(id)?.(`key-${id}`);
    waiting.delete(id);
  });
  return {
    answeredIn,
    ask: () => new Promise<string>((resolve) => waiting.set(++ids, resolve)),
    /** Answers every open question, the latest first. */
    answerAll() {
      for (const id of [...waiting.keys()].reverse()) link.emit('answer', id);
    },
  };
}

/** A push queue the way pi-ai's event stream is one: the request task pushes, the adapter pulls. */
function eventQueue<T>() {
  const items: T[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  return {
    push(item: T) {
      items.push(item);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      while (true) {
        if (items.length > 0) {
          yield items.shift() as T;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

function harness(layout: { outer?: boolean } = {}) {
  const scope = new RequestScope();
  const credentials = credentialLink(scope);
  const fetches: Array<{ url: string; store: Seen }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetches.push({ url, store: scope.current() });
      return new Response(`reply to ${new URL(url).searchParams.get('for')}`);
    })
  );
  const seen = {
    adapter: [] as Seen[],
    finals: [] as Array<{ tag: string; store: Seen }>,
    checkpoint: [] as Seen[],
    guard: [] as Seen[],
    outer: [] as Seen[],
  };

  /** dsh-llm-pi-ai's stream: its key first, then pi-ai's request task. */
  async function* adapter(options: Options): AsyncGenerator<Chunk> {
    const tag = options.sessionId ?? 'oneshot';
    const consumer = new AbortController();
    try {
      await Promise.resolve(); // prepareCall
      seen.adapter.push(scope.current());
      const key = await credentials.ask();
      const events = eventQueue<Chunk>();
      // pi-ai's `stream()`: a task started here and never awaited.
      void (async () => {
        try {
          await sleep(1);
          // Two attempts, the second after a delay, as pi-ai's retryProviderRequest makes them.
          for (const attempt of [1, 2]) {
            if (consumer.signal.aborted) return;
            const response = await globalThis.fetch(
              `https://gw.example.test/v1/messages?beta=true&for=${tag}&attempt=${attempt}`
            );
            events.push({ text: `${await response.text()} with ${key}` });
            await sleep(1);
          }
        } finally {
          events.end();
        }
      })();
      for await (const event of events) yield event;
    } finally {
      // Closing the stream aborts the request task, as dsh-llm-pi-ai does.
      consumer.abort();
      seen.finals.push({ tag, store: scope.current() });
    }
  }

  const hooks: LlmStreamListener[] = [];
  const ctx: RequestScopeHostContext = {
    on: (name, listener, options) => {
      expect(name).toBe('llm/stream');
      if (options?.prepend) hooks.unshift(listener);
      else hooks.push(listener);
      return () => true;
    },
  };

  /** The loop guard's `guardReplyStream`, without the guarding. */
  async function* guard(source: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    const iterator = source[Symbol.asyncIterator]();
    let settled = false;
    try {
      while (true) {
        const item = await iterator.next();
        if (item.done) {
          settled = true;
          return;
        }
        yield item.value;
      }
    } finally {
      if (!settled) await iterator.return?.();
    }
  }

  installRequestScope(ctx, scope);
  // The checkpoint policy: the rest of the chain is built in its first step.
  ctx.on('llm/stream', (_options, next) => {
    seen.checkpoint.push(scope.current());
    return (async function* () {
      await flushed;
      yield* next();
    })();
  });
  ctx.on('llm/stream', (_options, next) => {
    seen.guard.push(scope.current());
    return guard(next());
  });
  if (layout.outer) {
    ctx.on(
      'llm/stream',
      (_options, next) => {
        seen.outer.push(scope.current());
        const inner = next();
        return (async function* () {
          for await (const chunk of inner) yield chunk;
        })();
      },
      { prepend: true }
    );
  }

  /** dsh-llm's `stream()`: Cordis' waterfall over the listeners, the adapter innermost. */
  const stream = (options: Options): AsyncIterable<Chunk> => {
    const callbacks = [...hooks];
    const inner: LlmStreamListener = () => adapter(options);
    const next = (): AsyncIterable<unknown> => (callbacks.shift() ?? inner)(options, next);
    return next() as AsyncIterable<Chunk>;
  };

  // Made outside every scope: what it fires is too.
  const timer = setInterval(() => credentials.answerAll(), 2);
  return { scope, stream, fetches, seen, credentials, stop: () => clearInterval(timer) };
}

async function drain(stream: AsyncIterable<Chunk>): Promise<string[]> {
  const texts: string[] = [];
  for await (const chunk of stream) texts.push(chunk.text);
  return texts;
}

const agent = (sessionId: string): RequestScopeStore => ({ sessionId, purpose: 'agent' });

describe('installRequestScope', () => {
  it('gives each of two sessions streamed at once its own store, down to the fetch pi-ai makes', async () => {
    const h = harness({ outer: true });
    try {
      const [a, b] = await Promise.all([
        drain(h.stream({ sessionId: 'aiclient-a' })),
        drain(h.stream({ sessionId: 'aiclient-b' })),
      ]);
      expect(a).toEqual(['reply to aiclient-a with key-1', 'reply to aiclient-a with key-1']);
      expect(b).toEqual(['reply to aiclient-b with key-2', 'reply to aiclient-b with key-2']);
      expect(h.fetches).toHaveLength(4);
      for (const { url, store } of h.fetches) {
        expect(store, url).toEqual(agent(String(new URL(url).searchParams.get('for'))));
      }
      // Both keys were answered from outside every scope.
      expect(h.credentials.answeredIn).toEqual([undefined, undefined]);
      expect(h.seen.adapter).toEqual([agent('aiclient-a'), agent('aiclient-b')]);
      // The listeners inside ours ran in the store; the one prepended later did not.
      expect(h.seen.checkpoint).toEqual(h.seen.adapter);
      expect(h.seen.guard).toEqual(h.seen.adapter);
      expect(h.seen.outer).toEqual([undefined, undefined]);
      // b's key came first, so b may finish first: the order is not the point.
      expect([...h.seen.finals].sort((x, y) => x.tag.localeCompare(y.tag))).toEqual([
        { tag: 'aiclient-a', store: agent('aiclient-a') },
        { tag: 'aiclient-b', store: agent('aiclient-b') },
      ]);
    } finally {
      h.stop();
    }
  });

  it('marks compaction and session-title requests, and makes a request without a session one-shot', async () => {
    const h = harness();
    try {
      await Promise.all([
        drain(h.stream({ sessionId: 'aiclient-c', purpose: 'compaction' })),
        drain(h.stream({ sessionId: 'aiclient-t', purpose: 'session-title' })),
        drain(h.stream({})),
      ]);
      const stores = new Map(
        h.fetches.map(({ url, store }) => [new URL(url).searchParams.get('for'), store])
      );
      expect(Object.fromEntries(stores)).toEqual({
        'aiclient-c': { sessionId: 'aiclient-c', purpose: 'compaction' },
        'aiclient-t': { sessionId: 'aiclient-t', purpose: 'session-title' },
        oneshot: { purpose: 'oneshot' },
      });
      expect(h.fetches).toHaveLength(6);
    } finally {
      h.stop();
    }
  });

  it('leaves a fetch outside every stream, and the caller of a stream, without a store', async () => {
    const h = harness();
    try {
      const streaming = drain(h.stream({ sessionId: 'aiclient-a' }));
      expect(h.scope.current()).toBeUndefined();
      await globalThis.fetch('https://gw.example.test/v1/messages?for=outside');
      await streaming;
      await globalThis.fetch('https://gw.example.test/v1/messages?for=after');
      expect(h.fetches.filter(({ store }) => store === undefined).map(({ url }) => url)).toEqual([
        'https://gw.example.test/v1/messages?for=outside',
        'https://gw.example.test/v1/messages?for=after',
      ]);
      expect(h.fetches.filter(({ store }) => store !== undefined)).toHaveLength(2);
      expect(h.scope.current()).toBeUndefined();
    } finally {
      h.stop();
    }
  });

  it("forwards return(): the chain closes and the adapter's finally runs, in its store", async () => {
    const h = harness({ outer: true });
    try {
      for await (const chunk of h.stream({ sessionId: 'aiclient-r' })) {
        expect(chunk.text).toBe('reply to aiclient-r with key-1');
        break;
      }
      expect(h.seen.finals).toEqual([{ tag: 'aiclient-r', store: agent('aiclient-r') }]);
    } finally {
      h.stop();
    }
  });

  it('forwards throw(), and its error comes back', async () => {
    const h = harness();
    try {
      const iterator = h.stream({ sessionId: 'aiclient-x' })[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ text: 'reply to aiclient-x with key-1' });
      const boom = new Error('boom');
      expect(iterator.throw).toBeTypeOf('function');
      await expect(iterator.throw?.(boom)).rejects.toBe(boom);
      expect(h.seen.finals).toEqual([{ tag: 'aiclient-x', store: agent('aiclient-x') }]);
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    } finally {
      h.stop();
    }
  });

  it('builds the rest of the chain at once and once, in the store', async () => {
    const h = harness();
    try {
      const iterator = h.stream({ sessionId: 'aiclient-e' })[Symbol.asyncIterator]();
      // The listener inside ours ran before anything was iterated; the guard
      // is built in the checkpoint's first step.
      expect(h.seen.checkpoint).toEqual([agent('aiclient-e')]);
      expect(h.seen.guard).toEqual([]);
      await iterator.next();
      expect(h.seen.checkpoint).toEqual([agent('aiclient-e')]);
      expect(h.seen.guard).toEqual([agent('aiclient-e')]);
      await iterator.return?.();
      expect(h.seen.finals).toEqual([{ tag: 'aiclient-e', store: agent('aiclient-e') }]);
    } finally {
      h.stop();
    }
  });

  it('hands back what next() returns when the options cannot be read, or it is no stream', () => {
    const scope = new RequestScope();
    let listener: LlmStreamListener | undefined;
    installRequestScope(
      {
        on: (_name, registered) => {
          listener = registered;
        },
      },
      scope
    );
    const stream = (async function* () {})();
    const unreadable = new Proxy(
      {},
      {
        get() {
          throw new Error('unreadable');
        },
      }
    );
    expect(listener?.(unreadable, () => stream)).toBe(stream);
    const notAStream = Promise.resolve() as unknown as AsyncIterable<unknown>;
    expect(listener?.({ sessionId: 'aiclient-a' }, () => notAStream)).toBe(notAStream);
  });

  it('registers prepended and global: outside every listener registered before it', () => {
    const scope = new RequestScope();
    const registered: unknown[] = [];
    installRequestScope({ on: (_name, _listener, options) => registered.push(options) }, scope);
    expect(registered).toEqual([{ global: true, prepend: true }]);
  });

  it('passes errors of the chain on, thrown or rejected', async () => {
    const scope = new RequestScope();
    let listener: LlmStreamListener | undefined;
    installRequestScope(
      {
        on: (_name, registered) => {
          listener = registered;
        },
      },
      scope
    );
    const thrown = new Error('built wrong');
    expect(() =>
      listener?.({ sessionId: 'aiclient-a' }, () => {
        throw thrown;
      })
    ).toThrow(thrown);
    const failed = new Error('stream failed');
    const stream = listener?.({ sessionId: 'aiclient-a' }, () =>
      (async function* () {
        yield 1;
        throw failed;
      })()
    );
    const iterator = stream?.[Symbol.asyncIterator]();
    expect(await iterator?.next()).toEqual({ done: false, value: 1 });
    await expect(iterator?.next()).rejects.toBe(failed);
  });
});

describe('scopedStream', () => {
  const store = agent('aiclient-s');

  it('makes the iterator in the store, and has no return or throw the source lacks', async () => {
    const scope = new RequestScope();
    const madeIn: Seen[] = [];
    const calls: string[] = [];
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        madeIn.push(scope.current());
        let left = 2;
        return {
          next: async (...args: unknown[]) => {
            calls.push(`next(${args.length}) in ${scope.current()?.sessionId}`);
            return left-- > 0
              ? { done: false as const, value: left }
              : { done: true as const, value: undefined };
          },
        };
      },
    };
    const iterator = scopedStream(scope, store, source)[Symbol.asyncIterator]();
    expect(madeIn).toEqual([store]);
    expect('return' in iterator).toBe(false);
    expect('throw' in iterator).toBe(false);
    expect(await iterator.next()).toEqual({ done: false, value: 1 });
    expect(await iterator.next('sent')).toEqual({ done: false, value: 0 });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(calls).toEqual([
      'next(0) in aiclient-s',
      'next(1) in aiclient-s',
      'next(0) in aiclient-s',
    ]);
    expect(scope.current()).toBeUndefined();
  });

  it("calls the source's own return and throw, with their arguments, in the store", async () => {
    const scope = new RequestScope();
    const calls: Array<[string, unknown, Seen]> = [];
    const iteratorOfSource = {
      next: async () => ({ done: false as const, value: 0 }),
      return: async (value?: unknown) => {
        calls.push(['return', value, scope.current()]);
        return { done: true as const, value };
      },
      throw: async (error?: unknown) => {
        calls.push(['throw', error, scope.current()]);
        throw error;
      },
    };
    const iterator = scopedStream(scope, store, {
      [Symbol.asyncIterator]: () => iteratorOfSource,
    })[Symbol.asyncIterator]();
    expect(await iterator.return?.('done')).toEqual({ done: true, value: 'done' });
    const boom = new Error('boom');
    await expect(iterator.throw?.(boom)).rejects.toBe(boom);
    expect(calls).toEqual([
      ['return', 'done', store],
      ['throw', boom, store],
    ]);
  });
});

describe('storeOf', () => {
  it.each([
    ['an agent-loop request', { sessionId: 'aiclient-a' }, agent('aiclient-a')],
    [
      'a compaction',
      { sessionId: 'aiclient-a', purpose: 'compaction' },
      { sessionId: 'aiclient-a', purpose: 'compaction' },
    ],
    [
      'a session title',
      { sessionId: 'aiclient-a', purpose: 'session-title' },
      { sessionId: 'aiclient-a', purpose: 'session-title' },
    ],
    ['a request without a session', { purpose: 'compaction' }, { purpose: 'oneshot' }],
    ['an empty session id', { sessionId: '' }, { purpose: 'oneshot' }],
    ['a session id that is no string', { sessionId: 7 }, { purpose: 'oneshot' }],
    [
      'a purpose DSH may add later',
      { sessionId: 'aiclient-a', purpose: 'summary' },
      { purpose: 'oneshot' },
    ],
    ['no options', undefined, { purpose: 'oneshot' }],
  ])('reads %s', (_what, options, store) => {
    expect(storeOf(options)).toEqual(store);
  });
});

describe('RequestScope evidence', () => {
  const evidence = (requestSeq: number): ClientPrefixEvidence => ({
    verdict: { kind: 'append', added: 2 },
    requestSeq,
    at: 1_760_000_000_000,
  });

  it('keeps the latest evidence per session', () => {
    const scope = new RequestScope();
    expect(scope.evidenceFor('aiclient-a')).toBeUndefined();
    scope.recordEvidence('aiclient-a', evidence(1));
    scope.recordEvidence('aiclient-a', evidence(2));
    expect(scope.evidenceFor('aiclient-a')).toEqual(evidence(2));
  });

  it(`keeps ${EVIDENCE_SESSIONS_KEPT} sessions, the least recently recorded dropped first`, () => {
    const scope = new RequestScope();
    for (let n = 0; n < EVIDENCE_SESSIONS_KEPT; n += 1) scope.recordEvidence(`s${n}`, evidence(n));
    // Recorded again: now the most recent.
    scope.recordEvidence('s0', evidence(1000));
    scope.recordEvidence('s-new', evidence(1));
    expect(scope.evidenceFor('s0')).toEqual(evidence(1000));
    expect(scope.evidenceFor('s1')).toBeUndefined();
    expect(scope.evidenceFor('s2')).toEqual(evidence(2));
    expect(scope.evidenceFor('s-new')).toEqual(evidence(1));
  });
});

describe('the AsyncLocalStorage under test', () => {
  it('is the frame-based one when NODE_OPTIONS asks for it', () => {
    // The async_hooks implementation has `_propagate`; the frame-based one
    // (the default from Node 24, which the packaged host runs) has not.
    const frames = !('_propagate' in AsyncLocalStorage.prototype);
    const asked = process.env.NODE_OPTIONS?.includes('--experimental-async-context-frame') ?? false;
    if (asked) expect(frames).toBe(true);
    console.info(`AsyncLocalStorage under test: ${frames ? 'frame-based' : 'async_hooks'}`);
  });
});
