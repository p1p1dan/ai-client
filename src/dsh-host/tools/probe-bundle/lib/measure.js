/**
 * aiclient-probe-measure — P0-6 measurements of the test-only bundle
 * `@aiclient/dsh-probe`. They lived in the P0-6 prototype of the shared-host
 * bridge; P1-3a made that prototype the product bridge and moved them here, so
 * no probe code ships (dsh-rebase decision 015). Drivers address them beside the bridge's
 * channel envelopes on the same IPC channel:
 *
 *   parent -> host  { p06, requestId, ... }       one operation (below)
 *   host -> parent  { p06Reply, requestId, ... }  its answer, or `error`
 *
 *   eld-start { resolutionMs }  start a monitorEventLoopDelay histogram and the
 *                               host-side stream latency capture
 *   eld-stop                    stop both; answer the histogram, the latency
 *                               samples and the CPU time used meanwhile
 *   mem { gc }                  process.memoryUsage + V8 heap stats (+ /proc)
 *   read-session { sessionId, prefix?, find? }
 *                               read the stored log (read access, no lock) and
 *                               summarize it
 *   live                        live agents and their status (the bridge's
 *                               channels are in its pong)
 *   observe { sessionId }       P1-4e: the whole log exactly as the bridge's
 *                               history cache reads it (`sessionQuery.
 *                               observeSession`: live snapshot or cold read,
 *                               never a lock or a write)
 *   seed { sessionId, cwd, events }
 *                               P1-4a: a new session admitted with `events` as
 *                               its seed (`agents.create`, the path P1-9's
 *                               migration takes), flushed, then released, so
 *                               it is on disk and closed
 *   observe-stat { sessionId }  P1-4a: time one `observeSession` (no projection
 *                               state) and answer its size, not its events
 *
 * Stream latency: the P0-6 fake gateway stamps every text delta with its send
 * time (`‹t<µs of CLOCK_MONOTONIC>›`); this row reads the stamp at the same
 * `agent/assistant-stream` event the bridge translates, so the sample is
 * "gateway wrote the SSE frame -> host received the chunk".
 * @module @aiclient/dsh-probe/measure
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';
import v8 from 'node:v8';

/** Stable Cordis plugin name. */
export const name = 'aiclient-probe-measure';

/** `live` lists the agent registry. */
export const inject = ['agents'];

const STAMP = /‹t(\d+)›/g;

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function procStatusKb(field) {
  try {
    const match = readFileSync('/proc/self/status', 'utf8').match(
      new RegExp(`^${field}:\\s+(\\d+)`, 'm')
    );
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function digest(events) {
  const hash = createHash('sha256');
  for (const event of events)
    hash.update(`${JSON.stringify([event.seq, event.type, event.data])}\n`);
  return hash.digest('hex').slice(0, 16);
}

/** Compact, JSON-safe summary of one stored session log. */
function summarize(events, options) {
  const types = {};
  const messages = { userHuman: 0, userOther: 0, assistant: 0, toolResult: 0 };
  const turnEnds = [];
  const toolErrors = [];
  for (const event of events) {
    types[event.type] = (types[event.type] ?? 0) + 1;
    const data = event.data ?? {};
    if (event.type === 'user/message') {
      if (data.source?.kind === 'user') messages.userHuman += 1;
      else messages.userOther += 1;
    } else if (event.type === 'assistant/message') {
      messages.assistant += 1;
    } else if (event.type === 'tool/result') {
      messages.toolResult += 1;
      if (data.error || data.message?.isError) {
        toolErrors.push({
          seq: event.seq,
          code: data.error?.code ?? null,
          text: textOf(data.message?.content).slice(0, 160),
        });
      }
    } else if (event.type === 'turn/end') {
      turnEnds.push({ seq: event.seq, turn: data.turn, reason: data.reason?.kind ?? null });
    }
  }
  const find = {};
  for (const needle of options.find ?? []) {
    find[needle] = events
      .filter((event) => JSON.stringify(event.data ?? null).includes(needle))
      .map((event) => ({
        seq: event.seq,
        type: event.type,
        interrupted: event.data?.interrupted === true ? true : undefined,
      }));
  }
  return {
    count: events.length,
    lastSeq: events.at(-1)?.seq ?? null,
    digest: digest(events),
    ...(Number.isInteger(options.prefix)
      ? { prefixDigest: digest(events.slice(0, options.prefix)) }
      : {}),
    types,
    messages: {
      ...messages,
      total: messages.userHuman + messages.userOther + messages.assistant + messages.toolResult,
    },
    turnEnds: turnEnds.slice(-8),
    toolErrors: toolErrors.slice(-8),
    find,
    tail: events.slice(-12).map((event) => ({
      seq: event.seq,
      type: event.type,
      ...(event.type === 'turn/end' ? { reason: event.data?.reason?.kind } : {}),
      ...(event.type === 'assistant/message'
        ? {
            text: textOf(event.data?.message?.content).slice(0, 80),
            interrupted: event.data?.interrupted === true ? true : undefined,
          }
        : {}),
      ...(event.type === 'tool/result'
        ? {
            isError: event.data?.message?.isError === true,
            code: event.data?.error?.code,
          }
        : {}),
    })),
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (typeof process.send !== 'function') {
    ctx.logger('aiclient-probe-measure').warn('no IPC channel; measurements are inert');
    return;
  }
  const send = (message) => {
    if (process.connected) process.send(message);
  };

  const capture = {
    on: false,
    samples: [],
    histogram: null,
    cpu: null,
    started: 0,
    resolution: 10,
    gc: [],
    gcObserver: null,
  };
  ctx.on('agent/assistant-stream', ({ frame }) => {
    if (!capture.on || frame?.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return;
    const now = process.hrtime.bigint() / 1000n;
    for (const match of String(frame.chunk.text).matchAll(STAMP)) {
      capture.samples.push(Number(now - BigInt(match[1])) / 1000);
    }
  });

  const ops = {
    'eld-start'(message) {
      capture.histogram?.disable();
      capture.resolution = message.resolutionMs ?? 10;
      capture.histogram = monitorEventLoopDelay({ resolution: capture.resolution });
      capture.histogram.enable();
      capture.samples = [];
      capture.on = true;
      capture.cpu = process.cpuUsage();
      capture.gc = [];
      capture.gcObserver?.disconnect();
      capture.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) capture.gc.push(entry.duration);
      });
      capture.gcObserver.observe({ entryTypes: ['gc'] });
      capture.started = performance.now();
      return { hostNowMs: capture.started };
    },
    'eld-stop'() {
      const histogram = capture.histogram;
      histogram?.disable();
      capture.on = false;
      const ms = (ns) => Math.round((ns / 1e6) * 1000) / 1000;
      const cpu = process.cpuUsage(capture.cpu ?? undefined);
      capture.gcObserver?.disconnect();
      capture.gcObserver = null;
      const gc = capture.gc;
      const answer = {
        hostNowMs: performance.now(),
        resolutionMs: capture.resolution,
        wallMs: Math.round(performance.now() - capture.started),
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        eld: histogram
          ? {
              count: histogram.count,
              min: ms(histogram.min),
              mean: ms(histogram.mean),
              p50: ms(histogram.percentile(50)),
              p90: ms(histogram.percentile(90)),
              p99: ms(histogram.percentile(99)),
              max: ms(histogram.max),
            }
          : null,
        gc: {
          count: gc.length,
          totalMs: Math.round(gc.reduce((a, b) => a + b, 0) * 10) / 10,
          maxMs: Math.round(Math.max(0, ...gc) * 10) / 10,
        },
        hostLatencyMs: capture.samples.map((value) => Math.round(value * 100) / 100),
      };
      capture.histogram = null;
      capture.samples = [];
      return answer;
    },
    mem(message) {
      if (message.gc && typeof globalThis.gc === 'function') {
        globalThis.gc();
        globalThis.gc();
      }
      const heap = v8.getHeapStatistics();
      return {
        gcRan: Boolean(message.gc && typeof globalThis.gc === 'function'),
        memoryUsage: process.memoryUsage(),
        heap: {
          usedHeapSize: heap.used_heap_size,
          totalHeapSize: heap.total_heap_size,
          externalMemory: heap.external_memory,
          mallocedMemory: heap.malloced_memory,
        },
        vmRssKb: procStatusKb('VmRSS'),
        vmHwmKb: procStatusKb('VmHWM'),
      };
    },
    async 'read-session'(message) {
      const persistence = ctx.get('sessionPersistence');
      if (persistence === undefined) throw new Error('no sessionPersistence service');
      const started = performance.now();
      const snapshot = await persistence.stat(message.sessionId);
      const handle = await persistence.open(message.sessionId, 'read');
      try {
        const { events } = await handle.read(0);
        return {
          readMs: Math.round(performance.now() - started),
          sizeBytes: snapshot?.sizeBytes ?? null,
          ...summarize(events, message),
        };
      } finally {
        await handle.close();
      }
    },
    live() {
      return {
        agents: ctx.agents.list().map((agent) => ({
          id: agent.id,
          status: typeof agent.status === 'object' ? agent.status?.kind : agent.status,
        })),
      };
    },
    async observe(message) {
      const query = ctx.get('sessionQuery');
      if (query === undefined) throw new Error('no sessionQuery service');
      const observation = await query.observeSession(message.sessionId, { projectionMode: 'none' });
      try {
        return {
          source: observation.source,
          header: observation.header,
          inheritedEventCount: observation.inheritedEventCount,
          cursor: observation.cursor,
          // Copied out before the lease is released below.
          events: [...observation.events],
        };
      } finally {
        observation[Symbol.dispose]?.();
      }
    },
    async seed(message) {
      const sessions = ctx.get('sessions');
      if (sessions === undefined) throw new Error('no sessions service');
      const started = performance.now();
      const handle = await ctx.agents.create({
        sessionId: message.sessionId,
        seed: message.events,
        meta: { cwd: message.cwd },
      });
      try {
        await sessions.flush(handle.agent.session);
      } finally {
        await handle.dispose();
      }
      return { ms: Math.round(performance.now() - started) };
    },
    async 'observe-stat'(message) {
      const query = ctx.get('sessionQuery');
      if (query === undefined) throw new Error('no sessionQuery service');
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const observation = await query.observeSession(message.sessionId, { projectionMode: 'none' });
      const ms = Math.round((performance.now() - started) * 10) / 10;
      try {
        return {
          ms,
          source: observation.source,
          cursor: observation.cursor,
          events: observation.events.length,
          heapGrowthBytes: process.memoryUsage().heapUsed - heapBefore,
        };
      } finally {
        observation[Symbol.dispose]?.();
      }
    },
  };

  const onMessage = (message) => {
    if (message === null || typeof message !== 'object' || typeof message.p06 !== 'string') return;
    const op = ops[message.p06];
    if (op === undefined) {
      send({ p06Reply: message.p06, requestId: message.requestId, error: 'unknown op' });
      return;
    }
    Promise.resolve()
      .then(() => op(message))
      .then(
        (answer) => send({ p06Reply: message.p06, requestId: message.requestId, ...answer }),
        (error) =>
          send({
            p06Reply: message.p06,
            requestId: message.requestId,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          })
      );
  };

  ctx.effect(() => {
    process.on('message', onMessage);
    return () => {
      process.off('message', onMessage);
      capture.histogram?.disable();
      capture.gcObserver?.disconnect();
    };
  }, 'aiclient-probe-measure.ipc');
}
